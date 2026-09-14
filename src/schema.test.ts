import { describe, expect, it } from "vitest";
import {
  extractJsonFromText,
  fallbackAggregator,
  parseAggregatorResult,
  parseReviewerResult,
  SchemaValidationError,
} from "./schema.js";

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
