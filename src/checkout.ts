import { spawn } from "node:child_process";
import { mkdir, writeFile, chmod, rm, readdir, stat, lstat } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeChildEnv } from "./opencode/env.js";
import { redactSecrets } from "./util.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execFile(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
    secrets?: string[];
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? sanitizeChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`timed out after ${options.timeoutMs}ms: ${command} ${args.join(" ")}`));
          }, options.timeoutMs)
        : undefined;
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const secrets = options.secrets ?? [];
      resolve({
        stdout: redactSecrets(stdout, secrets),
        stderr: redactSecrets(stderr, secrets),
        exitCode: code ?? 1,
      });
    });
  });
}

export async function chmodTree(root: string, mode: number): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await chmodTree(full, mode);
      await chmod(full, mode);
    } else if (info.isFile()) {
      await chmod(full, mode);
    }
  }
  try {
    await chmod(root, mode);
  } catch {
    // ignore
  }
}

export interface Workspace {
  dir: string;
  repoDir: string;
  diffPath: string;
  metaPath: string;
}

export interface CheckoutPort {
  prepare(input: {
    jobId: number;
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    baseSha: string;
    headSha: string;
    token?: string;
    cloneUrl?: string;
    signal?: AbortSignal;
    secrets?: string[];
    fetchDiff: () => Promise<string>;
    metadata: Record<string, unknown>;
  }): Promise<Workspace>;
  cleanup(dir: string): Promise<void>;
}

/** GitHub git HTTPS wants Basic `x-access-token:<installation token>`, not Bearer. */
export function gitHttpAuthArgs(token?: string): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return ["-c", "credential.helper=", "-c", `http.extraHeader=AUTHORIZATION: basic ${basic}`];
}

export function gitAuthSecrets(token?: string): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return [token, basic, `x-access-token:${token}`];
}

export function createCheckout(workspaceRoot: string, gitBin = "git"): CheckoutPort {
  return {
    async prepare(input) {
      const dir = join(workspaceRoot, `job-${input.jobId}-${input.headSha.slice(0, 12)}`);
      const repoDir = join(dir, "repo");
      await rm(dir, { recursive: true, force: true });
      await mkdir(repoDir, { recursive: true });

      const env = sanitizeChildEnv(process.env, {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        LC_ALL: "C",
      });
      const secrets = [...(input.secrets ?? []), ...gitAuthSecrets(input.token)];
      const extraHeader = gitHttpAuthArgs(input.token);
      const git = (args: string[]) =>
        execFile(gitBin, args, { env, timeoutMs: 120_000, signal: input.signal, secrets });

      const init = await git(["-C", repoDir, "init"]);
      if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
      await git(["-C", repoDir, "config", "core.hooksPath", "/dev/null"]);
      await git(["-C", repoDir, "config", "advice.detachedHead", "false"]);

      const origin = input.cloneUrl ?? `https://github.com/${input.owner}/${input.repo}.git`;
      const addRemote = await git(["-C", repoDir, "remote", "add", "origin", origin]);
      if (addRemote.exitCode !== 0) throw new Error(`git remote add failed: ${addRemote.stderr}`);

      const fetchPr = await git([
        "-C",
        repoDir,
        ...extraHeader,
        "fetch",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        "origin",
        `+refs/pull/${input.prNumber}/head:refs/maomao/pr`,
      ]);
      if (fetchPr.exitCode !== 0) {
        const fetchSha = await git([
          "-C",
          repoDir,
          ...extraHeader,
          "fetch",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          "origin",
          `+${input.headSha}:refs/maomao/head`,
        ]);
        if (fetchSha.exitCode !== 0) {
          throw new Error(`git fetch failed: ${fetchPr.stderr || fetchSha.stderr}`);
        }
      }

      const parsed = await git(["-C", repoDir, "rev-parse", "refs/maomao/pr"]);
      const prSha = parsed.exitCode === 0 ? parsed.stdout.trim() : "";
      if (prSha && prSha !== input.headSha) {
        const fetchExact = await git([
          "-C",
          repoDir,
          ...extraHeader,
          "fetch",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          "origin",
          `+${input.headSha}:refs/maomao/head`,
        ]);
        if (fetchExact.exitCode !== 0) {
          throw new Error(
            `PR head moved (now ${prSha}); could not fetch job SHA ${input.headSha}: ${fetchExact.stderr}`,
          );
        }
      }

      const checkoutRef = prSha === input.headSha ? "refs/maomao/pr" : input.headSha;
      const checkout = await git(["-C", repoDir, "checkout", "--detach", checkoutRef]);
      if (checkout.exitCode !== 0) throw new Error(`git checkout failed: ${checkout.stderr}`);

      const head = await git(["-C", repoDir, "rev-parse", "HEAD"]);
      if (head.stdout.trim() !== input.headSha) {
        throw new Error(`checked out ${head.stdout.trim()} but job is anchored to ${input.headSha}`);
      }

      await git(["-C", repoDir, "remote", "remove", "origin"]);
      await rm(join(repoDir, ".git", "hooks"), { recursive: true, force: true });
      for (const untrusted of ["opencode.json", "opencode.jsonc", ".opencode", ".claude"]) {
        await rm(join(repoDir, untrusted), { recursive: true, force: true });
      }

      const diff = await input.fetchDiff();
      const diffPath = join(dir, "pr.diff");
      const metaPath = join(dir, "pr.json");
      await writeFile(diffPath, diff, "utf8");
      await writeFile(metaPath, JSON.stringify(input.metadata, null, 2), "utf8");

      await chmodTree(repoDir, 0o555);
      try {
        await chmod(join(repoDir, ".git"), 0o755);
      } catch {
        // .git may not be writable-needed
      }
      // Keep the project root writable so OpenCode can create session metadata
      // (files in the tree stay mode 0555). `--dir` on a fully read-only tree
      // exits with stderr and no JSON events.
      try {
        await chmod(repoDir, 0o755);
      } catch {
        // ignore
      }

      return { dir, repoDir, diffPath, metaPath };
    },
    async cleanup(dir: string) {
      try {
        await chmodTree(dir, 0o755);
      } catch {
        // still try to delete
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function sweepWorkspaces(root: string, retentionHours: number): Promise<number> {
  if (retentionHours < 0) return 0;
  const cutoff = Date.now() - retentionHours * 3600 * 1000;
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    try {
      const info = await stat(full);
      if (!info.isDirectory() || info.mtimeMs > cutoff) continue;
      await chmodTree(full, 0o755);
      await rm(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      // leave it for the next sweep
    }
  }
  return removed;
}
