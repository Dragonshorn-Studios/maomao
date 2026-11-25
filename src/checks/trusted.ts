/**
 * Trusted deterministic check runner. Definitions come only from an
 * operator-selected, immutable git revision — never from the pull request —
 * and execute without network access in a resource-limited bubblewrap sandbox.
 * Production fails closed when that isolation is unavailable; the unsafe local
 * mode is an explicit development/test escape hatch.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Severity } from "../schema.js";

export type TrustedCheckName = "secrets" | "security";
export const TRUSTED_CHECK_NAMES: TrustedCheckName[] = ["secrets", "security"];
export const trustedCheckNativeName = (name: TrustedCheckName) => `maomao/${name}`;

const findingSchema = z.object({
  severity: z.enum(["blocker", "high", "medium", "low", "info"]),
  category: z.string().min(1).max(120),
  file: z.string().min(1).max(500).optional(),
  line: z.number().int().positive().optional(),
  summary: z.string().min(1).max(2_000),
  evidence: z.string().max(4_000).optional(),
});

const resultSchema = z.object({
  status: z.enum(["success", "failure", "error", "skipped"]),
  findings: z.array(findingSchema).max(500).default([]),
  diagnostics: z.string().max(8_000).optional(),
  scanner: z.object({ name: z.string().min(1).max(120), version: z.string().max(120).optional() }),
});

export interface TrustedCheckFinding extends z.infer<typeof findingSchema> {
  severity: Severity;
}

export interface TrustedCheckResult {
  name: TrustedCheckName;
  nativeName: string;
  status: "success" | "failure" | "error" | "skipped";
  conclusion: "success" | "failure" | "action_required" | "skipped";
  findings: TrustedCheckFinding[];
  diagnostics: string;
  scannerName: string;
  scannerVersion?: string;
  revision: string;
  durationMs: number;
}

interface CheckDefinition {
  path: string;
  interpreter: "sh" | "bash" | "python3";
  timeoutMs: number;
  cpuSeconds: number;
  memoryBytes: number;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function runProcess(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-64_000);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const abort = () => {
      timedOut = true;
      child.kill("SIGKILL");
    };
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener("abort", abort, { once: true });
    const finish = (result: Omit<ProcessResult, "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      resolvePromise({ ...result, timedOut });
    };
    child.on("error", (error) => finish({ code: null, signal: null, stdout, stderr, spawnError: error.message }));
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr }));
  });
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.spawnError || result.code !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${(result.stderr || result.spawnError || `exit ${result.code}`).slice(0, 500)}`);
  }
  return result.stdout.trim();
}

async function executableOnPath(name: string): Promise<boolean> {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      await access(join(dir, name));
      return true;
    } catch {}
  }
  return false;
}

function validateRelativePath(path: string): void {
  if (!path || path.startsWith("/") || path.split(/[\\/]+/).some((part) => part === ".." || part === "")) {
    throw new Error(`trusted check path must be a relative path inside the pinned checkout: ${path}`);
  }
}

function parseDefinition(name: TrustedCheckName, raw: unknown): CheckDefinition {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`trusted check ${name} definition is missing`);
  const value = raw as Record<string, unknown>;
  const path = typeof value.path === "string" ? value.path : "";
  validateRelativePath(path);
  const interpreter = value.interpreter;
  if (interpreter !== "sh" && interpreter !== "bash" && interpreter !== "python3") {
    throw new Error(`trusted check ${name} interpreter must be sh, bash, or python3`);
  }
  if (value.timeoutMs != null && (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1_000 || value.timeoutMs > 15 * 60_000)) {
    throw new Error(`trusted check ${name} timeoutMs must be an integer between 1000 and 900000`);
  }
  const timeoutMs = typeof value.timeoutMs === "number" ? value.timeoutMs : 120_000;
  if (value.cpuSeconds != null && (typeof value.cpuSeconds !== "number" || !Number.isInteger(value.cpuSeconds) || value.cpuSeconds < 1 || value.cpuSeconds > 900)) {
    throw new Error(`trusted check ${name} cpuSeconds must be an integer between 1 and 900`);
  }
  const cpuSeconds = typeof value.cpuSeconds === "number" ? value.cpuSeconds : Math.min(Math.max(Math.ceil(timeoutMs / 1000), 1), 900);
  if (
    value.memoryBytes != null &&
    (typeof value.memoryBytes !== "number" || !Number.isInteger(value.memoryBytes) || value.memoryBytes < 64 * 1024 * 1024 || value.memoryBytes > 8 * 1024 * 1024 * 1024)
  ) {
    throw new Error(`trusted check ${name} memoryBytes must be an integer between 64 MiB and 8 GiB`);
  }
  const memoryBytes = typeof value.memoryBytes === "number" ? value.memoryBytes : 2 * 1024 * 1024 * 1024;
  return { path, interpreter, timeoutMs, cpuSeconds, memoryBytes };
}

function interpreterArgv(interpreter: CheckDefinition["interpreter"], scriptPath: string): string[] {
  if (interpreter === "sh") return ["/bin/sh", scriptPath];
  if (interpreter === "bash") return ["/bin/bash", scriptPath];
  return ["/usr/bin/env", "python3", scriptPath];
}

function collectSecrets(value: unknown, output = new Set<string>(), keyName = ""): Set<string> {
  if (typeof value === "string") {
    if (/secret|token|password/i.test(keyName) && value.length >= 4) output.add(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, output, keyName);
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectSecrets(item, output, key);
  }
  return output;
}

function redactValue(value: unknown, secrets: Set<string>, keyName = ""): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of secrets) redacted = redacted.split(secret).join("[redacted]");
    return /secret|token|password/i.test(keyName) && secrets.has(value) ? "[redacted]" : redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, keyName));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets, key)]));
  }
  return value;
}

function redactText(text: string, secrets: Set<string>): string {
  let redacted = text;
  for (const secret of secrets) redacted = redacted.split(secret).join("[redacted]");
  return redacted;
}

function errorResult(name: TrustedCheckName, revision: string, diagnostics: string, startedAt: number): TrustedCheckResult {
  return {
    name,
    nativeName: trustedCheckNativeName(name),
    status: "error",
    conclusion: "action_required",
    findings: [],
    diagnostics: diagnostics.slice(0, 8_000),
    scannerName: name,
    revision,
    durationMs: Date.now() - startedAt,
  };
}

export class TrustedCheckRunner {
  private checkoutPromise?: Promise<string>;

  constructor(private readonly config: Config) {}

  enabled(): boolean {
    return Boolean((this.config.trustedChecks.repoUrl || this.config.trustedChecks.localPath) && this.config.trustedChecks.revision);
  }

  async run(input: {
    name: TrustedCheckName;
    repoDir: string;
    workspaceDir: string;
    diffPath: string;
    signal?: AbortSignal;
  }): Promise<TrustedCheckResult> {
    const startedAt = Date.now();
    const revision = this.config.trustedChecks.revision;
    if (!this.enabled()) return errorResult(input.name, revision, "trusted checks are not configured", startedAt);
    try {
      const trustedDir = await this.checkout();
      const repoRealPath = await realpath(input.repoDir);
      if (trustedDir === repoRealPath || trustedDir.startsWith(repoRealPath + sep) || repoRealPath.startsWith(trustedDir + sep)) {
        throw new Error("trusted checks checkout must not overlap the pull-request checkout");
      }
      const manifestRaw = JSON.parse(await readFile(join(trustedDir, "maomao-trusted-checks.json"), "utf8")) as { version?: number; checks?: Record<string, unknown> };
      if (manifestRaw.version !== 1) throw new Error("trusted checks manifest version must be 1");
      const definition = parseDefinition(input.name, manifestRaw.checks?.[input.name]);
      const scriptHostPath = await realpath(resolve(trustedDir, definition.path));
      if (!scriptHostPath.startsWith(resolve(trustedDir) + sep)) throw new Error("trusted check path escapes the pinned checkout");
      await access(scriptHostPath);

      const outputDir = join(input.workspaceDir, "trusted-checks", input.name);
      await mkdir(outputDir, { recursive: true });
      const resultHostPath = join(outputDir, "result.json");
      await rm(resultHostPath, { force: true, recursive: true });
      const sandboxed = await executableOnPath("bwrap");
      if (!sandboxed && !this.config.trustedChecks.allowUnsafeLocal) {
        return errorResult(input.name, revision, "bubblewrap (bwrap) is unavailable; refusing to run deterministic checks without isolation", startedAt);
      }

      const limited = await executableOnPath("prlimit");
      if (sandboxed && !limited) {
        return errorResult(input.name, revision, "prlimit is unavailable; refusing to run deterministic checks without resource limits", startedAt);
      }
      const scriptPath = sandboxed ? `/trusted/${definition.path}` : scriptHostPath;
      const repoPath = sandboxed ? "/work/repo" : input.repoDir;
      const diffPath = sandboxed ? "/work/pr.diff" : input.diffPath;
      const resultPath = sandboxed ? "/output/result.json" : resultHostPath;
      const childArgs = interpreterArgv(definition.interpreter, scriptPath);
      let command = childArgs[0]!;
      let args = [...childArgs.slice(1)];
      let env: NodeJS.ProcessEnv = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        MAOMAO_REPO_DIR: repoPath,
        MAOMAO_DIFF_PATH: diffPath,
        MAOMAO_RESULT_PATH: resultPath,
        MAOMAO_CHECK_NAME: input.name,
        MAOMAO_CHECK_REVISION: revision,
        MAOMAO_TRUSTED_DIR: sandboxed ? "/trusted" : trustedDir,
        HOME: "/tmp",
        TMPDIR: "/tmp",
      };
      if (sandboxed) {
        const binds: string[] = [];
        for (const dir of ["/usr/bin", "/usr/lib", "/usr/lib64", "/usr/libexec", "/usr/share", "/usr/local/bin", "/usr/local/lib", "/usr/local/lib64", "/usr/local/libexec", "/usr/local/share", "/bin", "/lib", "/lib64"]) {
          try {
            await access(dir);
            binds.push("--ro-bind", dir, dir);
          } catch {}
        }
        command = "bwrap";
        args = [
          "--die-with-parent",
          "--new-session",
          "--unshare-all",
          "--unshare-user",
          "--clearenv",
          "--uid", "0",
          "--gid", "0",
          "--proc", "/proc",
          "--dev", "/dev",
          ...binds,
          "--ro-bind", trustedDir, "/trusted",
          "--ro-bind", input.repoDir, "/work/repo",
          "--ro-bind", input.diffPath, "/work/pr.diff",
          "--bind", outputDir, "/output",
          "--tmpfs", "/tmp",
          "--setenv", "PATH", env.PATH!,
          "--setenv", "MAOMAO_REPO_DIR", repoPath,
          "--setenv", "MAOMAO_DIFF_PATH", diffPath,
          "--setenv", "MAOMAO_RESULT_PATH", resultPath,
          "--setenv", "MAOMAO_CHECK_NAME", input.name,
          "--setenv", "MAOMAO_CHECK_REVISION", revision,
          "--setenv", "MAOMAO_TRUSTED_DIR", "/trusted",
          "--setenv", "HOME", "/tmp",
          "--setenv", "TMPDIR", "/tmp",
          "--chdir", "/trusted",
          ...childArgs,
        ];
        env = process.env;
        args = [
          `--cpu=${definition.cpuSeconds}`,
          `--as=${definition.memoryBytes}`,
          `--fsize=${64 * 1024 * 1024}`,
          command,
          ...args,
        ];
        command = "prlimit";
      }

      if (input.signal?.aborted) return errorResult(input.name, revision, "cancelled before scanner start", startedAt);
      const processResult = await runProcess(command, args, { timeoutMs: definition.timeoutMs, env, signal: input.signal });
      let raw = "";
      try {
        const resultStat = await lstat(resultHostPath);
        if (!resultStat.isFile() || resultStat.isSymbolicLink()) throw new Error("result path is not a regular file");
        if (resultStat.size > 1024 * 1024) throw new Error(`result JSON exceeds 1 MiB (${resultStat.size} bytes)`);
        raw = await readFile(resultHostPath, "utf8");
        await rm(resultHostPath, { force: true, recursive: true });
      } catch (readError) {
        if (readError instanceof Error && (readError.message === "result path is not a regular file" || readError.message.startsWith("result JSON exceeds"))) {
          await rm(resultHostPath, { force: true, recursive: true });
          return errorResult(input.name, revision, readError.message, startedAt);
        }
        const detail = processResult.timedOut
          ? `scanner timed out after ${definition.timeoutMs}ms and wrote no result`
          : `scanner wrote no result (exit ${processResult.code ?? processResult.signal ?? "unknown"}): ${(processResult.stderr || processResult.spawnError || "").slice(-1_000)}`;
        return errorResult(input.name, revision, detail, startedAt);
      }
      const secrets = new Set<string>();
      let parsedUnknown: unknown;
      try {
        parsedUnknown = JSON.parse(raw);
        for (const secret of collectSecrets(parsedUnknown, secrets)) {
          if (secret.length >= 4) secrets.add(secret);
        }
      } catch (error) {
        return errorResult(input.name, revision, `scanner wrote invalid JSON: ${error instanceof Error ? error.message : String(error)}`, startedAt);
      }
      const redacted = redactValue(parsedUnknown, secrets);
      const parsed = resultSchema.safeParse(redacted);
      if (!parsed.success) {
        return errorResult(input.name, revision, `scanner result violates the contract: ${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 500)}`, startedAt);
      }
      const diagnostics = [
        parsed.data.diagnostics ?? "",
        processResult.timedOut ? `scanner timed out after ${definition.timeoutMs}ms` : "",
        processResult.stderr ? `stderr: ${redactText(processResult.stderr, secrets).slice(-1_000)}` : "",
      ].filter(Boolean).join("\n");
      const processFailed = processResult.timedOut || Boolean(processResult.spawnError) || processResult.code !== 0;
      const processDiagnostic = !processResult.timedOut && processResult.code !== 0
        ? `scanner exited with ${processResult.code ?? processResult.signal ?? processResult.spawnError ?? "unknown error"}`
        : "";
      const allDiagnostics = [diagnostics, processDiagnostic].filter(Boolean).join("\n");
      const status = processFailed ? "error" : parsed.data.status;
      return {
        name: input.name,
        nativeName: trustedCheckNativeName(input.name),
        status,
        conclusion: status === "error" ? "action_required" : status,
        findings: parsed.data.findings as TrustedCheckFinding[],
        diagnostics: allDiagnostics.slice(0, 8_000),
        scannerName: parsed.data.scanner.name,
        ...(parsed.data.scanner.version ? { scannerVersion: parsed.data.scanner.version } : {}),
        revision,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return errorResult(input.name, revision, error instanceof Error ? error.message : String(error), startedAt);
    }
  }

  private checkout(): Promise<string> {
    if (!this.checkoutPromise) {
      const pending = this.prepareCheckout();
      this.checkoutPromise = pending;
      void pending.catch(() => {
        if (this.checkoutPromise === pending) this.checkoutPromise = undefined;
      });
    }
    return this.checkoutPromise;
  }

  private async prepareCheckout(): Promise<string> {
    const revision = this.config.trustedChecks.revision;
    if (this.config.trustedChecks.localPath) {
      const path = await realpath(this.config.trustedChecks.localPath);
      const head = await git(["rev-parse", "HEAD"], path);
      if (head !== revision) throw new Error(`trusted checks local checkout is at ${head}, not pinned revision ${revision}`);
      const dirty = await git(["status", "--porcelain"], path);
      if (dirty) throw new Error("trusted checks local checkout has uncommitted changes");
      return path;
    }
    const repoUrl = this.config.trustedChecks.repoUrl;
    if (!repoUrl || repoUrl.startsWith("-")) throw new Error("trusted checks repository URL is missing or invalid");
    const root = join(this.config.workspaceRoot, "trusted-checks", createHash("sha256").update(repoUrl).digest("hex").slice(0, 16));
    const target = join(root, revision);
    try {
      await access(join(target, "maomao-trusted-checks.json"));
    } catch {
      await mkdir(root, { recursive: true });
      await rm(target, { recursive: true, force: true });
      await git(["clone", "--no-checkout", repoUrl, target]);
      await git(["checkout", "--detach", revision], target);
    }
    const head = await git(["rev-parse", "HEAD"], target);
    if (head !== revision) throw new Error(`trusted checks clone resolved ${head}, not pinned revision ${revision}`);
    const dirty = await git(["status", "--porcelain"], target);
    if (dirty) throw new Error("trusted checks cache has uncommitted changes");
    return realpath(target);
  }
}
