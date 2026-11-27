import type { Config } from "../config.js";
import type { GithubPort } from "../github/client.js";
import { enumerateGithubInstallationRepositories, type GithubInstallationRepoOption } from "../github/enumerate.js";
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

/** Live open-PR inbox across authorized GitHub installations; failures stay per-repository. */
export async function listGuidedInbox(input: {
  config: Config;
  store: JobStore;
  github?: Partial<GithubPort>;
  forgeConnections?: ForgeConnectionStore;
  actor?: GuidedActor;
  filters?: GuidedInboxFilters;
}): Promise<GuidedInboxPage> {
  const errors: string[] = [];
  const unsupported: string[] = [];
  for (const connection of input.forgeConnections?.list().filter((row) => row.enabled === 1) ?? []) {
    unsupported.push(`${connection.provider} connection "${connection.label}" cannot list open pull requests for Guided Review yet.`);
  }
  const filters = input.filters ?? {};
  let repos: GithubInstallationRepoOption[] = [];
  if (!input.github?.listAppInstallations || !input.github.listInstallationRepositories) {
    unsupported.push("GitHub open-pull listing is unavailable with the configured client.");
  } else {
    try {
      repos = await enumerateGithubInstallationRepositories(input.github as Pick<GithubPort, "listAppInstallations" | "listInstallationRepositories">, input.config, "guided inbox");
    } catch (error) {
      errors.push(`Could not enumerate installation repositories: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const selectedRepos = repos.filter((repo) => !filters.repo || repo.fullName === filters.repo);
  const rows = await mapLimit(selectedRepos, 4, async (repo) => {
    if (!input.github?.listOpenPulls) {
      unsupported.push("GitHub open-pull listing is unavailable with the configured client.");
      return [] as GuidedInboxItem[];
    }
    const slash = repo.fullName.indexOf("/");
    const owner = repo.fullName.slice(0, slash);
    const name = repo.fullName.slice(slash + 1);
    try {
      const pulls = await input.github.listOpenPulls(repo.installationId, owner, name);
      return pulls.map((pull): GuidedInboxItem => {
        const latestJob = input.store.findLatestJobForPull(repo.fullName, pull.prNumber, undefined, { provider: "github", instance: "github.com" });
        const session = input.actor
          ? input.store.guidedReview.latestForPull(input.actor, "github", "github.com", repo.fullName, pull.prNumber)
          : undefined;
        const guidedState = !session
          ? "none"
          : session.historical_at
            ? "historical"
            : session.base_sha === pull.baseSha && session.head_sha === pull.headSha
              ? "current"
              : "stale";
        return {
          provider: "github",
          providerInstance: "github.com",
          repoFullName: repo.fullName,
          prNumber: pull.prNumber,
          title: pull.prTitle || `Pull request #${pull.prNumber}`,
          author: pull.prAuthor,
          url: pull.prHtmlUrl,
          baseSha: pull.baseSha,
          headSha: pull.headSha,
          draft: pull.draft,
          updatedAt: pull.updatedAt,
          reviewRequested: pull.requestedReviewers === undefined ? undefined : pull.requestedReviewers.length > 0,
          maomaoJobId: latestJob?.id,
          maomaoState: latestJob?.state,
          guidedSessionId: session?.id,
          guidedState,
          guidedCommentCount: session ? input.store.guidedReview.activeCommentCount(session.id) : undefined,
        };
      });
    } catch (error) {
      errors.push(`${repo.fullName}: open-pull listing failed (${error instanceof Error ? error.message : String(error)})`);
      return [] as GuidedInboxItem[];
    }
  });

  let items = rows.flat();
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
    repos: repos.map((repo) => repo.fullName),
    errors: [...new Set(errors)],
    unsupported: [...new Set(unsupported)],
  };
}
