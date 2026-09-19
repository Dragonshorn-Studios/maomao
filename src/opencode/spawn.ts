import { spawn } from "node:child_process";
import type { OpenCodePort, OpenCodeRunInput, OpenCodeRunResult } from "./parse.js";
import { parseOpenCodeOutput } from "./parse.js";
import { reviewerPermissionConfig, sanitizeChildEnv } from "./env.js";
import { redactSecrets } from "../util.js";

export class OpenCodeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`OpenCode timed out after ${timeoutMs}ms`);
    this.name = "OpenCodeTimeoutError";
  }
}

/** `--file` is a yargs array option; without `--` the prompt is eaten as another file path. */
export function buildOpenCodeArgs(input: {
  cwd: string;
  model?: string;
  title?: string;
  files?: string[];
  extraArgs?: string[];
  prompt: string;
}): string[] {
  return [
    "run",
    "--format",
    "json",
    "--dir",
    input.cwd,
    ...(input.model ? ["--model", input.model] : []),
    ...(input.title ? ["--title", input.title] : []),
    ...(input.files ?? []).flatMap((file) => ["--file", file]),
    ...(input.extraArgs ?? []),
    "--",
    input.prompt,
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
      const args = buildOpenCodeArgs(input);

      const extras: Record<string, string> = {
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(reviewerPermissionConfig()),
        OPENCODE_PERMISSION: JSON.stringify(reviewerPermissionConfig().permission),
        TERM: "dumb",
      };
      const env = sanitizeChildEnv(process.env, { ...extras, ...(input.env ?? {}) });
      const secrets = opencodeEnvSecrets(env);

      return new Promise((resolve, reject) => {
        if (input.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        // OpenCode `run` reads stdin whenever it is not a TTY (`Bun.stdin.text()`).
        // `stdio: ignore` is a closed fd, which can abort before any JSON events.
        // A piped stdin closed immediately is a normal EOF and keeps the argv prompt.
        const child = spawn(bin, args, {
          cwd: input.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin?.end();
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
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
          reject(new OpenCodeTimeoutError(input.timeoutMs));
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
          });
        });
      });
    },
  };
}
