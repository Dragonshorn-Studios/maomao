import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { ForgeRegistry } from "../forge/registry.js";
import { authorizeGithubTarget } from "../github/authorize.js";
import type { ForgeCheckConclusion, ForgeCheckState, ForgeVerdict } from "../forge/types.js";
import { forgeTargetOf } from "../forge/types.js";
import type { CheckPublicationKey, JobRow, JobStore } from "../jobs/store.js";

export const REVIEW_CHECK_NAME = "maomao/review";

export type ReviewCheckInput = ForgeCheckState & {
  stage?: string;
  title?: string;
  summary?: string;
  /** Non-cancelled completed publications revalidate the live PR head before publishing a result. */
  validateHead?: boolean;
};

function keyFor(job: JobRow): CheckPublicationKey {
  return {
    provider: job.provider,
    providerInstance: job.provider_instance,
    repoFullName: job.repo_full_name,
    prNumber: job.pr_number,
    headSha: job.head_sha,
    name: REVIEW_CHECK_NAME,
  };
}

function externalIdFor(job: JobRow): string {
  const digest = createHash("sha256")
    .update(
      [
        job.provider,
        job.provider_instance,
        job.repo_full_name,
        String(job.pr_number),
        job.head_sha,
        REVIEW_CHECK_NAME,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
  return `maomao-review-${digest}`;
}

function defaultTitle(input: ReviewCheckInput): string {
  if (input.status === "queued") return "Maomao review queued";
  if (input.status === "in_progress") return `Maomao review ${input.stage ?? "in progress"}`;
  if (input.conclusion === "success") return "Maomao review passed";
  if (input.conclusion === "failure") return "Maomao review failed";
  if (input.conclusion === "cancelled") return "Maomao review cancelled";
  if (input.conclusion === "timed_out") return "Maomao review timed out";
  return "Maomao review completed";
}

function defaultSummary(job: JobRow, input: ReviewCheckInput): string {
  const sha = job.head_sha.slice(0, 12);
  if (input.status === "queued") return `Maomao queued a review for PR #${job.pr_number} at ${sha}.`;
  if (input.status === "in_progress") return `Maomao is reviewing PR #${job.pr_number} at ${sha}.`;
  return `Maomao finished processing PR #${job.pr_number} at ${sha}.`;
}

/** Terminal job state → native-check conclusion for the existing human review result. */
export function reviewConclusionForJob(job: JobRow, reviewIsClean = false, reviewEvent?: ForgeVerdict): ForgeCheckConclusion {
  if (job.state === "completed") {
    const event = reviewEvent ?? job.review_event;
    if (event === "REQUEST_CHANGES") return "failure";
    if (event === "APPROVE" || reviewIsClean) return "success";
    return "neutral";
  }
  if (job.state === "stale" || job.state === "cancelled") return "cancelled";
  if ((job.failure_reason ?? "").toLowerCase().includes("timed out")) return "timed_out";
  return "failure";
}

/**
 * Ordered, best-effort publisher for the existing review lifecycle. Publication
 * failures are persisted and logged but never change the review outcome: Checks
 * are a visibility layer over the review pipeline, not a reason to rerun or
 * discard valid reviewer work.
 */
export class ReviewCheckPublisher {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      store: JobStore;
      forge: ForgeRegistry;
      config: Config;
      publicUrl?: string;
    },
  ) {}

  publish(job: JobRow, input: ReviewCheckInput): Promise<void> {
    if (job.job_type !== "pr_review" || job.pr_number <= 0) return Promise.resolve();
    const key = keyFor(job);
    const chainKey = [
      key.provider,
      key.providerInstance,
      key.repoFullName,
      key.prNumber,
      key.headSha,
      key.name,
    ].join(":");
    const previous = this.chains.get(chainKey) ?? Promise.resolve();
    const next = previous.then(() => this.publishNow(job, input)).catch((error: unknown) => {
      console.warn(
        `checks: unexpected ${key.name} publication failure for ${key.repoFullName}#${key.prNumber}@${key.headSha.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.chains.set(chainKey, next);
    void next.finally(() => {
      if (this.chains.get(chainKey) === next) this.chains.delete(chainKey);
    });
    return next;
  }

  publishQueuedJobId(jobId: number): Promise<void> {
    const job = this.deps.store.getJob(jobId);
    if (!job || job.state !== "queued") return Promise.resolve();
    return this.publish(job, { status: "queued" });
  }

  publishCancelledJobId(jobId: number): Promise<void> {
    const job = this.deps.store.getJob(jobId);
    if (!job) return Promise.resolve();
    return this.publish(job, {
      status: "completed",
      conclusion: "cancelled",
      title: "Maomao review cancelled",
      summary: `Maomao cancelled the review for PR #${job.pr_number} at ${job.head_sha.slice(0, 12)}.`,
      validateHead: false,
    });
  }

  private async publishNow(job: JobRow, input: ReviewCheckInput): Promise<void> {
    const key = keyFor(job);
    const detailsUrl = this.detailsUrl(job);
    let effective = input;
    if (job.provider === "github") {
      const auth = authorizeGithubTarget(this.deps.config, {
        installationId: job.installation_id,
        accountId: job.github_account_id ?? undefined,
        repositoryId: job.github_repository_id ?? undefined,
      });
      if (!auth.ok) {
        this.deps.store.log(job.id, `Not publishing ${REVIEW_CHECK_NAME}: unauthorized: ${auth.reason}`, "warn");
        return;
      }
    }
    let provider;
    try {
      provider = this.deps.forge.forJob(job);
    } catch (error) {
      this.deps.store.log(
        job.id,
        `Could not publish ${REVIEW_CHECK_NAME}: forge unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      );
      return;
    }
    if (!provider.publishCheck || provider.supportsNativeChecks?.() === false) return;

    if (input.status === "completed" && input.validateHead !== false && input.conclusion !== "cancelled") {
      try {
        const change = await provider.getChange(forgeTargetOf(job));
        if (change.headSha !== job.head_sha) {
          effective = {
            ...input,
            conclusion: "cancelled",
            title: "Maomao review superseded",
            summary: `The pull request head moved before this result was published; this check is cancelled for ${job.head_sha.slice(0, 12)}.`,
          };
        }
      } catch (error) {
        // Never publish a successful terminal state without revalidating the
        // immutable head it describes. The row records why publication did not
        // happen; a later retry/rerun can reconcile it.
        this.deps.store.beginCheckPublication({
          ...key,
          externalId: externalIdFor(job),
          jobId: job.id,
          status: input.status,
          ...(input.conclusion ? { conclusion: input.conclusion } : {}),
          title: input.title ?? defaultTitle(input),
          summary: input.summary ?? defaultSummary(job, input),
          ...(detailsUrl ? { detailsUrl } : {}),
        });
        const message = `head validation failed: ${error instanceof Error ? error.message : String(error)}`;
        this.deps.store.finishCheckPublication(key, { error: message.slice(0, 1000) });
        this.deps.store.log(job.id, `Could not publish ${REVIEW_CHECK_NAME}: ${message}`, "warn");
        return;
      }
    }

    const title = effective.title ?? defaultTitle(effective);
    const summary = effective.summary ?? defaultSummary(job, effective);
    this.deps.store.beginCheckPublication({
      ...key,
      externalId: externalIdFor(job),
      jobId: job.id,
      status: effective.status,
      ...(effective.conclusion ? { conclusion: effective.conclusion } : {}),
      title,
      summary,
      ...(detailsUrl ? { detailsUrl } : {}),
    });
    try {
      const state: ForgeCheckState =
        effective.status === "completed"
          ? { status: "completed", conclusion: effective.conclusion }
          : { status: effective.status };
      const result = await provider.publishCheck({
        target: forgeTargetOf(job),
        commitSha: job.head_sha,
        name: REVIEW_CHECK_NAME,
        externalId: externalIdFor(job),
        ...state,
        title,
        summary,
        ...(detailsUrl ? { detailsUrl } : {}),
      });
      this.deps.store.finishCheckPublication(key, {
        nativeId: result.id,
        ...(result.url ? { nativeUrl: result.url } : {}),
        published: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.finishCheckPublication(key, { error: message.slice(0, 1000) });
      this.deps.store.log(job.id, `Could not publish ${REVIEW_CHECK_NAME}: ${message}`, "warn");
    }
  }

  private detailsUrl(job: JobRow): string | undefined {
    const base = this.deps.publicUrl?.trim().replace(/\/+$/, "");
    return base ? `${base}/jobs/${job.id}` : undefined;
  }
}

export function reviewCheckInputForState(job: JobRow, reviewIsClean = false, reviewEvent?: ForgeVerdict): ReviewCheckInput {
  const conclusion = reviewConclusionForJob(job, reviewIsClean, reviewEvent);
  return {
    status: "completed",
    conclusion,
    ...(job.state === "failed"
      ? { title: "Maomao review failed", summary: "Maomao could not complete the review; see the job report for details." }
      : {}),
  };
}
