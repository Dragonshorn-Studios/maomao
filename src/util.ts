export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function shortSha(sha: string, length = 7): string {
  return sha.slice(0, length);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function parseInteger(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Positive GitHub REST numeric IDs from a comma/whitespace list. Invalid tokens fail fast. */
export function parseIdList(value: string | undefined, source = "GitHub ID list"): number[] {
  if (!value?.trim()) return [];
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const token of value.split(/[\s,]+/)) {
    if (!token) continue;
    if (!/^\d+$/.test(token)) {
      invalid.push(token);
      continue;
    }
    const n = Number.parseInt(token, 10);
    if (Number.isSafeInteger(n) && n > 0) ids.push(n);
    else invalid.push(token);
  }
  if (invalid.length > 0) {
    throw new Error(
      `${source} contains non-numeric GitHub IDs (${invalid.join(", ")}). Use REST numeric IDs such as 123456, not owner/repo names or GraphQL node IDs.`,
    );
  }
  if (ids.length === 0) {
    throw new Error(`${source} is set but contains no positive GitHub REST numeric IDs.`);
  }
  return [...new Set(ids)];
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function elapsedMs(startedAt: string | null | undefined, finishedAt?: string | null): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

export function redactSecrets(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function replaceEscapedNewlines(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function truncate(value: string, max = 400_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[truncated ${value.length - max} bytes]`;
}
