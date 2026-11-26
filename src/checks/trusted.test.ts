import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import { TrustedCheckSettingsStore } from "./settings.js";
import { TrustedCheckRunner } from "./trusted.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd });
}

async function trustedFixture(scriptBody: string, opts: { timeoutMs?: number; policy?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "maomao-trusted-fixture-"));
  const trusted = join(root, "trusted");
  const scriptDir = join(trusted, "checks", "secrets");
  await mkdir(scriptDir, { recursive: true });
  await writeFile(
    join(trusted, "maomao-trusted-checks.json"),
    JSON.stringify({
      version: 1,
      checks: {
        secrets: { path: "checks/secrets/run.sh", interpreter: "sh", timeoutMs: opts.timeoutMs ?? 5_000 },
        security: { path: "checks/secrets/run.sh", interpreter: "sh", timeoutMs: opts.timeoutMs ?? 5_000 },
      },
    }),
  );
  await writeFile(join(scriptDir, "run.sh"), scriptBody, { mode: 0o755 });
  if (opts.policy) await writeFile(join(trusted, "maomao-policy.json"), opts.policy);
  await git(trusted, ["init"]);
  await git(trusted, ["add", "."]);
  await git(trusted, ["commit", "-m", "trusted"]);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: trusted });
  const revision = stdout.trim();
  const workspace = join(root, "workspace");
  const repoDir = join(workspace, "repo");
  await mkdir(repoDir, { recursive: true });
  await writeFile(join(workspace, "pr.diff"), "diff --git a/a b/a\n");
  return { root, trusted, workspace, repoDir, diffPath: join(workspace, "pr.diff"), revision };
}

function configFor(revision: string, trusted: string, workspaceRoot: string, unsafe = true) {
  return loadConfig({
    MAOMAO_TRUSTED_CHECKS_PATH: trusted,
    MAOMAO_TRUSTED_CHECKS_REVISION: revision,
    MAOMAO_TRUSTED_CHECKS_ALLOW_UNSAFE_LOCAL: unsafe ? "1" : "0",
    WORKSPACE_ROOT: workspaceRoot,
  });
}

describe("TrustedCheckRunner", () => {
  it("runs a pinned script, normalizes the result, and redacts exact secret values", async () => {
    const secret = "ghp_testsecret123456789"; // gitleaks:allow — intentionally fake scanner fixture
    const fixture = await trustedFixture(`cat > "$MAOMAO_RESULT_PATH" <<'JSON'
{"status":"failure","scanner":{"name":"fixture","version":"1"},"findings":[{"severity":"high","category":"secret","file":"a.ts","line":2,"summary":"token found","evidence":"value ${secret}","secret":"${secret}"}]}
JSON
`);
    const runner = new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace));
    const result = await runner.run({ name: "secrets", repoDir: fixture.repoDir, workspaceDir: fixture.workspace, diffPath: fixture.diffPath });
    expect(result.status).toBe("failure");
    expect(result.conclusion).toBe("failure");
    expect(result.findings[0]?.evidence).toBe("value [redacted]");
    expect(JSON.stringify(result.findings)).not.toContain(secret);
    await expect(access(join(fixture.workspace, "trusted-checks", "secrets", "result.json"))).rejects.toThrow();
    expect(result.revision).toBe(fixture.revision);
  });

  it("applies pinned repository policy before scanner conclusions", async () => {
    const fixture = await trustedFixture(`cat > "$MAOMAO_RESULT_PATH" <<'JSON'
{"status":"failure","scanner":{"name":"fixture"},"findings":[{"severity":"medium","category":"semgrep","file":"a.ts","line":2,"summary":"medium pattern"}]}
JSON
`, {
      policy: JSON.stringify({ version: 1, defaults: { severityThreshold: "high", requiredChecks: ["secrets"] } }),
    });
    const result = await new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace)).run({
      name: "secrets",
      repoDir: fixture.repoDir,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
      repoFullName: "org/repo",
    });
    expect(result.status).toBe("success");
    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toContain("policy suppressed/filtered 1");
  });

  it("fails closed when the scanner writes malformed JSON", async () => {
    const fixture = await trustedFixture(`echo 'not-json' > "$MAOMAO_RESULT_PATH"\n`);
    const result = await new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace)).run({
      name: "security",
      repoDir: fixture.repoDir,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
    });
    expect(result.status).toBe("error");
    expect(result.conclusion).toBe("action_required");
    expect(result.diagnostics).toContain("invalid JSON");
  });

  it("fails closed when the scanner writes no result", async () => {
    const fixture = await trustedFixture(`exit 0\n`);
    const result = await new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace)).run({
      name: "secrets",
      repoDir: fixture.repoDir,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
    });
    expect(result.status).toBe("error");
    expect(result.conclusion).toBe("action_required");
    expect(result.diagnostics).toContain("wrote no result");
  });

  it("does not trust a successful result written by a crashed scanner", async () => {
    const fixture = await trustedFixture(`cat > "$MAOMAO_RESULT_PATH" <<'JSON'
{"status":"success","scanner":{"name":"fixture"},"findings":[]}
JSON
exit 7
`);
    const result = await new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace)).run({
      name: "secrets",
      repoDir: fixture.repoDir,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
    });
    expect(result.status).toBe("error");
    expect(result.conclusion).toBe("action_required");
    expect(result.diagnostics).toContain("exited with 7");
  });

  it("times out a hanging scanner as a non-success", async () => {
    const fixture = await trustedFixture(`sleep 2\n`, { timeoutMs: 1_000 });
    const result = await new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace)).run({
      name: "secrets",
      repoDir: fixture.repoDir,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
    });
    expect(result.status).toBe("error");
    expect(result.conclusion).toBe("action_required");
    expect(result.diagnostics).toContain("timed out");
  }, 5_000);

  it("does not expose the host /etc tree inside the bubblewrap sandbox", async () => {
    const hasBwrap = await execFileAsync("sh", ["-c", "command -v bwrap"]).then(() => true, () => false);
    if (!hasBwrap) return;
    const fixture = await trustedFixture(`if [ -e /etc/passwd ]; then visible=present; else visible=absent; fi
cat > "$MAOMAO_RESULT_PATH" <<JSON
{"status":"success","scanner":{"name":"fixture"},"findings":[{"severity":"info","category":"sandbox","summary":"etc $visible"}]}
JSON
`);
    const result = await new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace)).run({
      name: "secrets",
      repoDir: fixture.repoDir,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
    });
    expect(result.status).toBe("success");
    expect(result.findings[0]?.summary).toBe("etc absent");
  });

  it("deletes stale output before execution so a crashed scanner cannot reuse it", async () => {
    const fixture = await trustedFixture(`exit 7
`);
    const outputDir = join(fixture.workspace, "trusted-checks", "secrets");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "result.json"), JSON.stringify({ status: "success", scanner: { name: "stale" }, findings: [] }));
    const result = await new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace)).run({
      name: "secrets",
      repoDir: fixture.repoDir,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
    });
    expect(result.status).toBe("error");
    expect(result.scannerName).toBe("secrets");
    expect(result.diagnostics).toContain("wrote no result");
  });

  it("refuses a trusted checkout that overlaps the pull-request checkout", async () => {
    const fixture = await trustedFixture(`exit 0
`);
    const result = await new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace)).run({
      name: "secrets",
      repoDir: fixture.trusted,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
    });
    expect(result.status).toBe("error");
    expect(result.diagnostics).toContain("must not overlap");
  });

  it("reloads operator-managed pinning when the stored source or revision changes", async () => {
    const first = await trustedFixture(`printf '%s' '{"status":"success","scanner":{"name":"first"},"findings":[]}' > "$MAOMAO_RESULT_PATH"
`);
    const second = await trustedFixture(`printf '%s' '{"status":"success","scanner":{"name":"second"},"findings":[]}' > "$MAOMAO_RESULT_PATH"
`);
    const settings = new TrustedCheckSettingsStore(openDb(":memory:"), loadConfig({}).trustedChecks);
    expect(settings.save({ localPath: first.trusted, revision: first.revision, enabledChecks: ["secrets"] })).toEqual({ ok: true });
    const runner = new TrustedCheckRunner(loadConfig({}), () => settings.effective());
    const input = { name: "secrets" as const, repoDir: first.repoDir, workspaceDir: first.workspace, diffPath: first.diffPath };
    expect((await runner.run(input)).scannerName).toBe("first");
    expect(settings.save({ localPath: second.trusted, revision: second.revision, enabledChecks: ["secrets"] })).toEqual({ ok: true });
    expect((await runner.run({ ...input, workspaceDir: second.workspace })).scannerName).toBe("second");
  });

  it("refuses a dirty or wrong-revision local trusted checkout before executing anything", async () => {
    const fixture = await trustedFixture(`echo pwned > "$MAOMAO_RESULT_PATH"\n`);
    await writeFile(join(fixture.trusted, "dirty"), "dirty");
    const result = await new TrustedCheckRunner(configFor(fixture.revision, fixture.trusted, fixture.workspace)).run({
      name: "secrets",
      repoDir: fixture.repoDir,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
    });
    expect(result.status).toBe("error");
    expect(result.diagnostics).toContain("uncommitted changes");
  });

  it("clones a trusted repository at the exact pinned revision", async () => {
    const fixture = await trustedFixture(`cat > "$MAOMAO_RESULT_PATH" <<'JSON'
{"status":"success","scanner":{"name":"fixture"},"findings":[]}
JSON
`);
    const cacheRoot = join(fixture.root, "cache");
    const config = loadConfig({
      MAOMAO_TRUSTED_CHECKS_REPO_URL: fixture.trusted,
      MAOMAO_TRUSTED_CHECKS_REVISION: fixture.revision,
      MAOMAO_TRUSTED_CHECKS_ALLOW_UNSAFE_LOCAL: "1",
      WORKSPACE_ROOT: cacheRoot,
    });
    const result = await new TrustedCheckRunner(config).run({
      name: "secrets",
      repoDir: fixture.repoDir,
      workspaceDir: fixture.workspace,
      diffPath: fixture.diffPath,
    });
    expect(result.status).toBe("success");
    expect(result.conclusion).toBe("success");
  });
});
