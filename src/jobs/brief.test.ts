import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BriefResult } from "../schema.js";
import { buildBriefPayload, parseBriefPayload } from "./brief.js";

async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maomao-brief-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n");
  await writeFile(join(dir, "README.md"), "# widgets\n");
  await writeFile(join(dir, "binary.bin"), Buffer.from([0x89, 0x50, 0x00, 0x0d]));
  // A symlink escaping the repo: the resolver must reject it.
  const outside = join(dir, "..", `outside-${Date.now()}.txt`);
  await writeFile(outside, "outside\n");
  await symlink(outside, join(dir, "escape.txt"));
  return dir;
}

function brief(sections: { path: string; title?: string; start?: number; end?: number }[]): BriefResult {
  return {
    schema_version: 1,
    summary: "what this tree holds",
    sections: sections.map((section) => ({
      title: section.title ?? `Section ${section.path}`,
      path: section.path,
      summary: "why it matters",
      start_line: section.start,
      end_line: section.end,
    })),
  };
}

describe("buildBriefPayload", () => {
  it("captures bounded fragments for in-repo paths", async () => {
    const repoDir = await fixtureRepo();
    const payload = await buildBriefPayload(repoDir, {
      repo: "acme/widgets",
      sha: "abc123",
      brief: brief([
        { path: "src/a.ts" },
        { path: "README.md" },
        { path: "src/missing.ts" },
        { path: "../secret.txt" },
        { path: "/etc/passwd" },
      ]),
    });
    expect(payload.kind).toBe("repo_brief");
    expect(payload.sha).toBe("abc123");
    expect(payload.sections).toHaveLength(5);

    const main = payload.sections[0]!;
    expect(main.fragment).toContain("// line 1");
    expect(main.fragment!.split("\n")).toHaveLength(120); // fragment cap
    expect(main.startLine).toBe(1);
    expect(main.endLine).toBe(120);

    expect(payload.sections[1]!.fragment).toBe("# widgets\n");
    expect(payload.sections[2]!.fragmentNote).toBe("not found");
    expect(payload.sections[3]!.fragmentNote).toBe("outside repo");
    expect(payload.sections[4]!.fragmentNote).toBe("outside repo");
  });

  it("honours the model's line window and never escapes via symlinks", async () => {
    const repoDir = await fixtureRepo();
    const payload = await buildBriefPayload(repoDir, {
      repo: "acme/widgets",
      sha: "def456",
      brief: brief([
        { path: "src/a.ts", start: 40, end: 50 },
        { path: "escape.txt" },
        { path: "binary.bin" },
        { path: "README.md" },
        { path: "src/a.ts", start: 1, end: 1 },
      ]),
    });
    const window = payload.sections[0]!;
    expect(window.startLine).toBe(40);
    expect(window.endLine).toBe(50);
    expect(window.fragment).toContain("// line 40");
    expect(window.fragment).toContain("// line 50");
    expect(window.fragment).not.toContain("// line 51");

    expect(payload.sections[1]!.fragmentNote).toBe("outside repo");
    expect(payload.sections[1]!.fragment).toBeNull();
    expect(payload.sections[2]!.fragmentNote).toBe("binary");
  });
});

describe("parseBriefPayload", () => {
  it("round-trips a stored payload and rejects junk", () => {
    expect(parseBriefPayload(null)).toBeUndefined();
    expect(parseBriefPayload("")).toBeUndefined();
    expect(parseBriefPayload("not json")).toBeUndefined();
    expect(parseBriefPayload(JSON.stringify({ kind: "other", sections: [] }))).toBeUndefined();
    const payload = {
      schema_version: 1,
      kind: "repo_brief",
      repo: "a/b",
      sha: "c".repeat(40),
      generated_at: "2026-01-01T00:00:00.000Z",
      summary: "s",
      sections: [],
    };
    expect(parseBriefPayload(JSON.stringify(payload))?.repo).toBe("a/b");
  });
});
