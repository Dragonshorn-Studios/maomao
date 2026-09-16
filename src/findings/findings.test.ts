import { describe, expect, it } from "vitest";
import { findingMarker, fingerprintFinding, parseFindingMarker, scanIssueMarkerBase } from "./identity.js";
import { parseOverrideCommand, canIssueOverride } from "./commands.js";
import { acceptClassification, classifyPriorFindings, collectPriorFindings, findingsForPublish } from "./reconcile.js";
import { applyReconciliationThreads, attachStoredThreadIds, closeResolvedScanIssues, persistClassifications, persistThreadsAsFindings } from "./apply.js";
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

  it("catches GitHub-already-resolved Maomao threads without sending them back to the verifier", () => {
    const marker = findingMarker("resolvedfid000001", "oldsha");
    const store = new JobStore(openDb(":memory:"));
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: "resolvedfid000001",
      status: "open",
      reviewedSha: "old",
      summary: "fixed bug",
    });
    const priors = collectPriorFindings({
      threads: [
        {
          id: "PRRT_closed",
          isResolved: true,
          comments: [{ id: "c1", databaseId: 11, body: `${marker}\n**high**: leak` }],
        },
      ],
      stored: store.listFindings("acme/widgets", 7),
    });
    expect(priors).toEqual([
      expect.objectContaining({
        fingerprint: "resolvedfid000001",
        settledResolved: true,
        githubAlreadyResolved: true,
        threadId: "PRRT_closed",
        dismissed: false,
      }),
    ]);
  });

  it("reads the finding marker from a later comment when comments[0] is a reply", () => {
    const marker = findingMarker("deadbeefdeadbeef", "oldsha");
    const priors = collectPriorFindings({
      threads: [
        {
          id: "PRRT_replies_first",
          isResolved: false,
          comments: [
            { id: "c-reply", databaseId: 99, body: "@maomao bury" },
            { id: "c-root", databaseId: 11, body: `${marker}\n**high**: leak`, path: "src/a.ts", line: 3 },
          ],
        },
      ],
      stored: [],
    });
    expect(priors).toEqual([
      expect.objectContaining({ fingerprint: "deadbeefdeadbeef", threadId: "PRRT_replies_first", commentId: "11" }),
    ]);
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
    expect(skipped.skipped.map((item) => item.fingerprint)).toContain("moved1");
    expect(skipped.skipped.find((item) => item.fingerprint === "moved1")?.wantedClose).toBe(true);

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
      expect.objectContaining({
        fingerprint: "abc",
        status: "resolved",
        reason: "already resolved; no open thread to re-check",
        githubAlreadyResolved: true,
      }),
    ]);
  });

  it("classifies a GitHub-already-resolved thread without calling the verifier", async () => {
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
          githubAlreadyResolved: true,
          threadId: "PRRT_closed",
        },
      ],
      signal: new AbortController().signal,
    });
    expect(items).toEqual([
      expect.objectContaining({
        fingerprint: "abc",
        status: "resolved",
        reason: "GitHub thread already resolved",
        threadId: "PRRT_closed",
        githubAlreadyResolved: true,
      }),
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

describe("thread findings carry anchored hunks", () => {
  it("derives the hunk for posted threads from the job diff", () => {
    const store = new JobStore(openDb(":memory:"));
    const job = {
      id: 9,
      repo_full_name: "acme/widgets",
      pr_number: 3,
      installation_id: 1,
      head_sha: "sha123",
      pr_html_url: "https://github.com/acme/widgets/pull/3",
    } as unknown as JobRow;
    const marker = findingMarker("fpthread00001", "sha123");
    const threads: ReviewThread[] = [
      {
        id: "PRRT_1",
        isResolved: false,
        path: "src/leak.ts",
        line: 4,
        comments: [{ id: "c1", databaseId: 5, body: `${marker}\n**high**: leak`, path: "src/leak.ts", line: 4 }],
      },
    ];
    const diff = `diff --git a/src/leak.ts b/src/leak.ts
--- a/src/leak.ts
+++ b/src/leak.ts
@@ -1,5 +1,6 @@
 const a = 1;
+console.log(secret);
 const b = 2;
 const c = 3;
 const d = 4;
 const e = 5;`;
    persistThreadsAsFindings({ store, job, threads, postedFingerprints: ["fpthread00001"], diff });
    const row = store.listFindings("acme/widgets", 3)[0];
    expect(row?.diff_hunk).toContain("console.log(secret);");
    expect(row?.diff_hunk?.startsWith("@@")).toBe(true);
    expect(row?.diff_note).toBeNull();
  });
});

describe("marker hygiene and resolve retries", () => {
  const job = {
    id: 9,
    repo_full_name: "acme/widgets",
    pr_number: 3,
    installation_id: 1,
    head_sha: "sha123",
    pr_html_url: "https://github.com/acme/widgets/pull/3",
  } as unknown as JobRow;

  it("isolates resolve failures per thread and reports them", async () => {
    const resolved: string[] = [];
    const github = {
      resolveReviewThread: async (_installationId: number, threadId: string) => {
        if (threadId === "PRRT_bad") throw new Error("Resource not accessible by integration");
        resolved.push(threadId);
      },
    };
    const snapshot = {
      headSha: "sha123",
      items: [
        {
          fingerprint: "fpbad00000000001",
          status: "resolved" as const,
          confidence: 0.9,
          reason: "gone",
          summary: "a",
          threadId: "PRRT_bad",
        },
        {
          fingerprint: "fpgood0000000001",
          status: "resolved" as const,
          confidence: 0.9,
          reason: "gone",
          summary: "b",
          threadId: "PRRT_good",
        },
      ],
    };
    const applied = await applyReconciliationThreads({ github: github as never, job, snapshot });
    // The bad thread id did not abort the loop.
    expect(resolved).toEqual(["PRRT_good"]);
    expect(applied.resolved).toEqual(["fpgood0000000001"]);
    expect(applied.failed).toEqual([
      { fingerprint: "fpbad00000000001", reason: expect.stringContaining("GitHub App lacks permission") },
    ]);
  });

  it("treats a vanished GitHub thread as nothing left to resolve instead of a retryable failure", async () => {
    const github = {
      resolveReviewThread: async () => {
        throw Object.assign(new Error("Request failed due to following response errors:\n - hidden"), {
          errors: [
            {
              type: "NOT_FOUND",
              message: "Could not resolve to a node with the global id of 'PRRT_gone'",
            },
          ],
        });
      },
    };
    const snapshot = {
      headSha: "sha123",
      items: [
        {
          fingerprint: "fpgone00000000001",
          status: "resolved" as const,
          confidence: 0.9,
          reason: "gone",
          summary: "a",
          threadId: "PRRT_gone",
        },
      ],
    };
    const applied = await applyReconciliationThreads({ github: github as never, job, snapshot });
    expect(applied.resolved).toEqual([]);
    expect(applied.failed).toEqual([]);
    expect(applied.skipped).toEqual([
      {
        fingerprint: "fpgone00000000001",
        wantedClose: true,
        reason: "GitHub thread PRRT_gone no longer exists; nothing left to resolve",
      },
    ]);
  });

  it("persists thread-derived summaries without markers or severity prefixes", () => {
    const store = new JobStore(openDb(":memory:"));
    const marker = findingMarker("fpdirty000000001", "sha123");
    const threads: ReviewThread[] = [
      {
        id: "PRRT_dirty",
        isResolved: false,
        path: "src/a.ts",
        line: 2,
        comments: [
          {
            id: "c1",
            databaseId: 7,
            body: `${marker}\n**info**: secret logged\n\nevidence paragraph`,
            path: "src/a.ts",
            line: 2,
          },
        ],
      },
    ];
    persistThreadsAsFindings({ store, job, threads, postedFingerprints: ["fpdirty000000001"], diff: undefined });
    const row = store.listFindings("acme/widgets", 3)[0];
    expect(row?.summary).toBe("secret logged");
    expect(row?.summary).not.toContain("<!--");
    expect(row?.summary).not.toContain("**info**:");
  });

  it("strips hidden markers from persisted finding bodies", () => {
    const store = new JobStore(openDb(":memory:"));
    persistClassifications(
      store,
      job,
      [
        {
          fingerprint: "fpbody00000000001",
          status: "still_valid",
          confidence: 0.9,
          reason: "unchanged",
          summary: "secret logged",
          body: "evidence <!-- maomao-finding id=x sha=y --> more",
        },
      ],
      undefined,
    );
    const row = store.listFindings("acme/widgets", 3)[0];
    expect(row?.body).not.toContain("<!--");
    expect(row?.body).toContain("evidence");
    expect(row?.body).toContain("more");
  });

  it("does not call resolveReviewThread for a GitHub-already-resolved classification", async () => {
    const resolved: string[] = [];
    const applied = await applyReconciliationThreads({
      github: {
        resolveReviewThread: async (_installationId: number, threadId: string) => {
          resolved.push(threadId);
        },
      } as never,
      job,
      snapshot: {
        headSha: "sha123",
        items: [
          {
            fingerprint: "fpalready00000001",
            status: "resolved",
            confidence: 1,
            reason: "GitHub thread already resolved",
            summary: "gone",
            threadId: "PRRT_already",
            githubAlreadyResolved: true,
          },
        ],
      },
    });
    expect(resolved).toEqual([]);
    expect(applied.resolved).toEqual([]);
    expect(applied.skipped).toEqual([
      expect.objectContaining({ fingerprint: "fpalready00000001", wantedClose: false }),
    ]);
  });

  it("explains when a resolved finding cannot be closed because the thread id is missing", async () => {
    const applied = await applyReconciliationThreads({
      github: { resolveReviewThread: async () => {} } as never,
      job,
      snapshot: {
        headSha: "sha123",
        items: [
          {
            fingerprint: "fpnothread000001",
            status: "resolved",
            confidence: 0.9,
            reason: "gone",
            summary: "gone",
          },
        ],
      },
    });
    expect(applied.skipped).toEqual([
      expect.objectContaining({
        fingerprint: "fpnothread000001",
        wantedClose: true,
        reason: expect.stringContaining("no GitHub thread id"),
      }),
    ]);
  });

  it("attaches a stored thread id before resolve so later jobs can close GitHub", async () => {
    const store = new JobStore(openDb(":memory:"));
    store.upsertFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      fingerprint: "fpattach000000001",
      status: "resolved",
      reviewedSha: "sha123",
      summary: "gone",
      githubThreadId: "PRRT_from_db",
    });
    const snapshot = attachStoredThreadIds(store, job, {
      headSha: "sha123",
      items: [
        {
          fingerprint: "fpattach000000001",
          status: "resolved",
          confidence: 0.9,
          reason: "gone",
          summary: "gone",
        },
      ],
    });
    expect(snapshot.items[0]?.threadId).toBe("PRRT_from_db");
  });

  it("persists a GitHub-resolved thread as resolved even when SQLite still says open", () => {
    const store = new JobStore(openDb(":memory:"));
    store.upsertFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      fingerprint: "fpcatch000000001",
      status: "open",
      reviewedSha: "old",
      summary: "leak",
    });
    const marker = findingMarker("fpcatch000000001", "old");
    persistThreadsAsFindings({
      store,
      job,
      threads: [
        {
          id: "PRRT_caught",
          isResolved: true,
          comments: [{ id: "c1", databaseId: 8, body: `${marker}\n**high**: leak`, path: "src/a.ts", line: 2 }],
        },
      ],
      postedFingerprints: [],
    });
    const row = store.getFinding(job.repo_full_name, job.pr_number, "fpcatch000000001");
    expect(row?.status).toBe("resolved");
    expect(row?.github_thread_id).toBe("PRRT_caught");
    expect(row?.reconciliation_reason).toBe("GitHub thread already resolved");
  });

  it("does not re-attach a republished fingerprint to the already-resolved old thread", () => {
    const store = new JobStore(openDb(":memory:"));
    const fingerprint = "fprepub0000000001";
    const marker = findingMarker(fingerprint, "sha123");
    persistThreadsAsFindings({
      store,
      job,
      threads: [
        {
          id: "PRRT_new",
          isResolved: false,
          comments: [{ id: "c-new", databaseId: 21, body: `${marker}\n**high**: leak`, path: "src/a.ts", line: 2 }],
        },
        {
          id: "PRRT_old",
          isResolved: true,
          comments: [{ id: "c-old", databaseId: 20, body: `${marker}\n**high**: leak`, path: "src/a.ts", line: 2 }],
        },
      ],
      postedFingerprints: [fingerprint],
    });
    const row = store.getFinding(job.repo_full_name, job.pr_number, fingerprint);
    expect(row?.status).toBe("open");
    expect(row?.github_thread_id).toBe("PRRT_new");
    expect(row?.github_comment_id).toBe("21");
  });
});

describe("scan issue close guards", () => {
  const job = {
    id: 4,
    installation_id: 1,
    repo_full_name: "acme/widgets",
    repo_owner: "acme",
    repo_name: "widgets",
    pr_number: 0,
    head_sha: "scanhead",
  } as unknown as JobRow;

  it("closes a Maomao-marked issue and refuses unmarked or pull-request numbers", async () => {
    const store = new JobStore(openDb(":memory:"));
    store.recordScanIssue({
      jobId: job.id,
      repoFullName: job.repo_full_name,
      fingerprint: "fpclose0000000001",
      issueNumber: 12,
      issueUrl: "https://github.com/acme/widgets/issues/12",
      title: "leak",
    });
    store.recordScanIssue({
      jobId: job.id,
      repoFullName: job.repo_full_name,
      fingerprint: "fphuman0000000001",
      issueNumber: 13,
      issueUrl: "https://github.com/acme/widgets/issues/13",
      title: "human",
    });
    store.recordScanIssue({
      jobId: job.id,
      repoFullName: job.repo_full_name,
      fingerprint: "fppr0000000000001",
      issueNumber: 14,
      issueUrl: "https://github.com/acme/widgets/pull/14",
      title: "pr",
    });
    const closed: number[] = [];
    const result = await closeResolvedScanIssues({
      store,
      job,
      github: {
        getIssue: async (_id: number, _owner: string, _repo: string, number: number) => {
          if (number === 12) {
            return {
              number: 12,
              title: "leak",
              body: `${scanIssueMarkerBase("fpclose0000000001")} @ scanhead -->\n\nleak`,
              state: "open",
              url: "https://github.com/acme/widgets/issues/12",
              isPullRequest: false,
            };
          }
          if (number === 13) {
            return {
              number: 13,
              title: "human",
              body: "please fix",
              state: "open",
              url: "https://github.com/acme/widgets/issues/13",
              isPullRequest: false,
            };
          }
          return {
            number: 14,
            title: "pr",
            body: `${scanIssueMarkerBase("fppr0000000000001")} @ scanhead -->`,
            state: "open",
            url: "https://github.com/acme/widgets/pull/14",
            isPullRequest: true,
          };
        },
        closeIssue: async (_id: number, _owner: string, _repo: string, number: number) => {
          closed.push(number);
        },
      } as never,
      items: [
        { fingerprint: "fpclose0000000001", status: "resolved", confidence: 1, reason: "gone", summary: "leak" },
        { fingerprint: "fphuman0000000001", status: "resolved", confidence: 1, reason: "gone", summary: "human" },
        { fingerprint: "fppr0000000000001", status: "resolved", confidence: 1, reason: "gone", summary: "pr" },
        { fingerprint: "fpnone00000000001", status: "resolved", confidence: 1, reason: "gone", summary: "none" },
      ],
    });
    expect(closed).toEqual([12]);
    expect(result.closed).toEqual(["fpclose0000000001"]);
    expect(result.skipped.map((item) => item.reason).join("\n")).toContain("missing the Maomao scan marker");
    expect(result.skipped.map((item) => item.reason).join("\n")).toContain("refusing to close pull request");
    expect(result.skipped.map((item) => item.reason).join("\n")).toContain("no Maomao GitHub issue linked");
  });

  function recordIssue(store: JobStore, fingerprint: string, issueNumber: number): void {
    store.recordScanIssue({
      jobId: job.id,
      repoFullName: job.repo_full_name,
      fingerprint,
      issueNumber,
      issueUrl: `https://github.com/acme/widgets/issues/${issueNumber}`,
      title: "leak",
    });
  }

  function resolvedItem(fingerprint: string) {
    return { fingerprint, status: "resolved" as const, confidence: 1, reason: "gone", summary: "leak" };
  }

  it("skips already-closed, missing, and capability-less issues and records thrown close errors", async () => {
    const store = new JobStore(openDb(":memory:"));
    recordIssue(store, "fpalready00000001", 20);
    recordIssue(store, "fpclosednomark001", 21);
    recordIssue(store, "fpmissing00000001", 22);
    recordIssue(store, "fpthrown000000001", 23);
    recordIssue(store, "fpnocap0000000001", 24);
    const closed: number[] = [];
    const result = await closeResolvedScanIssues({
      store,
      job,
      github: {
        getIssue: async (_id: number, _owner: string, _repo: string, number: number) => {
          if (number === 20) {
            return {
              number: 20,
              title: "leak",
              body: `${scanIssueMarkerBase("fpalready00000001")} @ scanhead -->\n\nleak`,
              state: "closed",
              url: "https://github.com/acme/widgets/issues/20",
              isPullRequest: false,
            };
          }
          if (number === 21) {
            return {
              number: 21,
              title: "edited",
              body: "human edited the marker out",
              state: "closed",
              url: "https://github.com/acme/widgets/issues/21",
              isPullRequest: false,
            };
          }
          if (number === 22) return undefined;
          return {
            number: 23,
            title: "leak",
            body: `${scanIssueMarkerBase("fpthrown000000001")} @ scanhead -->\n\nleak`,
            state: "open",
            url: "https://github.com/acme/widgets/issues/23",
            isPullRequest: false,
          };
        },
        closeIssue: async (_id: number, _owner: string, _repo: string, number: number) => {
          closed.push(number);
          throw new Error("GitHub 502");
        },
      } as never,
      items: [
        resolvedItem("fpalready00000001"),
        resolvedItem("fpclosednomark001"),
        resolvedItem("fpmissing00000001"),
        resolvedItem("fpthrown000000001"),
      ],
    });
    expect(closed).toEqual([23]);
    expect(result.closed).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fingerprint: "fpalready00000001",
          wantedClose: false,
          reason: expect.stringContaining("already closed"),
        }),
        expect.objectContaining({
          fingerprint: "fpclosednomark001",
          wantedClose: false,
          reason: expect.stringContaining("already closed"),
        }),
        expect.objectContaining({
          fingerprint: "fpmissing00000001",
          wantedClose: true,
          reason: expect.stringContaining("was not found"),
        }),
      ]),
    );
    expect(result.failed).toEqual([{ fingerprint: "fpthrown000000001", reason: "GitHub 502" }]);

    const noCap = await closeResolvedScanIssues({
      store,
      job,
      github: {} as never,
      items: [resolvedItem("fpnocap0000000001")],
    });
    expect(noCap.skipped).toEqual([
      expect.objectContaining({
        fingerprint: "fpnocap0000000001",
        wantedClose: true,
        reason: "GitHub client cannot close issues",
      }),
    ]);
  });
});

