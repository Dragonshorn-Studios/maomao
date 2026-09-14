import { describe, expect, it } from "vitest";
import { findingMarker, fingerprintFinding, parseFindingMarker } from "./identity.js";
import { parseOverrideCommand } from "./commands.js";
import { acceptClassification, collectPriorFindings, findingsForPublish } from "./reconcile.js";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import type { ReviewThread } from "../github/client.js";

describe("finding identity", () => {
  it("is stable across line numbers but not path or category", () => {
    const base = { file: "src/auth.ts", category: "security", summary: "token compared with == " };
    const a = fingerprintFinding({ ...base, summary: "token compared with == on line 12" });
    const b = fingerprintFinding({ ...base, summary: "token compared with == on line 40" });
    expect(a).toBe(b);
    expect(fingerprintFinding({ ...base, file: "src/other.ts" })).not.toBe(a);
    expect(fingerprintFinding({ ...base, category: "correctness" })).not.toBe(a);
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
