import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  extractJsonFromText,
  fallbackAggregator,
  formatZodIssues,
  parseAggregatorResult,
  parseBriefResult,
  parseReviewerResult,
  parseVerifierResult,
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

describe("location-sentinel normalization (issue #62)", () => {
  const locationlessFinding = {
    severity: "high",
    confidence: 0.9,
    category: "correctness",
    file: "",
    line: 0,
    end_line: 0,
    summary: "race in the cache sweeper",
    reason: "two writers can interleave",
    suggested_check: "",
  };

  it("normalizes empty/null/zero location sentinels to absent keys", () => {
    const result = parseReviewerResult(
      JSON.stringify({
        reviewer: "correctness",
        verdict: "findings",
        findings: [
          { ...locationlessFinding, file: null, line: null, end_line: null },
          { ...locationlessFinding, file: "   ", line: 0, end_line: 0 },
        ],
      }),
    );
    expect(result.verdict).toBe("findings");
    expect(result.findings).toHaveLength(2);
    for (const finding of result.findings) {
      expect(finding.file).toBeUndefined();
      expect(finding.line).toBeUndefined();
      expect(finding.end_line).toBeUndefined();
      expect(finding.suggested_check).toBeUndefined();
      expect(finding.summary).toBe("race in the cache sweeper");
    }
  });

  it("normalizes an empty-findings findings-verdict to clean (pins the long-standing special case)", () => {
    const result = parseReviewerResult(
      JSON.stringify({ reviewer: "tests", verdict: "findings", findings: [] }),
    );
    expect(result.verdict).toBe("clean");
    expect(result.findings).toEqual([]);
  });

  it("drops a completely non-substantive placeholder finding", () => {
    const result = parseReviewerResult(
      JSON.stringify({
        reviewer: "correctness",
        verdict: "findings",
        findings: [
          { severity: "info", confidence: 0.5, category: "general", file: "", line: 0, summary: "", reason: "" },
          // An abandoned stub with invalid severity/confidence but zero prose is
          // equally non-substantive: dropped, not fatal (deliberate choice).
          { severity: "critical", confidence: 2, category: "x", file: "", line: 0, summary: "", reason: "" },
        ],
      }),
    );
    expect(result.verdict).toBe("clean");
    expect(result.findings).toEqual([]);
  });

  it("still fails a substantive finding whose required prose is missing", () => {
    // Has a location (and summary), so it is not a placeholder: strict validation still rejects the empty reason.
    expect(() =>
      parseReviewerResult(
        JSON.stringify({
          reviewer: "correctness",
          verdict: "findings",
          findings: [{ severity: "high", confidence: 0.9, category: "x", file: "a.ts", line: 3, summary: "s", reason: "" }],
        }),
      ),
    ).toThrow(/reason/);
  });

  it("drops placeholders in aggregator and applies the same sentinel rules", () => {
    const parsed = parseAggregatorResult(
      JSON.stringify({
        verdict: "comment",
        summary: "One real finding and one placeholder.",
        findings: [
          { severity: "medium", file: "", line: 0, summary: "locationless but real", body: "details" },
          { severity: "info", file: "", line: 0, summary: "", body: "" },
        ],
      }),
    );
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.file).toBeUndefined();
    expect(parsed.findings[0]?.line).toBeUndefined();
    expect(parsed.findings[0]?.summary).toBe("locationless but real");
  });

  it("normalizes verifier classifications", () => {
    const parsed = parseVerifierResult(
      JSON.stringify({
        classifications: [
          { fingerprint: "fp1", status: "still_valid", confidence: 0.9, reason: "unchanged", file: "", line: 0 },
        ],
      }),
    );
    expect(parsed.classifications).toHaveLength(1);
    expect(parsed.classifications[0]?.file).toBeUndefined();
    expect(parsed.classifications[0]?.line).toBeUndefined();
  });

  it("still rejects negative and non-integer lines and missing required fields", () => {
    const cases = [
      { severity: "high", confidence: 0.9, category: "x", file: "a.ts", line: -3, summary: "s", reason: "r" },
      { severity: "high", confidence: 0.9, category: "x", file: "a.ts", line: 1.5, summary: "s", reason: "r" },
      // Wrongly-typed line is left for strict validation, not coerced.
      { severity: "high", confidence: 0.9, category: "x", file: "a.ts", line: "3", summary: "s", reason: "r" },
      { severity: "high", confidence: 0.9, category: "x", summary: "s", reason: "" },
      { severity: "high", confidence: 0.9, reason: "r" },
      { severity: "high", confidence: 0.9, summary: "s", reason: "r" },
      // A lone end_line (even negative) is a location remnant: strict validation, not a placeholder drop.
      { severity: "high", confidence: 0.9, category: "x", end_line: -5, summary: "", reason: "" },
    ];
    for (const finding of cases) {
      expect(() =>
        parseReviewerResult(
          JSON.stringify({ reviewer: "correctness", verdict: "findings", findings: [finding] }),
        ),
      ).toThrow();
    }
  });
});

describe("repo brief schema (issue #88)", () => {
  const section = (path: string) => ({ title: `Section ${path}`, path, summary: "why it matters" });
  const briefJson = (sections: unknown[]) =>
    JSON.stringify({ schema_version: 1, summary: "what this tree holds", sections });

  it("accepts a 5–15 section TOC and extracts it from fenced output", () => {
    const parsed = parseBriefResult(
      `\`\`\`json\n${briefJson([section("a.ts"), section("b.ts"), section("c.ts"), section("d.ts"), section("e.ts")])}\n\`\`\``,
    );
    expect(parsed.sections).toHaveLength(5);
    expect(parsed.sections[0]?.path).toBe("a.ts");
  });

  it("rejects TOCs outside the 5–15 section bound", () => {
    expect(() => parseBriefResult(briefJson([section("a.ts"), section("b.ts"), section("c.ts"), section("d.ts")]))).toThrow();
    const tooMany = Array.from({ length: 16 }, (_, i) => section(`f${i}.ts`));
    expect(() => parseBriefResult(briefJson(tooMany))).toThrow();
  });

  it("rejects non-JSON output", () => {
    expect(() => parseBriefResult("no json here")).toThrow(SchemaValidationError);
  });
});

describe("formatZodIssues", () => {
  it("produces a bounded field-pathed summary, never the raw dump", () => {
    let caught: unknown;
    try {
      parseReviewerResult(
        JSON.stringify({
          reviewer: "correctness",
          verdict: "findings",
          findings: [
            { severity: "critical", confidence: 2, category: "x", summary: "real summary", reason: "real reason" },
          ],
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZodError);
    const formatted = formatZodIssues(caught as ZodError);
    expect(formatted).toContain("findings[0].severity");
    expect(formatted).toContain("findings[0].confidence");
    // No raw-dump artifacts: no JSON structure ("[{") or "received" fields, and bounded length.
    expect(formatted).not.toContain("[{");
    expect(formatted).not.toContain('"received"');
    expect(formatted.length).toBeLessThan(300);
  });

  it("truncates long issue lists with a count marker", () => {
    const findings = Array.from({ length: 12 }, (_, index) => ({
      severity: "critical",
      confidence: 2,
      category: "x",
      summary: `s${index}`,
      reason: `r${index}`,
    }));
    let caught: unknown;
    try {
      parseReviewerResult(
        JSON.stringify({ reviewer: "correctness", verdict: "findings", findings }),
      );
    } catch (error) {
      caught = error;
    }
    const formatted = formatZodIssues(caught as ZodError);
    expect(formatted).toContain("(+");
    expect(formatted).toMatch(/\+\d+ more\)$/);
  });
});

describe("sentinel normalization follow-ups (review pass)", () => {
  it("normalizes sentinels inside fenced JSON output", () => {
    const result = parseReviewerResult(
      'Sure.\n```json\n{"reviewer":"correctness","verdict":"findings","findings":[{"severity":"low","confidence":0.6,"category":"x","file":"","line":0,"summary":"note","reason":"why"}]}\n```',
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBeUndefined();
    expect(result.findings[0]?.line).toBeUndefined();
  });

  it("coerces an empty-findings aggregator result to clean so the empty-review gate applies", () => {
    const parsed = parseAggregatorResult(
      JSON.stringify({ verdict: "comment", summary: "Only placeholders below.", findings: [] }),
    );
    expect(parsed.verdict).toBe("clean");
  });

  it("keeps a comment verdict when findings survive", () => {
    const parsed = parseAggregatorResult(
      JSON.stringify({
        verdict: "comment",
        summary: "One real finding.",
        findings: [{ severity: "medium", summary: "real", body: "details" }],
      }),
    );
    expect(parsed.verdict).toBe("comment");
    expect(parsed.findings).toHaveLength(1);
  });

  it("never drops verifier classifications as placeholders — a fingerprint decision is substance", () => {
    // Empty reason and no location must fail loudly, not silently discard the decision.
    expect(() =>
      parseVerifierResult(
        JSON.stringify({
          classifications: [{ fingerprint: "fp1", status: "moved", confidence: 0.9, reason: "" }],
        }),
      ),
    ).toThrow(/reason/);
    const parsed = parseVerifierResult(
      JSON.stringify({
        classifications: [
          { fingerprint: "fp1", status: "still_valid", confidence: 0.9, reason: "unchanged", file: "", line: 0 },
        ],
      }),
    );
    expect(parsed.classifications).toHaveLength(1);
    expect(parsed.classifications[0]?.file).toBeUndefined();
  });

  it("still rejects an empty aggregator summary (result-level sentinels are not normalized)", () => {
    expect(() =>
      parseAggregatorResult(JSON.stringify({ verdict: "comment", summary: "", findings: [] })),
    ).toThrow();
  });

  it("formats path-less issues as (root)", () => {
    let caught: unknown;
    try {
      parseReviewerResult("null");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZodError);
    expect(formatZodIssues(caught as ZodError)).toContain("(root)");
  });

  it("reports dropped placeholders through onDrop", () => {
    const drops: number[] = [];
    parseReviewerResult(
      JSON.stringify({
        reviewer: "correctness",
        verdict: "findings",
        findings: [
          { severity: "info", confidence: 0.5, category: "general", file: "", line: 0, summary: "", reason: "" },
          { severity: "info", confidence: 0.5, category: "general", summary: "", reason: "" },
        ],
      }),
      undefined,
      (dropped) => drops.push(dropped),
    );
    expect(drops).toEqual([2]);
  });
});
