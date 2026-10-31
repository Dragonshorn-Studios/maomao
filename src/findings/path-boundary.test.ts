import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filePathInsideRepo, findingPathViolations, outsidePathReferences } from "./path-boundary.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "maomao-boundary-"));
  const repoDir = join(root, "job-1", "repo");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "app.ts"), "export {}\n");
  const secret = join(root, "secret.json");
  await writeFile(secret, '{"key":"value"}');
  const sibling = join(root, "job-1", "reconcile-context.md");
  await writeFile(sibling, "context");
  return { root, repoDir, secret, sibling };
}

describe("filePathInsideRepo", () => {
  it("accepts repo-relative paths, including files that no longer exist", async () => {
    const { repoDir } = await fixture();
    expect(filePathInsideRepo(repoDir, "src/app.ts")).toBe(true);
    expect(filePathInsideRepo(repoDir, "src/deleted-in-pr.ts")).toBe(true);
  });

  it("rejects traversal escapes and absolute paths outside the checkout", async () => {
    const { repoDir, secret } = await fixture();
    expect(filePathInsideRepo(repoDir, "../reconcile-context.md")).toBe(false);
    expect(filePathInsideRepo(repoDir, "../../secret.json")).toBe(false);
    expect(filePathInsideRepo(repoDir, "/etc/passwd")).toBe(false);
    expect(filePathInsideRepo(repoDir, secret)).toBe(false);
  });

  it("accepts absolute paths that land inside the checkout", async () => {
    const { repoDir } = await fixture();
    expect(filePathInsideRepo(repoDir, join(repoDir, "src/app.ts"))).toBe(true);
  });

  it("rejects a repo symlink that resolves outside the checkout", async () => {
    const { repoDir, secret } = await fixture();
    await symlink(secret, join(repoDir, "src", "link.json"));
    expect(filePathInsideRepo(repoDir, "src/link.json")).toBe(false);
  });
});

describe("outsidePathReferences", () => {
  it("flags absolute paths to files that exist on the host", async () => {
    const { repoDir, secret } = await fixture();
    const refs = outsidePathReferences(`Credentials found in ${secret}: leaked`, repoDir);
    expect(refs).toEqual([secret]);
  });

  it("flags ../ escapes that land on real files outside the checkout", async () => {
    const { repoDir } = await fixture();
    expect(outsidePathReferences("read ../../secret.json for details", repoDir)).toEqual(["../../secret.json"]);
    expect(outsidePathReferences("read ../reconcile-context.md for details", repoDir)).toEqual([
      "../reconcile-context.md",
    ]);
  });

  it("ignores tokens naming no host file — route-like paths are not exfiltration", async () => {
    const { repoDir } = await fixture();
    expect(
      outsidePathReferences("The /api/v1/users route leaks data; see https://example.com/docs/x", repoDir),
    ).toEqual([]);
    expect(outsidePathReferences("check /definitely/not/a/real/path-9f3d", repoDir)).toEqual([]);
  });

  it("ignores absolute tokens that resolve back inside the checkout", async () => {
    const { repoDir } = await fixture();
    const inside = join(repoDir, "src/app.ts");
    expect(outsidePathReferences(`see ${inside}`, repoDir)).toEqual([]);
  });

  it("flags ~ paths when they resolve under a given home", async () => {
    const { repoDir, root } = await fixture();
    const refs = outsidePathReferences("config at ~/secret.json", repoDir, root);
    expect(refs).toEqual(["~/secret.json"]);
  });

  it("flags every existing absolute ref when repoDir is unknown (swept workspace)", async () => {
    const { secret } = await fixture();
    expect(outsidePathReferences(`stashed at ${secret}`, undefined)).toEqual([secret]);
  });
});

describe("findingPathViolations", () => {
  it("reports the file location when it escapes the checkout", async () => {
    const { repoDir, secret } = await fixture();
    const violations = findingPathViolations(
      { file: "../../secret.json", summary: "host file", body: "body" },
      repoDir,
    );
    expect(violations).toEqual([{ source: "file", ref: "../../secret.json" }]);
    const absolute = findingPathViolations({ file: secret, summary: "x" }, repoDir);
    expect(absolute).toEqual([{ source: "file", ref: secret }]);
  });

  it("reports out-of-checkout references in summary and body prose", async () => {
    const { repoDir, secret } = await fixture();
    const violations = findingPathViolations(
      { file: "src/app.ts", summary: `key material in ${secret}`, body: "details" },
      repoDir,
    );
    expect(violations).toEqual([{ source: "text", ref: secret }]);
  });

  it("passes a clean in-repo finding", async () => {
    const { repoDir } = await fixture();
    expect(
      findingPathViolations({ file: "src/app.ts", summary: "bug in `src/app.ts`", body: "see line 1" }, repoDir),
    ).toEqual([]);
  });
});
