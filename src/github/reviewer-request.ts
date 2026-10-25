import type { Config } from "../config.js";
import type { JobStore } from "../jobs/store.js";
import type { JobRow } from "../jobs/store.js";
import { maomaoBotLogins, type GithubPort } from "./client.js";

/**
 * Opt-in queue badge: request the App bot as a reviewer on the pull request the
 * moment a review job is created, so GitHub's Reviewers sidebar shows the
 * review as pending while the job waits for a queue slot. Posting any review
 * later clears the request on GitHub's side — there is no cleanup path here.
 *
 * Best-effort by design: GitHub refuses some re-requests (a bot that already
 * reviewed, or the bot as PR author), and a refusal must never fail the
 * webhook, the enqueue, or the job. Every outcome lands in the job log.
 */
export async function registerQueuedReviewer(deps: {
  /** Structural minimum so server contexts holding a Partial<GithubPort> can pass their client. */
  github: Pick<Partial<GithubPort>, "requestReviewers" | "getAppSlug">;
  config: Config;
  store: JobStore;
  job: Pick<JobRow, "id" | "provider" | "installation_id" | "repo_owner" | "repo_name" | "pr_number">;
}): Promise<void> {
  const { github, config, store, job } = deps;
  if (!config.requestReviewerOnEnqueue) return;
  if (job.provider !== "github") return;
  if (typeof github.requestReviewers !== "function") return;
  try {
    const slug = config.github.appSlug || (await github.getAppSlug?.()) || "";
    if (!slug) {
      store.log(job.id, "Could not register as reviewer: no app slug (set GITHUB_APP_SLUG)", "warn");
      return;
    }
    const login = maomaoBotLogins(slug)[0]!;
    await github.requestReviewers({
      installationId: job.installation_id,
      owner: job.repo_owner,
      repo: job.repo_name,
      pullNumber: job.pr_number,
      reviewers: [login],
    });
    store.log(job.id, `Registered as reviewer ${login} on the pull request — review queued`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.log(job.id, `Could not register as reviewer: ${message}`, "warn");
  }
}
