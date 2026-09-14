import { describe, expect, it } from "vitest";
import { buildOpenCodeArgs } from "./spawn.js";

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
