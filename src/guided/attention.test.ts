import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { GuidedAttentionStore } from "./attention.js";
import { GuidedReviewStore } from "./store.js";

const key = { provider: "github", instance: "github.com", repoFullName: "acme/widgets", prNumber: 12, headSha: "b".repeat(40) };
const actor = { actorProvider: "github", actorId: "1001" };

describe("GuidedAttentionStore", () => {
  it("records the first exact-SHA decision with actor, action, reason and timestamp; conflicting concurrent decisions lose", () => {
    const store = new GuidedAttentionStore(openDb(":memory:"));
    const first = store.recordDecision(actor, key, "delegate_to_maomao", "risk-review", "security-sensitive");
    expect(first.status).toBe("ok");
    expect(first.row).toMatchObject({ action: "delegate_to_maomao", actor_id: "1001", reason_tag: "risk-review", reason_detail: "security-sensitive", head_sha: key.headSha });
    expect(Date.parse(first.row.created_at)).toBeGreaterThan(0);
    expect(store.recordDecision(actor, key, "delegate_to_maomao", "risk-review", "security-sensitive").status).toBe("ok");
    expect(store.recordDecision(actor, key, "delegate_to_maomao", "risk-review", "changed-detail").status).toBe("conflict");
    const conflict = store.recordDecision({ actorProvider: "github", actorId: "2002" }, key, "review_myself", "policy");
    expect(conflict.status).toBe("conflict");
    expect(store.decisionFor(key)?.action).toBe("delegate_to_maomao");
    expect(store.decisionFor({ ...key, headSha: "c".repeat(40) })).toBeUndefined();
  });



  it("lets a substantive decision supersede an optional-profile skip without weakening first-writer conflicts", () => {
    const store = new GuidedAttentionStore(openDb(":memory:"));
    expect(store.recordDecision(actor, key, "skip_guided_review", "time-sensitive").status).toBe("ok");
    const replacement = store.recordDecision({ actorProvider: "github", actorId: "2002" }, key, "review_myself", "policy");
    expect(replacement.status).toBe("ok");
    expect(replacement.row).toMatchObject({ action: "review_myself", actor_id: "2002", reason_tag: "policy" });
    expect(store.recordDecision(actor, key, "delegate_to_maomao", "risk-review").status).toBe("conflict");
    expect(store.decisionFor(key)).toMatchObject({ action: "review_myself", actor_id: "2002" });
  });

  it("treats viewed files, draft content or comments as active review evidence, but not merely opening a tab", () => {
    const db = openDb(":memory:");
    new JobStore(db);
    const guided = new GuidedReviewStore(db);
    const attention = new GuidedAttentionStore(db);
    const opened = guided.open({ ...actor, provider: key.provider, instance: key.instance, repoFullName: key.repoFullName, prNumber: key.prNumber, baseSha: "a".repeat(40), headSha: key.headSha });
    expect(attention.hasActiveHumanReview(key)).toBe(false);
    guided.updateSession(opened.session.id, actor, opened.session.version, { viewedFiles: ["src/index.ts"] });
    expect(attention.hasActiveHumanReview(key)).toBe(true);
  });
});
