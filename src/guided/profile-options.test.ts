import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { guidedReviewOptionsForSession } from "./profile-options.js";
import type { GuidedReviewSessionRow } from "./store.js";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function definition(model: string) {
  return {
    name: "default",
    reviewers: [{ role: "correctness" }],
    minPublishableSeverity: "info" as const,
    guidedReview: { model, poisonAlertAttention: "optional" as const },
  };
}

function session(): GuidedReviewSessionRow {
  return {
    provider: "github",
    provider_instance: "github.com",
    repo_full_name: "acme/widgets",
    pr_number: 12,
    head_sha: headSha,
  } as GuidedReviewSessionRow;
}

describe("guidedReviewOptionsForSession", () => {
  it("uses the exact-head job profile revision instead of a later active revision", () => {
    const db = openDb(":memory:");
    const store = new JobStore(db);
    const first = store.configs.createDraft({ definition: definition("test/original"), createdBy: "octocat" });
    if (!("revision" in first)) throw new Error("first revision failed");
    store.configs.activateRevision(first.revision.id, "octocat");
    store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: 12,
      prTitle: "risk",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha,
      headSha,
      baseRef: "main",
      headRef: "feature",
      reviewers: [],
      profileRevisionId: first.revision.id,
    });

    const second = store.configs.createDraft({ definition: definition("test/replacement"), createdBy: "octocat" });
    if (!("revision" in second)) throw new Error("second revision failed");
    store.configs.activateRevision(second.revision.id, "octocat");

    expect(store.configs.resolveProfileForRepo("acme/widgets")?.definition.guidedReview?.model).toBe("test/replacement");
    expect(guidedReviewOptionsForSession(store, "acme/widgets", session())?.model).toBe("test/original");
    expect(guidedReviewOptionsForSession(store, "acme/widgets")?.model).toBe("test/replacement");

    store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber: 13,
      prTitle: "legacy",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "dev",
      baseSha,
      headSha,
      baseRef: "main",
      headRef: "feature",
      reviewers: [],
    });
    db.prepare(`UPDATE jobs SET profile_revision_id = NULL WHERE pr_number = 13`).run();
    expect(guidedReviewOptionsForSession(store, "acme/widgets", { ...session(), pr_number: 13 })).toBeUndefined();
  });
});
