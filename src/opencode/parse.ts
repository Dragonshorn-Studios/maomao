export interface OpenCodeUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  /** False when the stream is truncated or usage was missing. Omit on test mocks. */
  complete?: boolean;
  warning?: string;
  steps?: number;
}

export interface OpenCodeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  text: string;
  usage: OpenCodeUsage;
}

export interface OpenCodeRunInput {
  cwd: string;
  model: string;
  prompt: string;
  files?: string[];
  timeoutMs: number;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  bin?: string;
  title?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface OpenCodePort {
  run(input: OpenCodeRunInput): Promise<OpenCodeRunResult>;
}

export interface OpenCodeUsageRow {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
  usage_complete: number | null;
  usage_warning: string | null;
}

const INCOMPLETE_STREAM = "Usage incomplete: stream ended without a matching step_finish";
const MISSING_USAGE = "Usage incomplete: OpenCode did not report token or cost data";
const MISSING_FINISH = "Usage incomplete: no step_finish events were emitted";

interface StepUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  reportedTotal?: number;
  cost?: number;
}

export function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function cacheTokens(tokens: Record<string, unknown>): { read: number; write: number } {
  const nested = asRecord(tokens.cache);
  const read =
    num(nested?.read) ?? num(tokens.cache_read) ?? num(tokens.cacheRead) ?? num(tokens["cache.read"]) ?? 0;
  const write =
    num(nested?.write) ?? num(tokens.cache_write) ?? num(tokens.cacheWrite) ?? num(tokens["cache.write"]) ?? 0;
  return { read, write };
}

export function extractStepTokens(value: unknown): StepUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const tokens = asRecord(record.tokens) ?? (looksLikeTokenBag(record) ? record : undefined);
  if (!tokens && num(record.cost) == null && num(record.costUSD) == null) return undefined;
  const bag = tokens ?? {};
  const input = num(bag.input) ?? num(bag.prompt) ?? num(record.input_tokens) ?? num(record.prompt_tokens) ?? 0;
  const output =
    num(bag.output) ?? num(bag.completion) ?? num(record.output_tokens) ?? num(record.completion_tokens) ?? 0;
  const reasoning = num(bag.reasoning) ?? num(record.reasoning_tokens) ?? 0;
  const cache = cacheTokens(bag);
  const reportedTotal = num(bag.total) ?? num(record.total_tokens);
  const cost = num(record.cost) ?? num(record.costUSD) ?? num(bag.cost);
  const hasAny =
    input > 0 ||
    output > 0 ||
    reasoning > 0 ||
    cache.read > 0 ||
    cache.write > 0 ||
    reportedTotal != null ||
    cost != null;
  if (!hasAny) return undefined;
  return {
    input,
    output,
    reasoning,
    cacheRead: cache.read,
    cacheWrite: cache.write,
    reportedTotal,
    cost,
  };
}

function looksLikeTokenBag(record: Record<string, unknown>): boolean {
  return (
    num(record.input) != null ||
    num(record.output) != null ||
    num(record.prompt) != null ||
    num(record.completion) != null ||
    num(record.total) != null ||
    asRecord(record.cache) != null
  );
}

/**
 * Prefer provider `tokens.total` when present. Otherwise choose the convention
 * whose parts match billed input:
 * - cache reported separately from input → input + output + reasoning + cache
 * - cache already included in input → input + output + reasoning
 */
export function reconcileStepTotal(step: StepUsage): number {
  const separate = step.input + step.output + step.reasoning + step.cacheRead + step.cacheWrite;
  const included = step.input + step.output + step.reasoning;
  if (step.reportedTotal != null) {
    return step.reportedTotal;
  }
  if (step.cacheRead > 0 && step.input >= step.cacheRead) {
    return included;
  }
  return separate;
}

function addSteps(into: StepUsage, extra: StepUsage): StepUsage {
  return {
    input: into.input + extra.input,
    output: into.output + extra.output,
    reasoning: into.reasoning + extra.reasoning,
    cacheRead: into.cacheRead + extra.cacheRead,
    cacheWrite: into.cacheWrite + extra.cacheWrite,
    reportedTotal: reconcileStepTotal(into) + reconcileStepTotal(extra),
    cost: into.cost != null || extra.cost != null ? (into.cost ?? 0) + (extra.cost ?? 0) : undefined,
  };
}

function stepFromUnknown(value: unknown, depth = 0): StepUsage | undefined {
  const direct = extractStepTokens(value);
  if (depth >= 4 || !value || typeof value !== "object") return direct;
  const record = value as Record<string, unknown>;
  let step = direct;
  for (const key of ["part", "usage", "tokens", "info", "data", "message"]) {
    if (record[key] && typeof record[key] === "object") {
      const nested = stepFromUnknown(record[key], depth + 1);
      if (!nested) continue;
      step = step ? mergeStepPreferNested(step, nested) : nested;
    }
  }
  return step;
}

function mergeStepPreferNested(base: StepUsage, extra: StepUsage): StepUsage {
  return {
    input: extra.input || base.input,
    output: extra.output || base.output,
    reasoning: extra.reasoning || base.reasoning,
    cacheRead: extra.cacheRead || base.cacheRead,
    cacheWrite: extra.cacheWrite || base.cacheWrite,
    reportedTotal: extra.reportedTotal ?? base.reportedTotal,
    cost: extra.cost ?? base.cost,
  };
}

function eventKind(event: Record<string, unknown>): "start" | "finish" | "text" | "other" {
  const type = String(event.type ?? "");
  const partType = String(asRecord(event.part)?.type ?? "");
  if (type === "step_start" || type === "step-start" || partType === "step-start") return "start";
  if (type === "step_finish" || type === "step-finish" || partType === "step-finish") return "finish";
  if (type === "text") return "text";
  return "other";
}

function finishKey(event: Record<string, unknown>, index: number, step: StepUsage): string {
  const part = asRecord(event.part);
  const partId = part && typeof part.id === "string" ? part.id : typeof event.id === "string" ? event.id : "";
  if (partId) return `part:${partId}`;
  const messageId =
    (part && typeof part.messageID === "string" && part.messageID) ||
    (typeof event.messageID === "string" && event.messageID) ||
    "";
  if (messageId) {
    return `msg:${messageId}:${String(part?.reason ?? "")}:${step.input}:${step.output}:${step.cost ?? ""}`;
  }
  return `line:${index}:${step.input}:${step.output}:${step.reasoning}:${step.cacheRead}:${step.cacheWrite}:${step.cost ?? ""}`;
}

function usageFromStep(step: StepUsage, extra: Pick<OpenCodeUsage, "complete" | "warning" | "steps">): OpenCodeUsage {
  const total = reconcileStepTotal(step);
  const usage: OpenCodeUsage = {
    promptTokens: step.input,
    completionTokens: step.output,
    reasoningTokens: step.reasoning,
    cacheReadTokens: step.cacheRead,
    cacheWriteTokens: step.cacheWrite,
    totalTokens: total,
    complete: extra.complete,
    steps: extra.steps,
    warning: extra.warning,
  };
  if (step.cost != null) usage.cost = step.cost;
  return usage;
}

function hasTokenOrCost(usage: OpenCodeUsage): boolean {
  return (
    usage.totalTokens != null ||
    usage.promptTokens != null ||
    usage.completionTokens != null ||
    usage.reasoningTokens != null ||
    usage.cacheReadTokens != null ||
    usage.cacheWriteTokens != null ||
    usage.cost != null
  );
}

export function parseOpenCodeOutput(stdout: string): { text: string; usage: OpenCodeUsage } {
  const texts: string[] = [];
  const finishes = new Map<string, StepUsage>();
  let startCount = 0;
  let jsonEvents = 0;
  let fallback: StepUsage | undefined;
  const lines = stdout.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    jsonEvents += 1;
    const kind = eventKind(event);
    if (kind === "text") {
      const part = asRecord(event.part);
      if (typeof part?.text === "string") texts.push(part.text);
    }
    if (typeof event.text === "string") texts.push(event.text);

    if (kind === "start") {
      startCount += 1;
      continue;
    }

    const step = stepFromUnknown(event);
    if (!step) continue;

    if (kind === "finish") {
      const key = finishKey(event, index, step);
      if (!finishes.has(key)) finishes.set(key, step);
      continue;
    }

    fallback = fallback ? mergeStepPreferNested(fallback, step) : step;
  }

  if (jsonEvents === 0) {
    return { text: stdout.trim(), usage: { complete: false, steps: 0, warning: MISSING_USAGE } };
  }

  if (finishes.size > 0) {
    let combined: StepUsage | undefined;
    for (const step of finishes.values()) {
      combined = combined ? addSteps(combined, step) : { ...step };
    }
    const unmatchedStarts = startCount > finishes.size;
    const usage = usageFromStep(combined!, {
      complete: !unmatchedStarts,
      warning: unmatchedStarts ? INCOMPLETE_STREAM : undefined,
      steps: finishes.size,
    });
    if (!hasTokenOrCost(usage)) {
      usage.complete = false;
      usage.warning = unmatchedStarts ? INCOMPLETE_STREAM : MISSING_USAGE;
    }
    return { text: texts.join("\n").trim() || stdout.trim(), usage };
  }

  if (fallback) {
    const usage = usageFromStep(fallback, {
      complete: false,
      warning: startCount > 0 ? INCOMPLETE_STREAM : MISSING_FINISH,
      steps: 0,
    });
    if (!hasTokenOrCost(usage)) {
      usage.warning = startCount > 0 ? INCOMPLETE_STREAM : MISSING_USAGE;
    }
    usage.complete = false;
    return { text: texts.join("\n").trim() || stdout.trim(), usage };
  }

  return {
    text: texts.join("\n").trim() || stdout.trim(),
    usage: {
      complete: false,
      steps: 0,
      warning: startCount > 0 ? INCOMPLETE_STREAM : MISSING_USAGE,
    },
  };
}

export function usagePersistence(usage: OpenCodeUsage): OpenCodeUsageRow {
  return {
    prompt_tokens: usage.promptTokens ?? null,
    completion_tokens: usage.completionTokens ?? null,
    reasoning_tokens: usage.reasoningTokens ?? null,
    cache_read_tokens: usage.cacheReadTokens ?? null,
    cache_write_tokens: usage.cacheWriteTokens ?? null,
    total_tokens: usage.totalTokens ?? null,
    cost: usage.cost ?? null,
    usage_complete: usage.complete === false ? 0 : usage.complete === true ? 1 : null,
    usage_warning: usage.warning ?? null,
  };
}

export function aggregatorUsagePersistence(usage: OpenCodeUsage): {
  aggregator_prompt_tokens: number | null;
  aggregator_completion_tokens: number | null;
  aggregator_reasoning_tokens: number | null;
  aggregator_cache_read_tokens: number | null;
  aggregator_cache_write_tokens: number | null;
  aggregator_total_tokens: number | null;
  aggregator_cost: number | null;
  aggregator_usage_complete: number | null;
  aggregator_usage_warning: string | null;
} {
  const row = usagePersistence(usage);
  return {
    aggregator_prompt_tokens: row.prompt_tokens,
    aggregator_completion_tokens: row.completion_tokens,
    aggregator_reasoning_tokens: row.reasoning_tokens,
    aggregator_cache_read_tokens: row.cache_read_tokens,
    aggregator_cache_write_tokens: row.cache_write_tokens,
    aggregator_total_tokens: row.total_tokens,
    aggregator_cost: row.cost,
    aggregator_usage_complete: row.usage_complete,
    aggregator_usage_warning: row.usage_warning,
  };
}

export function tokenTotalFromRow(row: {
  total_tokens?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  reasoning_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
}): number {
  if (row.total_tokens != null && Number.isFinite(row.total_tokens)) return row.total_tokens;
  return (
    (row.prompt_tokens ?? 0) +
    (row.completion_tokens ?? 0) +
    (row.reasoning_tokens ?? 0) +
    (row.cache_read_tokens ?? 0) +
    (row.cache_write_tokens ?? 0)
  );
}
