import { describe, expect, it } from "vitest";
import type { JobRow } from "../jobs/store.js";
import { buildGuidedComparison, comparisonOverrides } from "./comparison.js";
import type { GuidedCommentView, GuidedReviewSessionRow } from "./store.js";

const sha = "b".repeat(40);

function session(): GuidedReviewSessionRow {
  return {
    id: 1,
    actor_provider: "github",
    actor_id: "1001",
    provider: "github",
    provider_instance: "github.com",
    repo_full_name: "acme/widgets",
    pr_number: 12,
    base_sha: "a".repeat(40),
    head_sha: sha,
    status: "active",
    current_path: null,
    current_hunk: null,
    position_json: "{}",
    viewed_files_json: "[]",
    draft_summary: "",
    draft_verdict: null,
    walkthrough_ref: null,
    comparison_state_json: "{}",
    version: 1,
    historical_at: null,
    last_mutation_id: null,
    created_at: "now",
    updated_at: "now",
    last_opened_at: "now",
  };
}

function comment(clientId: string, body: string, path = "src/a.ts", line = 10, severity: GuidedCommentView["severity"] = "medium"): GuidedCommentView {
  return {
    id: 1,
    sessionId: 1,
    clientId,
    kind: "inline",
    body,
    path,
    side: "RIGHT",
    line,
    hunkAnchor: null,
    anchorStatus: "anchored",
    severity,
    category: "correctness",
    publishable: true,
    sourceCommentId: null,
    deletedAt: null,
    createdAt: "now",
    updatedAt: "now",
  };
}

function job(findings: unknown[], state = "completed", reconciliation: unknown[] = []): JobRow {
  return {
    id: 7,
    state,
    head_sha: sha,
    aggregator_normalized: JSON.stringify({ schema_version: 1, verdict: "comment", summary: "summary", findings }),
    reconciliation_json: JSON.stringify({ headSha: sha, items: reconciliation }),
  } as JobRow;
}

describe("Guided Review comparison", () => {
  it("matches the same issue at shifted lines without merging unrelated findings in one file", () => {
    const same = "Avoid a cache race when refresh writes stale data";
    const unrelated = "Rename the button label for clarity";
    const view = buildGuidedComparison({
      session: session(),
      comments: [comment("h1", same, "src/a.ts", 44), comment("h2", unrelated, "src/a.ts", 45)],
      job: job([
        { severity: "medium", category: "correctness", file: "src/a.ts", line: 12, summary: same, body: "The stale write can win the race." },
        { severity: "low", category: "style", file: "src/a.ts", line: 46, summary: "Use a consistent button label.", body: "Presentation-only cleanup." },
      ]),
    });
    expect(view.state).toBe("ready");
    expect(view.agreements).toHaveLength(1);
    expect(view.agreements[0]?.human.key).toBe("h1");
    expect(view.agreements[0]?.signals.join(" ")).toContain("shifted line");
    expect(view.humanOnly.map((item) => item.key)).toEqual(["h2"]);
    expect(view.maomaoOnly).toHaveLength(1);
  });

  it("keeps plausible but unconfirmed matches uncertain and honors manual confirm/reject pairing", () => {
    const human = comment("h1", "The retry path can duplicate delivery in edge cases", "src/a.ts", 30);
    const finding = { severity: "high", category: "correctness", file: "src/a.ts", line: 28, summary: "Retry delivery may be duplicated", body: "Adjacent retry logic can emit twice." };
    const initial = buildGuidedComparison({ session: session(), comments: [human], job: job([finding]) });
    expect(initial.agreements).toHaveLength(0);
    expect(initial.uncertain).toHaveLength(1);
    expect(initial.uncertain[0]?.severityDifference).toContain("human medium vs Maomao high");
    const verdictSession = session();
    verdictSession.draft_verdict = "APPROVE";
    const verdictJob = job([finding]);
    verdictJob.review_event = "REQUEST_CHANGES";
    expect(buildGuidedComparison({ session: verdictSession, comments: [human], job: verdictJob }).verdictDifference).toBe("human APPROVE vs Maomao REQUEST_CHANGES");

    const confirmed = buildGuidedComparison({
      session: session(),
      comments: [human],
      job: job([finding]),
      comparisonState: { pairs: { h1: { fingerprint: initial.uncertain[0]!.maomao.fingerprint, decision: "confirm" } } },
    });
    expect(confirmed.agreements).toHaveLength(1);
    expect(confirmed.agreements[0]?.confirmed).toBe(true);

    const rejected = buildGuidedComparison({
      session: session(),
      comments: [human],
      job: job([finding]),
      comparisonState: { pairs: { h1: { fingerprint: initial.uncertain[0]!.maomao.fingerprint, decision: "reject" } } },
    });
    expect(rejected.uncertain).toHaveLength(0);
    expect(rejected.humanOnly).toHaveLength(1);
    expect(rejected.maomaoOnly).toHaveLength(1);
  });

  it("preserves suppressed, resolved, missing-location and duplicate reconciliation evidence explicitly", () => {
    const fingerprint = "abc123";
    const view = buildGuidedComparison({
      session: session(),
      comments: [],
      job: job(
        [{ severity: "medium", category: "correctness", summary: "General missing validation", body: "No path was identified." }],
        "completed",
        [
          { fingerprint, status: "dismissed", summary: "Old suppressed race", reason: "authorized human override", originalPath: "src/old.ts", originalLine: 3, severity: "high", category: "correctness" },
          { fingerprint: "def456", status: "resolved", summary: "Old resolved race", reason: "fixed in pinned diff", originalPath: "src/old.ts", originalLine: 9, severity: "medium", category: "correctness" },
        ],
      ),
    });
    expect(view.maomaoOnly.map((item) => item.status)).toEqual(["open"]);
    expect(view.inactiveMaomao.map((item) => item.status).sort()).toEqual(["dismissed", "resolved"]);
    expect(view.maomaoOnly.some((item) => !item.path)).toBe(true);

    const duplicated = buildGuidedComparison({
      session: session(),
      comments: [],
      job: job([
        { severity: "medium", category: "correctness", file: "src/a.ts", line: 10, summary: "Duplicate validation finding", body: "Same evidence" },
        { severity: "medium", category: "correctness", file: "src/a.ts", line: 10, summary: "Duplicate validation finding", body: "Same evidence" },
      ]),
    });
    expect(duplicated.maomaoOnly).toHaveLength(1);
  });

  it("makes missing, pending, failed and stale Maomao states explicit", () => {
    const comments = [comment("h1", "A human note")];
    expect(buildGuidedComparison({ session: session(), comments }).state).toBe("missing");
    expect(buildGuidedComparison({ session: session(), comments, job: job([], "aggregating") }).state).toBe("pending");
    expect(buildGuidedComparison({ session: session(), comments, job: job([], "failed") }).state).toBe("failed");
    const malformed = job([], "completed");
    malformed.aggregator_normalized = "not-json";
    expect(buildGuidedComparison({ session: session(), comments, job: malformed }).state).toBe("failed");
    const badReconciliation = job([], "completed");
    badReconciliation.reconciliation_json = "not-json";
    expect(buildGuidedComparison({ session: session(), comments, job: badReconciliation }).state).toBe("failed");
    const stale = buildGuidedComparison({
      session: session(),
      comments,
      job: job([{ severity: "medium", category: "correctness", file: "src/a.ts", line: 10, summary: "Pinned stale evidence", body: "Exact-SHA artifact" }], "stale"),
    });
    expect(stale.state).toBe("stale");
    expect(stale.maomaoOnly.map((item) => item.summary)).toEqual(["Pinned stale evidence"]);
  });



  it("keeps resolved or dismissed reconciliation evidence visible without consuming active human findings", () => {
    const finding = { severity: "medium", category: "correctness", file: "src/a.ts", line: 10, summary: "Old race is already fixed", body: "Fixed evidence" };
    const view = buildGuidedComparison({
      session: session(),
      comments: [comment("h1", "Old race is already fixed", "src/a.ts", 10)],
      job: job([], "completed", [
        { fingerprint: "resolved-fp", status: "resolved", summary: "Old race is already fixed", reason: "fixed in pinned diff", originalPath: "src/a.ts", originalLine: 10, severity: "medium", category: "correctness" },
      ]),
    });
    expect(view.agreements).toHaveLength(0);
    expect(view.uncertain).toHaveLength(0);
    expect(view.humanOnly.map((item) => item.key)).toEqual(["h1"]);
    expect(view.inactiveMaomao.map((item) => item.status)).toEqual(["resolved"]);
  });

  it("uses normalized specialist evidence as provenance for aggregator findings", () => {
    const finding = { severity: "medium", category: "correctness", file: "src/a.ts", line: 10, summary: "Validate retry identifiers", body: "Missing validation can duplicate delivery." };
    const view = buildGuidedComparison({
      session: session(),
      comments: [],
      job: job([finding]),
      reviewerRuns: [{
        id: 1,
        job_id: 7,
        role: "correctness",
        title: "Correctness",
        state: "done",
        normalized_json: JSON.stringify({ schema_version: 1, reviewer: "correctness", verdict: "findings", findings: [{ severity: "medium", confidence: 0.8, category: "correctness", file: "src/a.ts", line: 10, summary: "Validate retry identifiers", reason: "A missing retry identifier check can duplicate delivery." }] }),
      } as never],
    });
    expect(view.maomaoOnly[0]?.rationale).toContain("correctness: A missing retry identifier check");
  });

  it("hides deliberately excluded Maomao findings from the active merge view", () => {
    const finding = { severity: "medium", category: "correctness", file: "src/a.ts", line: 20, summary: "Retry can duplicate delivery", body: "The retry branch can emit twice." };
    const initial = buildGuidedComparison({ session: session(), comments: [], job: job([finding]) });
    const fingerprint = initial.maomaoOnly[0]!.fingerprint;
    const excluded = buildGuidedComparison({
      session: session(),
      comments: [],
      job: job([finding]),
      comparisonState: { pairs: { [`maomao-exclude-${fingerprint}`]: { fingerprint, decision: "exclude" } } },
    });
    expect(excluded.maomaoOnly).toHaveLength(0);
    expect(excluded.excludedMaomao.map((item) => item.fingerprint)).toEqual([fingerprint]);
  });

  it("parses only bounded manual pairing override state", () => {
    expect(comparisonOverrides({ pairs: { h1: { fingerprint: "f", decision: "confirm" }, bad: { fingerprint: "f", decision: "force" } } })).toEqual({ h1: { fingerprint: "f", decision: "confirm" } });
    expect(comparisonOverrides([])).toEqual({});
  });
});
