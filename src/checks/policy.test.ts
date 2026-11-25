import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { applyTrustedPolicy, findingFingerprint, readTrustedPolicy } from "./policy.js";
import type { TrustedCheckFinding } from "./trusted.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function policyDir(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maomao-policy-"));
  dirs.push(dir);
  if (contents != null) await writeFile(join(dir, "maomao-policy.json"), contents);
  return dir;
}

const finding: TrustedCheckFinding = {
  severity: "medium",
  category: "semgrep",
  file: "src/a.ts",
  line: 3,
  summary: "dangerous pattern",
};

describe("trusted repository policy", () => {
  it("defaults to enabled checks when no policy file exists", async () => {
    const policy = await readTrustedPolicy(await policyDir(), "org/repo", ["secrets"], "a".repeat(40));
    expect(policy).toMatchObject({ requiredChecks: ["secrets"], requireReview: false, severityThreshold: "high", source: "default" });
  });

  it("merges defaults with exact repository overrides", async () => {
    const dir = await policyDir(JSON.stringify({
      version: 1,
      defaults: { requireReview: true, severityThreshold: "high", requiredChecks: ["secrets"] },
      repositories: { "org/repo": { severityThreshold: "medium", requiredChecks: ["security"] } },
    }));
    const policy = await readTrustedPolicy(dir, "org/repo", ["secrets", "security"], "b".repeat(40));
    expect(policy).toMatchObject({ requireReview: true, severityThreshold: "medium", requiredChecks: ["security"], source: "trusted-repo" });
  });

  it("rejects malformed trusted policy instead of guessing", async () => {
    await expect(readTrustedPolicy(await policyDir("{"), "org/repo", [], "c".repeat(40))).rejects.toThrow();
  });

  it("filters findings by threshold and explicit fingerprint suppressions", () => {
    const suppressed = findingFingerprint("security", finding);
    const result = applyTrustedPolicy({
      name: "security" as const,
      status: "failure" as const,
      conclusion: "failure" as const,
      findings: [finding],
    }, {
      requireReview: false,
      requiredChecks: ["security" as const],
      severityThreshold: "high" as const,
      suppressions: [],
    });
    expect(result.status).toBe("success");
    expect(result.findings).toEqual([]);

    const explicit = applyTrustedPolicy({
      name: "security" as const,
      status: "failure" as const,
      conclusion: "failure" as const,
      findings: [{ ...finding, severity: "high" }],
    }, {
      requireReview: false,
      requiredChecks: ["security" as const],
      severityThreshold: "high" as const,
      suppressions: [{ check: "security" as const, fingerprint: suppressed, reason: "reviewed false positive" }],
    });
    expect(explicit.status).toBe("success");
    expect(explicit.suppressedFindings).toBe(1);
  });
});
