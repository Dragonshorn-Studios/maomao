import type { Config } from "../config.js";
import type { GithubPort } from "../github/client.js";
import { enumerateGithubInstallationRepositories } from "../github/enumerate.js";
import type { JobStore } from "../jobs/store.js";
import type { GuidedActor } from "./store.js";
import type { ForgeConnectionStore } from "../forge/connections.js";

export const GUIDED_INBOX_PAGE_SIZE = 25;

export interface GuidedInboxItem {
  provider: string;
  providerInstance: string;
  repoFullName: string;
  prNumber: number;
  title: string;
  author: string;
  url: string;
  baseSha: string;
  headSha: string;
  draft: boolean;
  updatedAt?: string;
  reviewRequested?: boolean;
  maomaoJobId?: number;
  maomaoState?: string;
  guidedSessionId?: number;
  guidedState?: "none" | "current" | "stale" | "historical";
  guidedCommentCount?: number;
}

export interface GuidedInboxFilters {
  repo?: string;
  author?: string;
  reviewState?: string;
  maomaoState?: string;
  offset?: number;
}

export interface GuidedInboxPage {
  items: GuidedInboxItem[];
  total: number;
  offset: number;
  limit: number;
  repos: string[];
  errors: string[];
  unsupported: string[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  }));
  return out;
}

/** Deliberate operator-initiated reconciliation used to backfill or repair the webhook cache; normal inbox reads never call it. */
export async function refreshGuidedInbox(input: {
  config: Config;
  store: JobStore;
  github?: Partial<GithubPort>;
}): Promise<{ repos: number; pulls: number; errors: string[] }> {
  if (!input.github?.listAppInstallations || !input.github.listInstallationRepositories || !input.github.listOpenPulls) {
    return { repos: 0, pulls: 0, errors: ["GitHub open-pull synchronization is unavailable with the configured client."] };
  }
  const github = input.github;
  const errors: string[] = [];
  let pulls = 0;
  let repos: Awaited<ReturnType<typeof enumerateGithubInstallationRepositories>> = [];
  try {
    repos = await enumerateGithubInstallationRepositories(input.github as Pick<GithubPort, "listAppInstallations" | "listInstallationRepositories">, input.config, "guided inbox sync");
  } catch (error) {
    return { repos: 0, pulls: 0, errors: [`Could not enumerate installation repositories: ${error instanceof Error ? error.message : String(error)}`] };
  }
  await mapLimit(repos, 4, async (repo) => {
    const slash = repo.fullName.indexOf("/");
    const owner = repo.fullName.slice(0, slash);
    const name = repo.fullName.slice(slash + 1);
    try {
      const openPulls = await github.listOpenPulls!(repo.installationId, owner, name);
      for (const pull of openPulls) {
        input.store.upsertGuidedInboxPull({
          installationId: pull.installationId,
          githubAccountId: pull.accountId,
          githubRepositoryId: pull.repositoryId,
          repoFullName: repo.fullName,
          prNumber: pull.prNumber,
          prTitle: pull.prTitle,
          prHtmlUrl: pull.prHtmlUrl,
          prAuthor: pull.prAuthor,
          baseSha: pull.baseSha,
          headSha: pull.headSha,
          draft: pull.draft,
          state: pull.state ?? "open",
          pullUpdatedAt: pull.updatedAt,
          reviewRequested: pull.requestedReviewers === undefined ? undefined : pull.requestedReviewers.length > 0,
        });
      }
      input.store.closeMissingGuidedInboxPulls(repo.fullName, openPulls.map((pull) => pull.prNumber));
      pulls += openPulls.length;
    } catch (error) {
      errors.push(`${repo.fullName}: synchronization failed (${error instanceof Error ? error.message : String(error)})`);
    }
  });
  return { repos: repos.length, pulls, errors };
}

/** Webhook-backed open-PR inbox. Reading the inbox must not fan out to GitHub for every installed repository. */
export async function listGuidedInbox(input: {
  config: Config;
  store: JobStore;
  github?: Partial<GithubPort>;
  forgeConnections?: ForgeConnectionStore;
  actor?: GuidedActor;
  filters?: GuidedInboxFilters;
}): Promise<GuidedInboxPage> {
  const unsupported: string[] = [];
  for (const connection of input.forgeConnections?.list().filter((row) => row.enabled === 1) ?? []) {
    unsupported.push(`${connection.provider} connection "${connection.label}" cannot list open pull requests for Guided Review yet.`);
  }
  const filters = input.filters ?? {};
  const rows = input.store.listGuidedInboxPulls().filter((pull) => {
    if (input.config.allowedGithubAccountIds.length > 0 && (pull.github_account_id == null || !input.config.allowedGithubAccountIds.includes(pull.github_account_id))) return false;
    if (input.config.allowedGithubRepositoryIds.length > 0 && (pull.github_repository_id == null || !input.config.allowedGithubRepositoryIds.includes(pull.github_repository_id))) return false;
    return true;
  });
  let items = rows.map((pull): GuidedInboxItem => {
    const latestJob = input.store.findLatestJobForPull(pull.repo_full_name, pull.pr_number, undefined, { provider: pull.provider, instance: pull.provider_instance });
    const session = input.actor
      ? input.store.guidedReview.latestForPull(input.actor, pull.provider, pull.provider_instance, pull.repo_full_name, pull.pr_number)
      : undefined;
    const guidedState = !session
      ? "none"
      : session.historical_at
        ? "historical"
        : session.base_sha === pull.base_sha && session.head_sha === pull.head_sha
          ? "current"
          : "stale";
    return {
      provider: pull.provider,
      providerInstance: pull.provider_instance,
      repoFullName: pull.repo_full_name,
      prNumber: pull.pr_number,
      title: pull.title || `Pull request #${pull.pr_number}`,
      author: pull.author,
      url: pull.url,
      baseSha: pull.base_sha,
      headSha: pull.head_sha,
      draft: pull.draft === 1,
      updatedAt: pull.pull_updated_at ?? pull.updated_at,
      reviewRequested: pull.review_requested == null ? undefined : pull.review_requested === 1,
      maomaoJobId: latestJob?.id,
      maomaoState: latestJob?.state,
      guidedSessionId: session?.id,
      guidedState,
      guidedCommentCount: session ? input.store.guidedReview.activeCommentCount(session.id) : undefined,
    };
  });

  if (filters.repo) items = items.filter((item) => item.repoFullName === filters.repo);
  const author = filters.author?.trim().toLowerCase();
  if (author) items = items.filter((item) => item.author.toLowerCase().includes(author));
  if (filters.reviewState && filters.reviewState !== "all") {
    items = items.filter((item) =>
      filters.reviewState === "requested" ? item.reviewRequested === true
        : filters.reviewState === "unrequested" ? item.reviewRequested === false
        : filters.reviewState === "unknown" ? item.reviewRequested === undefined
        : true,
    );
  }
  if (filters.maomaoState && filters.maomaoState !== "all") {
    items = items.filter((item) => (filters.maomaoState === "none" ? !item.maomaoState : item.maomaoState === filters.maomaoState));
  }
  items.sort((a, b) => {
    const byUpdated = Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "");
    if (Number.isFinite(byUpdated) && byUpdated !== 0) return byUpdated;
    return a.repoFullName.localeCompare(b.repoFullName) || b.prNumber - a.prNumber;
  });
  const total = items.length;
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0) || 0);
  return {
    items: items.slice(offset, offset + GUIDED_INBOX_PAGE_SIZE),
    total,
    offset,
    limit: GUIDED_INBOX_PAGE_SIZE,
    repos: [...new Set(rows.map((row) => row.repo_full_name))].sort(),
    errors: [],
    unsupported: [...new Set(unsupported)],
  };
}
