import type { ProfileDefinition } from "../config-revisions.js";
import type { JobStore } from "../jobs/store.js";
import type { GuidedReviewSessionRow } from "./store.js";

/** Resolve guided generation options from the exact-head job revision when present, or the active repository profile before any exact-head job exists. */
export function guidedReviewOptionsForSession(store: JobStore, repoFullName: string, session?: GuidedReviewSessionRow): ProfileDefinition["guidedReview"] {
  const job = session
    ? store.reviewJobForComparison(repoFullName, session.pr_number, session.head_sha, { provider: session.provider, instance: session.provider_instance })
    : undefined;
  if (job) return job.profile_revision_id ? store.configs.getRevision(job.profile_revision_id)?.definition.guidedReview : undefined;
  return store.configs.resolveProfileForRepo(repoFullName)?.definition.guidedReview;
}
