import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { GuidedInputError, GuidedReviewStore, type GuidedSessionKey } from "./store.js";

const actor = { actorProvider: "github", actorId: "1001" };

function key(overrides: Partial<GuidedSessionKey> = {}): GuidedSessionKey {
  return {
    ...actor,
    provider: "github",
    instance: "github.com",
    repoFullName: "acme/widgets",
    prNumber: 12,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    ...overrides,
  };
}

function store() {
  return new GuidedReviewStore(openDb(":memory:"));
}

describe("GuidedReviewStore", () => {
  it("keys sessions by actor, forge identity, PR and exact SHAs", () => {
    const guided = store();
    const first = guided.open(key());
    const same = guided.open(key());
    const otherActor = guided.open(key({ actorId: "2002" }));
    const otherForge = guided.open(key({ provider: "gitlab", instance: "gitlab.example.com" }));
    const otherHead = guided.open(key({ headSha: "c".repeat(40) }));

    expect(same.session.id).toBe(first.session.id);
    expect(otherActor.session.id).not.toBe(first.session.id);
    expect(otherForge.session.id).not.toBe(first.session.id);
    expect(otherHead.session.id).not.toBe(first.session.id);
    expect(otherHead.staleFrom?.id).toBe(first.session.id);
  });


  it("reactivates a previously seen exact-SHA session and supersedes the draft it replaces", () => {
    const guided = store();
    const first = guided.open(key());
    const second = guided.open(key({ headSha: "c".repeat(40) }));
    expect(guided.getOwned(first.session.id, actor)?.historical_at).toBeTruthy();

    const reopened = guided.open(key());
    expect(reopened.session.id).toBe(first.session.id);
    expect(reopened.session.historical_at).toBeNull();
    expect(reopened.staleFrom?.id).toBe(second.session.id);
    expect(guided.getOwned(second.session.id, actor)?.historical_at).toBeTruthy();
    const write = guided.updateSession(first.session.id, actor, reopened.session.version, { draftSummary: "current again" });
    expect(write.status).toBe("ok");

    const repeated = guided.open(key());
    expect(repeated.staleFrom).toBeUndefined();
  });

  it("copying into a previously seen target reactivates that target instead of leaving copied notes read-only", () => {
    const guided = store();
    const first = guided.open(key());
    const second = guided.open(key({ headSha: "c".repeat(40) }));
    const comment = guided.upsertComment(second.session.id, actor, second.session.version, {
      clientId: "note-1",
      kind: "general",
      body: "carry this forward",
    });
    expect(comment.status).toBe("ok");

    const copied = guided.copyToSha(second.session.id, actor, key().baseSha, key().headSha);
    expect(copied.status).toBe("ok");
    if (copied.status !== "ok") throw new Error("expected copy success");
    expect(copied.session.id).toBe(first.session.id);
    expect(copied.session.historical_at).toBeNull();
    expect(copied.copied).toBe(1);
    const write = guided.updateSession(first.session.id, actor, copied.session.version, { draftSummary: "copied target is writable" });
    expect(write.status).toBe("ok");
    expect(guided.getOwned(second.session.id, actor)?.historical_at).toBeTruthy();
  });

  it("updates drafts atomically with version conflicts and mutation idempotency", () => {
    const guided = store();
    const opened = guided.open(key());

    const updated = guided.updateSession(
      opened.session.id,
      actor,
      1,
      { draftSummary: "looks safe", draftVerdict: "COMMENT", viewedFiles: ["src/index.ts"] },
      "mutation-1",
    );
    expect(updated.status).toBe("ok");
    if (updated.status !== "ok") throw new Error("expected update success");
    expect(updated.session.version).toBe(2);
    expect(updated.session.draft_summary).toBe("looks safe");

    const replay = guided.updateSession(
      opened.session.id,
      actor,
      1,
      { draftSummary: "malicious overwrite" },
      "mutation-1",
    );
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") throw new Error("expected replay success");
    expect(replay.session.version).toBe(2);
    expect(replay.session.draft_summary).toBe("looks safe");

    const conflict = guided.updateSession(opened.session.id, actor, 1, { draftSummary: "other tab" }, "mutation-2");
    expect(conflict.status).toBe("conflict");
  });

  it("validates inline coordinates and rejects malformed paths", () => {
    const guided = store();
    const opened = guided.open(key());
    expect(() =>
      guided.upsertComment(opened.session.id, actor, 1, {
        clientId: "bad",
        kind: "inline",
        body: "bad coordinate",
        path: "src/index.ts",
      }),
    ).toThrow(GuidedInputError);
    expect(() =>
      guided.upsertComment(opened.session.id, actor, 1, {
        clientId: "bad-path",
        kind: "inline",
        body: "bad path",
        path: "../secret",
        side: "RIGHT",
        line: 2,
      }),
    ).toThrow(GuidedInputError);

    const valid = guided.upsertComment(opened.session.id, actor, 1, {
      clientId: "note-1",
      kind: "inline",
      body: "check this branch",
      path: "src/index.ts",
      side: "RIGHT",
      line: 12,
      severity: "medium",
      publishable: true,
      mutationId: "comment-1",
    });
    expect(valid.status).toBe("ok");
    if (valid.status !== "ok" || !valid.comment) throw new Error("expected comment success");
    expect(valid.comment.path).toBe("src/index.ts");
    expect(valid.comment.publishable).toBe(1);
    expect(valid.session.version).toBe(2);
  });

  it("preserves old-SHA drafts as historical and copies inline notes as unplaced", () => {
    const guided = store();
    const opened = guided.open(key());
    const comment = guided.upsertComment(opened.session.id, actor, 1, {
      clientId: "note-1",
      kind: "inline",
      body: "ask about this",
      path: "src/index.ts",
      side: "RIGHT",
      line: 12,
      publishable: true,
    });
    expect(comment.status).toBe("ok");
    const general = guided.upsertComment(opened.session.id, actor, 2, {
      clientId: "general-1",
      kind: "general",
      body: "overall concern",
    });
    expect(general.status).toBe("ok");

    const nextHead = "c".repeat(40);
    const copied = guided.copyToSha(opened.session.id, actor, "a".repeat(40), nextHead);
    expect(copied.status).toBe("ok");
    if (copied.status !== "ok") throw new Error("expected copy success");
    expect(copied.copied).toBe(2);

    const source = guided.getOwned(opened.session.id, actor);
    expect(source?.historical_at).toBeTruthy();
    const copiedComments = guided.listComments(copied.session.id);
    expect(copiedComments).toHaveLength(2);
    const inline = copiedComments.find((row) => row.kind === "inline");
    const note = copiedComments.find((row) => row.kind === "general");
    expect(inline?.anchor_status).toBe("unplaced");
    expect(inline?.publishable).toBe(0);
    expect(note?.anchor_status).toBe("anchored");

    const copiedAgain = guided.copyToSha(opened.session.id, actor, "a".repeat(40), nextHead);
    expect(copiedAgain.status).toBe("ok");
    if (copiedAgain.status !== "ok") throw new Error("expected repeated copy success");
    expect(copiedAgain.copied).toBe(0);
    expect(guided.listComments(copied.session.id)).toHaveLength(2);
  });

  it("bounds retained superseded sessions per actor", () => {
    const db = openDb(":memory:");
    const guided = new GuidedReviewStore(db);
    let head = "1".repeat(40);
    guided.open(key({ headSha: head }));
    for (let index = 0; index < 205; index += 1) {
      head = (index + 2).toString(16).padStart(40, "0");
      guided.open(key({ headSha: head }));
    }
    const count = (
      db
        .prepare(`SELECT COUNT(*) AS count FROM guided_review_sessions WHERE actor_provider = 'github' AND actor_id = '1001'`)
        .get() as { count: number }
    ).count;
    expect(count).toBeLessThanOrEqual(200);
  });

  it("keeps one operator from reading another operator's draft", () => {
    const guided = store();
    const opened = guided.open(key());
    expect(guided.getOwned(opened.session.id, { actorProvider: "github", actorId: "2002" })).toBeUndefined();
    const outcome = guided.updateSession(
      opened.session.id,
      { actorProvider: "github", actorId: "2002" },
      1,
      { draftSummary: "not mine" },
    );
    expect(outcome.status).toBe("not_found");
  });
});
