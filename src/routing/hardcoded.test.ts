import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const ROOT_DIR = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|md|example|yml)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("no hardcoded escalation integrations", () => {
  it("does not hardcode @marller or glm-5.3", () => {
    const files = walk(SRC_DIR).concat([join(ROOT_DIR, ".env.example"), join(ROOT_DIR, "README.md")]);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/@marller/i);
      expect(text, file).not.toMatch(/glm-5\.3/i);
    }
  });
});
