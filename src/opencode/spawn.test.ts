import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenCodeArgs, createOpenCodeRunner } from "./spawn.js";

async function fakeBin(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maomao-bin-"));
  const path = join(dir, "fake-opencode.sh");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("buildOpenCodeArgs", () => {
  it("puts the prompt after -- so --file cannot swallow it", () => {
    const prompt = "You are a specialist code reviewer working for Maomao";
    const args = buildOpenCodeArgs({
      cwd: "/data/workspaces/job-1/repo",
      model: "opencode-go/glm-5.3-flash",
      title: "maomao-correctness-1",
      files: ["/data/workspaces/job-1/pr.diff", "/data/workspaces/job-1/pr.json"],
      prompt,
    });
    const dash = args.lastIndexOf("--");
    expect(dash).toBeGreaterThan(0);
    expect(args[dash + 1]).toBe(prompt);
    expect(args.slice(0, dash).filter((arg) => arg === "--file")).toHaveLength(2);
    expect(args.slice(dash + 1)).toEqual([prompt]);
  });
});

describe("createOpenCodeRunner firstOutputMs", () => {
  it("measures spawn to first stdout byte", async () => {
    const bin = await fakeBin(`sleep 0.2\nprintf '%s\\n' '{"type":"text","part":{"text":"hi"}}'`);
    const result = await createOpenCodeRunner().run({
      cwd: process.cwd(),
      model: "m",
      prompt: "p",
      timeoutMs: 10000,
      bin,
    });
    expect(result.exitCode).toBe(0);
    expect(result.firstOutputMs).toBeGreaterThanOrEqual(100);
    expect(result.firstOutputMs).toBeLessThan(5000);
  });

  it("stays undefined when the child never writes to stdout", async () => {
    const bin = await fakeBin("exit 0");
    const result = await createOpenCodeRunner().run({
      cwd: process.cwd(),
      model: "m",
      prompt: "p",
      timeoutMs: 10000,
      bin,
    });
    expect(result.exitCode).toBe(0);
    expect(result.firstOutputMs).toBeUndefined();
  });
});
