import { describe, expect, it } from "vitest";
import {
  extractJsonFromText,
  fallbackAggregator,
  parseAggregatorResult,
  parseReviewerResult,
  SchemaValidationError,
  coalesceAdvisoryTestFindings,
  isAdvisoryMissingTestFinding,
} from "./schema.js";
import { toInlineComments } from "./github/client.js";

describe("reviewer schema", () => {
  it("parses a valid reviewer payload", () => {
    const result = parseReviewerResult(
      JSON.stringify({
        reviewer: "correctness",
        verdict: "findings",
        findings: [
          {
            severity: "high",
            confidence: 0.92,
            category: "correctness",
            file: "src/example.ts",
            line: 123,
            summary: "off by one",
            reason: "loop bound",
            suggested_check: "add a test",
          },
        ],
      }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.schema_version).toBe(1);
  });

  it("extracts JSON from fenced output and rejects garbage", () => {
    const extracted = extractJsonFromText('Sure.\n```json\n{"reviewer":"tests","verdict":"clean","findings":[]}\n```');
    expect(extracted).toMatchObject({ verdict: "clean" });
    expect(() => parseReviewerResult("not json at all")).toThrow(SchemaValidationError);
  });

  it("rejects malformed findings", () => {
    expect(() =>
      parseReviewerResult(
        JSON.stringify({
          reviewer: "security",
          verdict: "findings",
          findings: [{ severity: "critical", confidence: 2, summary: "x" }],
        }),
      ),
    ).toThrow();
  });

  it("builds a conservative fallback aggregator", () => {
    const aggregated = fallbackAggregator([
      parseReviewerResult(
        JSON.stringify({
          reviewer: "correctness",
          verdict: "findings",
          findings: [
            {
              severity: "medium",
              confidence: 0.7,
              category: "correctness",
              file: "a.ts",
              line: 1,
              summary: "bug",
              reason: "because",
            },
          ],
        }),
      ),
      parseReviewerResult(
        JSON.stringify({
          reviewer: "security",
          verdict: "findings",
          findings: [
            {
              severity: "medium",
              confidence: 0.6,
              category: "correctness",
              file: "a.ts",
              line: 1,
              summary: "bug",
              reason: "dup",
            },
          ],
        }),
      ),
    ]);
    expect(aggregated.findings).toHaveLength(1);
    expect(parseAggregatorResult(JSON.stringify(aggregated)).verdict).toBe("comment");
  });
});

describe("advisory missing-test coalesce", () => {
  it("treats low tests-role notes as advisory and leaves medium GitHub-mutating gaps alone", () => {
    expect(
      isAdvisoryMissingTestFinding({
        severity: "low",
        category: "tests",
        summary: "The hint double-prefix guard is untested",
      }),
    ).toBe(true);
    expect(
      isAdvisoryMissingTestFinding({
        severity: "medium",
        category: "tests",
        summary: "Dismiss/reopen 403 warning path has no test coverage",
      }),
    ).toBe(false);
    expect(
      isAdvisoryMissingTestFinding({
        severity: "low",
        category: "architecture",
        summary: "Optional port methods match existing probing",
      }),
    ).toBe(false);
  });

  it("merges several low missing-test notes into one finding without file or line", () => {
    const coalesced = coalesceAdvisoryTestFindings([
      {
        severity: "low",
        confidence: 0.7,
        category: "tests",
        file: "src/github/errors.ts",
        line: 93,
        summary: "double-prefix guard untested",
        body: "Add githubRetryReason string-path cases.",
        reviewers_agreed: ["tests"],
      },
      {
        severity: "info",
        confidence: 0.6,
        category: "tests",
        file: "src/github/webhooks.ts",
        line: 518,
        summary: "webhook warning path untested",
        reviewers_agreed: ["tests"],
      },
      {
        severity: "medium",
        confidence: 0.8,
        category: "correctness",
        file: "src/github/errors.ts",
        line: 85,
        summary: "isIntegrationForbidden matches any forbidden 403",
        reviewers_agreed: ["correctness"],
      },
    ]);
    expect(coalesced).toHaveLength(2);
    const advisory = coalesced.find((finding) => finding.category === "tests");
    const product = coalesced.find((finding) => finding.category === "correctness");
    expect(product?.file).toBe("src/github/errors.ts");
    expect(advisory?.file).toBeUndefined();
    expect(advisory?.line).toBeUndefined();
    expect(advisory?.severity).toBe("low");
    expect(advisory?.body).toContain("src/github/errors.ts:93");
    expect(advisory?.body).toContain("src/github/webhooks.ts:518");
    expect(toInlineComments(coalesced, 12, "abc").map((comment) => comment.path)).toEqual(["src/github/errors.ts"]);
  });

  it("coalesces tests-reviewer output in the deterministic aggregator fallback", () => {
    const aggregated = fallbackAggregator([
      parseReviewerResult(
        JSON.stringify({
          reviewer: "tests",
          verdict: "findings",
          findings: [
            {
              severity: "low",
              confidence: 0.7,
              category: "tests",
              file: "src/github/errors.ts",
              line: 93,
              summary: "string-input hint path untested",
              reason: "githubRetryReason string path never hits forbidden",
            },
            {
              severity: "low",
              confidence: 0.6,
              category: "tests",
              file: "src/github/webhooks.ts",
              line: 518,
              summary: "describeThreadResolveError wiring untested",
              reason: "no warning assertion in webhooks.test.ts",
            },
          ],
        }),
      ),
    ]);
    expect(aggregated.findings).toHaveLength(1);
    expect(aggregated.findings[0]?.file).toBeUndefined();
    expect(aggregated.summary).toContain("Places:");
    expect(aggregated.summary).toContain("src/github/errors.ts:93");
    expect(aggregated.summary).toContain("src/github/webhooks.ts:518");
  });

  it("strips locations from LLM aggregator output so GitHub does not get a cluster of test nits", () => {
    const parsed = parseAggregatorResult(
      JSON.stringify({
        schema_version: 1,
        verdict: "comment",
        summary: "Plumbing is sound. A few missing tests.",
        findings: [
          {
            severity: "low",
            confidence: 0.7,
            category: "tests",
            file: "a.ts",
            line: 10,
            summary: "guard untested",
            body: "add a case",
            reviewers_agreed: ["tests"],
          },
          {
            severity: "low",
            confidence: 0.6,
            category: "tests",
            file: "b.ts",
            line: 20,
            summary: "string path untested",
            reviewers_agreed: ["tests"],
          },
        ],
      }),
    );
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.file).toBeUndefined();
    expect(parsed.summary).toContain("Places:");
    expect(parsed.summary).toContain("a.ts:10");
    expect(parsed.summary).toContain("b.ts:20");
  });
});
