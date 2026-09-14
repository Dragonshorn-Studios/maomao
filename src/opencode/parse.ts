export interface OpenCodeUsage {
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
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

function maybeUsage(value: unknown): OpenCodeUsage {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const tokens = (record.tokens as Record<string, unknown> | undefined) ?? record;
  const usage: OpenCodeUsage = {};
  const prompt =
    num(tokens.input) ??
    num(tokens.prompt) ??
    num(record.input_tokens) ??
    num(record.prompt_tokens);
  const completion =
    num(tokens.output) ??
    num(tokens.completion) ??
    num(record.output_tokens) ??
    num(record.completion_tokens);
  const cost = num(record.cost) ?? num(record.costUSD) ?? num(tokens.cost);
  if (prompt != null) usage.promptTokens = prompt;
  if (completion != null) usage.completionTokens = completion;
  if (cost != null) usage.cost = cost;
  return usage;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseOpenCodeOutput(stdout: string): { text: string; usage: OpenCodeUsage } {
  const texts: string[] = [];
  let usage: OpenCodeUsage = {};
  const lines = stdout.split(/\r?\n/);
  let jsonEvents = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      jsonEvents += 1;
      if (event.type === "text") {
        const part = event.part as { text?: string } | undefined;
        if (part?.text) texts.push(part.text);
      }
      if (event.type === "step_finish" || event.type === "tool_use") {
        usage = { ...usage, ...maybeUsage(event.part), ...maybeUsage(event) };
      }
      if (typeof event.text === "string") texts.push(event.text);
    } catch {
      // not an event line
    }
  }
  if (jsonEvents === 0) {
    return { text: stdout.trim(), usage };
  }
  return { text: texts.join("\n").trim() || stdout.trim(), usage };
}
