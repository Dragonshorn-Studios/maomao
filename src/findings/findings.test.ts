import { describe, expect, it } from "vitest";
import { findingMarker, fingerprintFinding, parseFindingMarker } from "./identity.js";
import { parseOverrideCommand, canIssueOverride } from "./commands.js";
import { acceptClassification, classifyPriorFindings, collectPriorFindings, findingsForPublish } from "./reconcile.js";
import { applyReconciliationThreads, persistClassifications } from "./apply.js";
import { openDb } from "../db.js";
import { JobStore, type JobRow } from "../jobs/store.js";
import type { ReviewThread } from "../github/client.js";
import type { Config } from "../config.js";

describe("finding identity", () => {
  it("is stable across line numbers but not path or category", () => {
    const base = { file: "src/auth.ts", category: "security", summary: "token compared with == " };
    const a = fingerprintFinding({ ...base, summary: "token compared with == on line 12" });
    const b = fingerprintFinding({ ...base, summary: "token compared with == on line 40" });
    expect(a).toBe(b);
    expect(fingerprintFinding({ ...base, file: "src/other.ts" })).not.toBe(a);
    expect(fingerprintFinding({ ...base, category: "correctness" })).not.toBe(a);
  });

  it("stays stable when prose changes around the same code identifiers", () => {
    const a = fingerprintFinding({
      file: "src/auth.ts",
      category: "security",
      summary: "cookieSecure drops Secure when proto is a list",
    });
    const b = fingerprintFinding({
      file: "src/auth.ts",
      category: "security",
      summary: "cookieSecure still drops the Secure flag for a proto list",
    });
    expect(a).toBe(b);
    const c = fingerprintFinding({
      file: "src/auth.ts",
      category: "security",
      summary: "timingSafeEqual is skipped for api tokens",
    });
    expect(c).not.toBe(a);
  });

  it("round-trips the HTML marker", () => {
    const marker = findingMarker("abc123def4567890", "cafebabe");
    expect(parseFindingMarker(`hello\n${marker}\n`)).toEqual({ id: "abc123def4567890", sha: "cafebabe" });
    expect(parseFindingMarker("no marker")).toBeUndefined();
  });
});

describe("override commands", () => {
  it("parses ignore, bury, seedling, and reopen", () => {
    expect(parseOverrideCommand("@maomao ignore")).toEqual({ command: "dismiss", token: "ignore" });
    expect(parseOverrideCommand("  @maomao bury.  ")).toEqual({ command: "dismiss", token: "bury" });
    expect(parseOverrideCommand("🌱")).toEqual({ command: "dismiss", token: "seedling" });
    expect(parseOverrideCommand("🌱️")).toEqual({ command: "dismiss", token: "seedling" });
    expect(parseOverrideCommand("@maomao reopen")).toEqual({ command: "reopen", token: "reopen" });
  });

  it("rejects longer discussion that only mentions a command", () => {
    expect(parseOverrideCommand("@maomao bury this later")).toBeUndefined();
    expect(parseOverrideCommand("please ignore")).toBeUndefined();
    expect(parseOverrideCommand("plant 🌱 here")).toBeUndefined();
  });

  it("ignores a command that exists only inside a quoted reply", () => {
    expect(parseOverrideCommand("> @maomao bury\nlooks fine")).toBeUndefined();
    expect(parseOverrideCommand("> previous discussion\n@maomao bury")).toEqual({
      command: "dismiss",
      token: "bury",
    });
  });
});

describe("override authorization", () => {
  it("allows write/maintain/admin and OWNER only when the collaborator API reports none", () => {
    expect(canIssueOverride("write")).toBe(true);
    expect(canIssueOverride("admin", "MEMBER")).toBe(true);
    expect(canIssueOverride("none", "OWNER")).toBe(true);
    expect(canIssueOverride("read", "OWNER")).toBe(false);
    expect(canIssueOverride("none", "MEMBER")).toBe(false);
    expect(canIssueOverride("triage", "OWNER")).toBe(false);
  });
});

describe("classification gates", () => {
  it("leaves low-confidence resolved and location-less moved as uncertain", () => {
    expect(acceptClassification("resolved", 0.4, 0.7).status).toBe("uncertain");
    expect(acceptClassification("moved", 0.9, 0.7).status).toBe("uncertain");
    expect(acceptClassification("moved", 0.9, 0.7, "a.ts", 4).status).toBe("moved");
    expect(acceptClassification("resolved", 0.91, 0.7).status).toBe("resolved");
  });
});

describe("prior finding collection and publish filtering", () => {
  it("discovers unresolved Maomao threads and skips human threads", () => {
    const marker = findingMarker("deadbeefdeadbeef", "oldsha");
    const threads: ReviewThread[] = [
      {
        id: "PRRT_maomao",
        isResolved: false,
        path: "src/a.ts",
        line: 3,
        comments: [{ id: "c1", databaseId: 11, body: `${marker}\n**high**: leak`, path: "src/a.ts", line: 3 }],
      },
      {
        id: "PRRT_human",
        isResolved: false,
        comments: [{ id: "c2", databaseId: 12, body: "please fix this", path: "src/b.ts", line: 1 }],
      },
    ];
    const priors = collectPriorFindings({ threads, stored: [] });
    expect(priors).toHaveLength(1);
    expect(priors[0]?.fingerprint).toBe("deadbeefdeadbeef");
    expect(priors[0]?.threadId).toBe("PRRT_maomao");
  });

  it("omits dismissed and already-open still_valid findings from a new review", () => {
    const finding = {
      severity: "high" as const,
      confidence: 0.9,
      category: "security",
      file: "src/auth.ts",
      line: 4,
      summary: "token compared with ==",
      reviewers_agreed: [] as string[],
    };
    const fingerprint = fingerprintFinding(finding);
    const published = findingsForPublish([finding], {
      headSha: "new",
      items: [
        {
          fingerprint,
          status: "dismissed",
          confidence: 1,
          reason: "buried",
          summary: finding.summary,
        },
      ],
    });
    expect(published).toHaveLength(0);

    const stillOpen = findingsForPublish([finding], {
      headSha: "new",
      items: [
        {
          fingerprint,
          status: "still_valid",
          confidence: 0.9,
          reason: "still there",
          summary: finding.summary,
        },
      ],
    });
    expect(stillOpen).toHaveLength(0);
  });

  it("republishes moved findings at the new location", () => {
    const published = findingsForPublish([], {
      headSha: "new",
      items: [
        {
          fingerprint: "movedfid00000001",
          status: "moved",
          confidence: 0.9,
          reason: "renamed",
          summary: "null deref",
          currentPath: "src/b.ts",
          currentLine: 9,
          severity: "high",
        },
      ],
    });
    expect(published).toEqual([
      expect.objectContaining({ file: "src/b.ts", line: 9, fingerprint: "movedfid00000001" }),
    ]);
  });

  it("treats stored resolved rows as settled unless an unresolved thread remains", () => {
    const store = new JobStore(openDb(":memory:"));
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: "resolvedfid000001",
      status: "resolved",
      reviewedSha: "old",
      summary: "fixed bug",
      githubThreadId: "PRRT_old",
    });
    const withoutThread = collectPriorFindings({ threads: [], stored: store.listFindings("acme/widgets", 7) });
    expect(withoutThread).toEqual([
      expect.objectContaining({ fingerprint: "resolvedfid000001", settledResolved: true, dismissed: false }),
    ]);

    const marker = findingMarker("resolvedfid000001", "old");
    const withOpenThread = collectPriorFindings({
      threads: [
        {
          id: "PRRT_still_open",
          isResolved: false,
          comments: [{ id: "c1", databaseId: 11, body: `${marker}\n**high**: leak` }],
        },
      ],
      stored: store.listFindings("acme/widgets", 7),
    });
    expect(withOpenThread[0]).toEqual(
      expect.objectContaining({ fingerprint: "resolvedfid000001", settledResolved: false, threadId: "PRRT_still_open" }),
    );
  });

  it("allows a previously resolved fingerprint to be reported again if specialists find it", () => {
    const finding = {
      severity: "high" as const,
      confidence: 0.9,
      category: "security",
      file: "src/auth.ts",
      line: 4,
      summary: "token compared with ==",
      reviewers_agreed: [] as string[],
    };
    const fingerprint = fingerprintFinding(finding);
    const published = findingsForPublish([finding], {
      headSha: "new",
      items: [{ fingerprint, status: "resolved", confidence: 1, reason: "gone", summary: finding.summary }],
    });
    expect(published).toEqual([expect.objectContaining({ fingerprint, file: "src/auth.ts" })]);
  });
});

describe("finding store dismiss vs resolved", () => {
  it("keeps dismissed and resolved as distinct rows and does not resurrect a burial", () => {
    const store = new JobStore(openDb(":memory:"));
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: "aaaabbbbccccdddd",
      status: "resolved",
      reviewedSha: "sha1",
      summary: "fixed bug",
    });
    store.dismissFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: "eeeeffff00001111",
      actor: "octocat",
      command: "bury",
      reviewedSha: "sha1",
      summary: "noisy lint",
    });
    const again = store.dismissFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: "eeeeffff00001111",
      actor: "octocat",
      command: "bury",
      reviewedSha: "sha1",
      summary: "noisy lint",
    });
    expect(again.changed).toBe(false);
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: "eeeeffff00001111",
      status: "open",
      reviewedSha: "sha2",
      summary: "noisy lint",
    });
    const rows = store.listFindings("acme/widgets", 7);
    expect(rows.find((row) => row.fingerprint === "aaaabbbbccccdddd")?.status).toBe("resolved");
    expect(rows.find((row) => row.fingerprint === "eeeeffff00001111")?.status).toBe("dismissed");
    expect(rows.find((row) => row.fingerprint === "eeeeffff00001111")?.dismissed_by).toBe("octocat");
  });
});

describe("thread apply", () => {
  const job = { installation_id: 1 } as JobRow;

  it("does not resolve a moved thread unless a replacement comment was posted", async () => {
    const resolved: string[] = [];
    const github = {
      resolveReviewThread: async (_id: number, threadId: string) => {
        resolved.push(threadId);
      },
    };
    const snapshot = {
      headSha: "new",
      items: [
        {
          fingerprint: "moved1",
          status: "moved" as const,
          confidence: 0.9,
          reason: "relocated",
          summary: "bug",
          threadId: "PRRT_moved",
        },
        {
          fingerprint: "fixed1",
          status: "resolved" as const,
          confidence: 0.95,
          reason: "gone",
          summary: "other",
          threadId: "PRRT_fixed",
        },
      ],
    };
    const skipped = await applyReconciliationThreads({
      github: github as never,
      job,
      snapshot,
      postedFingerprints: [],
    });
    expect(resolved).toEqual(["PRRT_fixed"]);
    expect(skipped.skipped).toContain("moved1");

    resolved.length = 0;
    const posted = await applyReconciliationThreads({
      github: github as never,
      job,
      snapshot,
      postedFingerprints: ["moved1"],
    });
    expect(resolved).toEqual(["PRRT_moved", "PRRT_fixed"]);
    expect(posted.resolved).toEqual(["moved1", "fixed1"]);
  });
});

describe("settled resolved classification", () => {
  it("does not send settled resolved findings to the verifier", async () => {
    const items = await classifyPriorFindings({
      config: { reconcileMinConfidence: 0.7, opencode: { verifierModel: "x" } } as Config,
      opencode: {
        async run() {
          throw new Error("verifier should not run");
        },
      },
      job: { id: 1, repo_full_name: "acme/widgets", pr_number: 7, pr_title: "t", head_sha: "h" } as JobRow,
      repoDir: "/tmp",
      diff: "",
      workspaceDir: "/tmp",
      priors: [
        {
          fingerprint: "abc",
          summary: "fixed",
          dismissed: false,
          settledResolved: true,
        },
      ],
      signal: new AbortController().signal,
    });
    expect(items).toEqual([
      expect.objectContaining({ fingerprint: "abc", status: "resolved", reason: "already resolved; no open thread to re-check" }),
    ]);
  });
});

describe("persisting anchored mini diffs", () => {
  const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -50,6 +50,7 @@ export function login() {
  const existing = 1;
  const secret = readSecret();
+  console.log("leak", secret);
  return issueJwt();
}`;

  function job(): JobRow {
    return {
      id: 7,
      repo_full_name: "acme/widgets",
      pr_number: 12,
      head_sha: "headsha1",
      pr_html_url: "https://github.com/acme/widgets/pull/12",
    } as unknown as JobRow;
  }

  it("stores a bounded hunk from the authoritative diff for persisted findings", () => {
    const store = new JobStore(openDb(":memory:"));
    persistClassifications(
      store,
      job(),
      [
        {
          fingerprint: "fp_with_hunk",
          status: "still_valid",
          confidence: 0.9,
          reason: "still applies",
          currentPath: "src/auth.ts",
          currentLine: 52,
          summary: "secret leaks to the log",
        },
      ],
      diff,
    );
    const row = store.listFindings("acme/widgets", 12)[0];
    expect(row?.diff_hunk).toContain('console.log("leak", secret);');
    expect(row?.diff_hunk).toContain("secret = readSecret();");
    expect(row?.diff_hunk?.startsWith("@@")).toBe(true);
    expect(row?.diff_note).toBeNull();
  });

  it("records an explicit note instead of a hunk when the line is outside the diff", () => {
    const store = new JobStore(openDb(":memory:"));
    persistClassifications(
      store,
      job(),
      [
        {
          fingerprint: "fp_outside",
          status: "still_valid",
          confidence: 0.9,
          reason: "still applies",
          currentPath: "src/auth.ts",
          currentLine: 500,
          summary: "way outside the hunk",
        },
      ],
      diff,
    );
    const row = store.listFindings("acme/widgets", 12)[0];
    expect(row?.diff_hunk).toBeNull();
    expect(row?.diff_note).toBe("outside_hunk");
  });

  it("keeps an existing hunk when later updates carry no diff", () => {
    const store = new JobStore(openDb(":memory:"));
    persistClassifications(
      store,
      job(),
      [
        {
          fingerprint: "fp_keep",
          status: "still_valid",
          confidence: 0.9,
          reason: "still applies",
          currentPath: "src/auth.ts",
          currentLine: 52,
          summary: "secret leaks",
        },
      ],
      diff,
    );
    persistClassifications(store, job(), [
      {
        fingerprint: "fp_keep",
        status: "resolved",
        confidence: 0.9,
        reason: "fixed later",
        currentPath: "src/auth.ts",
        currentLine: 52,
        summary: "secret leaks",
      },
    ]);
    const row = store.listFindings("acme/widgets", 12)[0];
    expect(row?.status).toBe("resolved");
    expect(row?.diff_hunk).toContain("console.log");
  });
});
