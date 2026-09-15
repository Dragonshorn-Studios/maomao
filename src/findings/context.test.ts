import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSnippet, resolveSafeRepoPath } from "./context.js";

describe("safe repo path", () => {
  it("rejects lexical traversal and committed symlinks that escape the repo", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "maomao-repo-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "maomao-out-"));
    const secret = join(outsideDir, "secret.txt");
    await writeFile(secret, "host-secret\n", "utf8");
    await writeFile(join(repoDir, "ok.ts"), "export const n = 1;\n", "utf8");
    await symlink(secret, join(repoDir, "escape.ts"));

    expect(await resolveSafeRepoPath(repoDir, "../secret.txt")).toBeUndefined();
    expect(await resolveSafeRepoPath(repoDir, "escape.ts")).toBeUndefined();
    expect(await resolveSafeRepoPath(repoDir, "ok.ts")).toBe(await realpath(join(repoDir, "ok.ts")));
    expect(await readSnippet(repoDir, "escape.ts", 1)).toBeUndefined();
    expect(await readSnippet(repoDir, "ok.ts", 1)).toContain("export const n = 1;");
  });
});
