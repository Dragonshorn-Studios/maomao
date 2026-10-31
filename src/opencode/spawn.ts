import { spawn } from "node:child_process";
import { realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** Linux caps a single argv element at 128KiB (MAX_ARG_STRLEN — bytes, not
 * chars); prompts that inline member diffs (the stack cumulative pass) can
 * exceed that and the spawn dies with E2BIG before opencode starts. Past
 * this size (UTF-8 bytes) the prompt rides on stdin instead — `opencode run`
 * with no positional message reads the prompt from piped stdin and emits the
 * same JSON events. */
export const OPENCODE_PROMPT_STDIN_THRESHOLD = 100_000;

/** One in-flight config pin per workspace: parallel reviewer runs in the same
 * job workspace share a single write (and wait for it) instead of racing. The
 * entry is evicted once the pin settles — checkout wipes and recreates the
 * same deterministic workspace path on retries, so the pin must re-run. */
const configPinByDir = new Map<string, Promise<void>>();

/** OpenCode 2 compatibility (verified against v2.1.4): `--dir` is gone (the
 * spawn cwd is the project), the permission env channel
 * (OPENCODE_PERMISSION / OPENCODE_CONFIG_CONTENT) is dropped in favor of
 * config files, and `run` talks to a shared background service unless
 * `--standalone` forces a private per-process server — which Maomao wants so
 * parallel review jobs never share state. JSON events, `--file`, `--title`,
 * `--model`, and stdin prompts are unchanged. Detected once per binary. */
const majorByBin = new Map<string, Promise<1 | 2>>();

export function detectOpenCodeMajor(bin: string): Promise<1 | 2> {
  let pending = majorByBin.get(bin);
  if (pending) return pending;
  pending = new Promise<1 | 2>((resolve) => {
    // `--version` prints "1.18.31" on v1 and "opencode v2.1.4" on v2. The
    // version token must be anchored: an unanchored "2." also matches v1
    // minors like 1.2.x / 1.22.x.
    const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const giveUp = (reason: string) => {
      // Transient failures (spawn error, stall) must not pin the fallback
      // forever: evict so the next run re-probes, and say why once.
      majorByBin.delete(bin);
      console.warn(`opencode: --version probe of ${bin} failed (${reason}); assuming v1 invocation`);
      resolve(1);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      giveUp("timed out");
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      giveUp(error.message);
    });
    child.on("close", () => {
      clearTimeout(timer);
      // A real answer is definitive for this process lifetime, even when it
      // doesn't parse — a binary that runs but doesn't speak --version is
      // not going to change its mind.
      const match = /(?:^|\s)v?(\d+)\.\d+/.exec(out.trim());
      if (!match) {
        console.warn(`opencode: unparseable --version output from ${bin}: ${out.trim().slice(0, 80) || "(empty)"}; assuming v1 invocation`);
      }
      resolve(match && Number(match[1]) >= 2 ? 2 : 1);
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
  const viaStdin = Buffer.byteLength(input.prompt, "utf8") >= OPENCODE_PROMPT_STDIN_THRESHOLD;
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

/**
 * Directories `external_directory` must keep readable (issue #176): the job
 * workspace holds `pr.diff`/`pr.json`/reconcile context next to the repo
 * checkout, and `--file` attachments resolve there. The realpath variants
 * cover symlinked workspace roots (e.g. /tmp → /private/tmp on macOS), where
 * OpenCode's normalized check path would not match the lexical one.
 */
async function externalReadAllowDirs(cwd: string): Promise<string[]> {
  const dirs = new Set<string>([dirname(cwd)]);
  try {
    dirs.add(await realpath(dirname(cwd)));
  } catch {
    // Lexical parent still applies.
  }
  try {
    dirs.add(dirname(await realpath(cwd)));
  } catch {
    // Lexical parent still applies.
  }
  return [...dirs];
}

/**
 * Strip repo-supplied OpenCode config from the workspace and pin Maomao's
 * deny-list in its place. Verified against opencode v2.1.4: a repo-shipped
 * `.opencode/opencode.json` or `opencode.jsonc` takes precedence over a
 * root `opencode.json`, so a hostile PR could ship an allow-all config and
 * escape the deny-list — the workspace is Maomao-owned, so both variants
 * are removed before the pin is written.
 */
async function pinV2Permissions(cwd: string, externalAllow: string[]): Promise<void> {
  await rm(join(cwd, ".opencode"), { recursive: true, force: true });
  await rm(join(cwd, "opencode.jsonc"), { force: true });
  await writeFile(join(cwd, "opencode.json"), JSON.stringify(reviewerPermissionsV2Config({ externalAllow }), null, 2));
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
      const externalAllow = await externalReadAllowDirs(input.cwd);
      const permissionConfig = reviewerPermissionConfig({ externalAllow });
      const extras: Record<string, string> = v2
        ? { TERM: "dumb" }
        : {
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
            OPENCODE_DISABLE_CLAUDE_CODE: "true",
            OPENCODE_DISABLE_AUTOUPDATE: "true",
            OPENCODE_CONFIG_CONTENT: JSON.stringify(permissionConfig),
            OPENCODE_PERMISSION: JSON.stringify(permissionConfig.permission),
            TERM: "dumb",
          };
      if (v2) {
        let pin = configPinByDir.get(input.cwd);
        if (!pin) {
          // The catch fails open (operators pin known-good binaries, but the
          // miss must be visible) and the finally evicts, so the next run in
          // this workspace re-pins after a checkout wipe or a failed write.
          pin = pinV2Permissions(input.cwd, externalAllow)
            .catch((error) => {
              console.warn(`opencode: could not pin v2 permissions in ${input.cwd}: ${String(error)}`);
            })
            .finally(() => {
              configPinByDir.delete(input.cwd);
            });
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
        // EPIPE here is benign and expected whenever the child dies before
        // draining the piped prompt (arg-parse exit, timeout/abort SIGKILL):
        // without a listener it is an uncaught exception that kills Maomao,
        // and the child's own close/error event already reports the outcome.
        child.stdin?.on("error", () => {});
        const viaStdin = Buffer.byteLength(input.prompt, "utf8") >= OPENCODE_PROMPT_STDIN_THRESHOLD;
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
