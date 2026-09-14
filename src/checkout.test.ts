import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCheckout,
  execFile,
  gitAuthSecrets,
  gitHttpAuthArgs,
} from "./checkout.js";

const TOKEN = "ghs_testtoken_abcdefgh";

describe("gitHttpAuthArgs", () => {
  it("uses Basic x-access-token, not Bearer", () => {
    const args = gitHttpAuthArgs(TOKEN);
    const joined = args.join(" ");
    const basic = Buffer.from(`x-access-token:${TOKEN}`, "utf8").toString("base64");
    expect(joined).toContain("credential.helper=");
    expect(joined).toContain(`http.extraHeader=AUTHORIZATION: basic ${basic}`);
    expect(joined.toLowerCase()).not.toContain("bearer");
    expect(gitHttpAuthArgs()).toEqual([]);
    expect(gitAuthSecrets(TOKEN)).toEqual(
      expect.arrayContaining([TOKEN, basic, `x-access-token:${TOKEN}`]),
    );
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], { env: process.env, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

describe("createCheckout", () => {
  it("fetches refs/pull/*/head and authenticates with basic extraHeader", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "maomao-co-"));
    const origin = join(tmp, "origin");
    const work = join(tmp, "ws");
    const logPath = join(tmp, "git.log");
    const wrapper = join(tmp, "git-wrapper");
    try {
      const init = await execFile("git", ["init", "-b", "main", origin], { env: process.env });
      expect(init.exitCode).toBe(0);
      await git(origin, ["config", "user.email", "test@example.com"]);
      await git(origin, ["config", "user.name", "maomao-test"]);
      await writeFile(join(origin, "README.md"), "hello\n");
      await git(origin, ["add", "README.md"]);
      await git(origin, ["commit", "-m", "init"]);
      const headSha = await git(origin, ["rev-parse", "HEAD"]);
      await git(origin, ["update-ref", "refs/pull/7/head", headSha]);

      await writeFile(
        wrapper,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexec git "$@"\n`,
        { mode: 0o755 },
      );
      await chmod(wrapper, 0o755);

      const checkout = createCheckout(work, wrapper);
      const workspace = await checkout.prepare({
        jobId: 1,
        installationId: 99,
        owner: "acme",
        repo: "widgets",
        prNumber: 7,
        baseSha: headSha,
        headSha,
        token: TOKEN,
        cloneUrl: origin,
        secrets: [TOKEN],
        fetchDiff: async () => "diff --git a/README.md b/README.md\n",
        metadata: { repo: "acme/widgets", pr: 7 },
      });

      const checked = await git(workspace.repoDir, ["rev-parse", "HEAD"]);
      expect(checked).toBe(headSha);
      const remotes = await git(workspace.repoDir, ["remote"]);
      expect(remotes).toBe("");

      const log = await readFile(logPath, "utf8");
      const basic = Buffer.from(`x-access-token:${TOKEN}`, "utf8").toString("base64");
      expect(log).toContain("fetch");
      expect(log).toContain(`AUTHORIZATION: basic ${basic}`);
      expect(log).toContain("credential.helper=");
      expect(log.toLowerCase()).not.toContain("bearer");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("redacts the installation token when git fetch fails", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "maomao-co-fail-"));
    const work = join(tmp, "ws");
    const fakeGit = join(tmp, "fake-git");
    try {
      await writeFile(
        fakeGit,
        `#!/bin/sh
echo "$*" >&2
while [ $# -gt 0 ]; do
  case "$1" in
    -C) shift 2 ;;
    -c) shift 2 ;;
    *) break ;;
  esac
done
case "$1" in
  fetch)
    echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2
    echo "token=${TOKEN}" >&2
    exit 1
    ;;
  *) exit 0 ;;
esac
`,
        { mode: 0o755 },
      );
      await chmod(fakeGit, 0o755);

      const checkout = createCheckout(work, fakeGit);
      try {
        await checkout.prepare({
          jobId: 2,
          installationId: 99,
          owner: "acme",
          repo: "widgets",
          prNumber: 7,
          baseSha: "aaa",
          headSha: "bbb",
          token: TOKEN,
          cloneUrl: "https://github.com/acme/widgets.git",
          secrets: [TOKEN],
          fetchDiff: async () => "",
          metadata: {},
        });
        throw new Error("expected git fetch to fail");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("git fetch failed");
        expect(message).not.toContain(TOKEN);
        expect(message).toContain("[redacted]");
        expect(message).toContain("could not read Username");
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
