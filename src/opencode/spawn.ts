import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenCodePort, OpenCodeRunInput, OpenCodeRunResult } from "./parse.js";
import { parseOpenCodeOutput } from "./parse.js";
import { reviewerPermissionConfig, reviewerPermissionsV2Config, sanitizeChildEnv } from "./env.js";
import { providerAuthSecrets } from "./credentials.js";
import { redactSecrets } from "../util.js";

export class OpenCodeTimeoutError extends Error {
  /** Redacted process output captured before the kill — everything a timed-out
   * run leaves to diagnose why it hung, persisted by the pipeline catch paths. */
  readonly stdout: string;
  readonly stderr: string;
  readonly firstOutputMs?: number;
  constructor(timeoutMs: number, partial: { stdout: string; stderr: string; firstOutputMs?: number }) {
    super(`OpenCode timed out after ${timeoutMs}ms`);
    this.name = "OpenCodeTimeoutError";
    this.stdout = partial.stdout;
    this.stderr = partial.stderr;
    this.firstOutputMs = partial.firstOutputMs;
  }
}

/** Linux caps a single argv element at 128KiB (MAX_ARG_STRLEN); prompts that
 * inline member diffs (the stack cumulative pass) can exceed that and the
 * spawn dies with E2BIG before opencode starts. Past this size the prompt
 * rides on stdin instead — `opencode run` with no positional message reads
 * the prompt from piped stdin and emits the same JSON events. */
export const OPENCODE_PROMPT_STDIN_THRESHOLD = 100_000;

/** OpenCode 2 compatibility (verified against v2.1.4): `--dir` and `--pure`
 * are gone (the spawn cwd is the project), the permission env channel
 * (OPENCODE_PERMISSION / OPENCODE_CONFIG_CONTENT) is dropped in favor of
 * config files, and `run` talks to a shared background service unless
 * `--standalone` forces a private per-process server — which Maomao wants so
 * parallel review jobs never share state. JSON events, `--file`, `--title`,
 * `--model`, and stdin prompts are unchanged. Detected once per binary. */
const majorByBin = new Map<string, Promise<1 | 2>>();

/** One config pin per workspace: parallel reviewer runs in the same job
 * workspace share a single write (and wait for it) instead of racing. */
const configPinByDir = new Map<string, Promise<void>>();

export function detectOpenCodeMajor(bin: string): Promise<1 | 2> {
  let pending = majorByBin.get(bin);
  if (pending) return pending;
  pending = new Promise<1 | 2>((resolve) => {
    // `--version` prints "1.18.31" on v1 and "opencode v2.1.4" on v2.
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(1);
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(/v?2\.\d+/.test(out.trim()) ? 2 : 1);
    });
  });
  majorByBin.set(bin, pending);
  return pending;
}

/** `--file` is a yargs array option; without `--` the prompt is eaten as another file path. */
export function buildOpenCodeArgs(input: {
  cwd: string;
  model?: string;
  title?: string;
  files?: string[];
  extraArgs?: string[];
  prompt: string;
  v2?: boolean;
}): string[] {
  const viaStdin = input.prompt.length >= OPENCODE_PROMPT_STDIN_THRESHOLD;
  return [
    "run",
    "--format",
    "json",
    // v2 has no --dir (the spawn cwd is the project) and must opt out of the
    // shared background service; v1 keeps the explicit --dir.
    ...(input.v2 ? ["--standalone"] : ["--dir", input.cwd]),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.title ? ["--title", input.title] : []),
    ...(input.files ?? []).flatMap((file) => ["--file", file]),
    ...(input.extraArgs ?? []),
    ...(viaStdin ? [] : ["--", input.prompt]),
  ];
}

/**
 * Secret-bearing values from the sanitized child env (provider keys etc.).
 * Chat surfaces that echo model output must redact with these in addition to
 * Maomao's own credentials — the runner applies them to stdout/stderr only.
 */
export function opencodeEnvSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.values(env).filter((value): value is string => Boolean(value && value.length > 8));
}

export function createOpenCodeRunner(defaultBin = "opencode"): OpenCodePort {
  return {
    async run(input: OpenCodeRunInput): Promise<OpenCodeRunResult> {
      const bin = input.bin || defaultBin;
      const v2 = (await detectOpenCodeMajor(bin)) === 2;
      const args = buildOpenCodeArgs({ ...input, v2 });

      // v1 reads its whole config from env vars, including the reviewer
      // permission deny-list. v2 ignores that channel entirely, so there the
      // deny-list is pinned as a project opencode.json inside the job
      // workspace (a Maomao-owned temp dir) before the spawn.
      const extras: Record<string, string> = v2
        ? { TERM: "dumb" }
        : {
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
            OPENCODE_DISABLE_CLAUDE_CODE: "true",
            OPENCODE_DISABLE_AUTOUPDATE: "true",
            OPENCODE_CONFIG_CONTENT: JSON.stringify(reviewerPermissionConfig()),
            OPENCODE_PERMISSION: JSON.stringify(reviewerPermissionConfig().permission),
            TERM: "dumb",
          };
      if (v2) {
        let pin = configPinByDir.get(input.cwd);
        if (!pin) {
          pin = writeFile(join(input.cwd, "opencode.json"), JSON.stringify(reviewerPermissionsV2Config(), null, 2)).catch(
            (error) => {
              // Fail-open like the env channel: operators pin known-good
              // binaries, but the miss must at least be visible.
              console.warn(`opencode: could not pin v2 permissions in ${input.cwd}: ${String(error)}`);
            },
          );
          configPinByDir.set(input.cwd, pin);
        }
        await pin;
      }
      const env = sanitizeChildEnv(process.env, { ...extras, ...(input.env ?? {}) });
      const secrets = [...opencodeEnvSecrets(env), ...providerAuthSecrets(env)];

      return new Promise((resolve, reject) => {
        if (input.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        // OpenCode `run` reads stdin whenever it is not a TTY (`Bun.stdin.text()`).
        // `stdio: ignore` is a closed fd, which can abort before any JSON events.
        // A piped stdin closed immediately is a normal EOF and keeps the argv prompt;
        // an oversized prompt (see OPENCODE_PROMPT_STDIN_THRESHOLD) is written to
        // stdin and no argv positional is passed at all.
        const child = spawn(bin, args, {
          cwd: input.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const viaStdin = input.prompt.length >= OPENCODE_PROMPT_STDIN_THRESHOLD;
        child.stdin?.end(viaStdin ? input.prompt : undefined);
        const spawnedAt = Date.now();
        let stdout = "";
        let stderr = "";
        let firstOutputMs: number | undefined;
        child.stdout.on("data", (chunk: Buffer) => {
          firstOutputMs ??= Date.now() - spawnedAt;
          const text = chunk.toString("utf8");
          stdout += text;
          input.onStdout?.(text);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderr += text;
          input.onStderr?.(text);
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          // Carry the captured (redacted) output on the rejection: without it
          // every catch handler sees `result === undefined` and a timeout
          // leaves zero evidence of what opencode was doing before the kill.
          reject(
            new OpenCodeTimeoutError(input.timeoutMs, {
              stdout: redactSecrets(stdout, secrets),
              stderr: redactSecrets(stderr, secrets),
              firstOutputMs,
            }),
          );
        }, input.timeoutMs);
        const onAbort = () => child.kill("SIGKILL");
        input.signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          const parsed = parseOpenCodeOutput(stdout);
          resolve({
            stdout: redactSecrets(stdout, secrets),
            stderr: redactSecrets(stderr, secrets),
            exitCode: code ?? 1,
            text: parsed.text,
            usage: parsed.usage,
            firstOutputMs,
          });
        });
      });
    },
  };
}
