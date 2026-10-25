import type { Config } from "../config.js";
import { GITHUB_PROVIDER } from "../forge/types.js";
import type { JobStore, JobRow } from "../jobs/store.js";
import { maomaoBotLogins, type GithubPort } from "./client.js";

/** Named capability tier for the badge, following the StackCommentGithub precedent. */
export type QueueBadgeGithub = Pick<Partial<GithubPort>, "requestReviewers" | "getAppSlug">;

/** Bound on the whole badge attempt (slug lookup + installation token + POST). */
const BADGE_TIMEOUT_MS = 10_000;

/**
 * Opt-in queue badge: request the App bot as a reviewer on the pull request the
 * moment a review job is created, so GitHub's Reviewers sidebar shows the
 * review as pending while the job waits for a queue slot. Posting a *review*
 * later clears the request on GitHub's side — issue comments do not, so a
 * stack trigger's badge on the top PR clears only when the top member's own
 * review job posts a review, and otherwise stays pending. There is no removal
 * path here by design: a job that ends without posting leaves the request as
 * an honest "review still owed" signal.
 *
 * Best-effort by design: GitHub refuses some re-requests (a bot that already
 * reviewed, or the bot as PR author), and a refusal must never fail the
 * webhook, the enqueue, or the job. Every request attempt — success, refusal,
 * missing slug, timeout — lands in the job log; the disabled / non-GitHub /
 * port-unsupported skips are silent. Callers must gate this on the enqueue
 * result having created the job (duplicate deliveries would otherwise re-run).
 */
export async function registerQueuedReviewer(deps: {
  /** Structural minimum so server contexts holding a Partial<GithubPort> can pass their client. */
  github: QueueBadgeGithub;
  config: Config;
  store: JobStore;
  job: Pick<JobRow, "id" | "provider" | "installation_id" | "repo_owner" | "repo_name" | "pr_number">;
  /** Test seam for the whole-attempt bound. */
  timeoutMs?: number;
}): Promise<void> {
  const { github, config, store, job } = deps;
  if (!config.requestReviewerOnEnqueue) return;
  if (job.provider !== GITHUB_PROVIDER) return;
  if (typeof github.requestReviewers !== "function") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The octokit stack has no request timeout of its own (undici's is minutes),
    // so the whole attempt — slug lookup, installation token, POST — is raced
    // against a deadline and a timeout is treated like any other refusal.
    await Promise.race([
      requestBadge(deps),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${deps.timeoutMs ?? BADGE_TIMEOUT_MS}ms`)),
          deps.timeoutMs ?? BADGE_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      store.log(job.id, `Could not register as reviewer: ${message}`, "warn");
    } catch (logError) {
      // Even the compensating log can fail (SQLite lock, disk full, shutdown).
      // Degrade to stderr — never let a badge problem reject onto the caller,
      // which would strand the already-committed job without a dispatch.
      console.warn(
        `job ${job.id}: reviewer registration failed (${message}); job-log write also failed: ` +
          (logError instanceof Error ? logError.message : String(logError)),
      );
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestBadge(deps: {
  github: QueueBadgeGithub;
  config: Config;
  store: JobStore;
  job: Pick<JobRow, "id" | "installation_id" | "repo_owner" | "repo_name" | "pr_number">;
}): Promise<void> {
  const { github, config, store, job } = deps;
  const requestReviewers = github.requestReviewers;
  if (!requestReviewers) return;
  const slug = config.github.appSlug || (await github.getAppSlug?.()) || "";
  if (!slug) {
    store.log(job.id, "Could not register as reviewer: no app slug (set GITHUB_APP_SLUG)", "warn");
    return;
  }
  const [login] = maomaoBotLogins(slug);
  if (!login) {
    store.log(job.id, "Could not register as reviewer: could not build the bot login", "warn");
    return;
  }
  await requestReviewers({
    installationId: job.installation_id,
    owner: job.repo_owner,
    repo: job.repo_name,
    pullNumber: job.pr_number,
    reviewers: [login],
  });
  store.log(job.id, `Registered as reviewer ${login} on the pull request — review queued`);
}
