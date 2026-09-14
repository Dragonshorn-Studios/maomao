import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import { limitedGithubFetch, unwrapDiffTooLarge } from "./diff-limit.js";
import { reviewMarker } from "../prompts.js";

export interface PullReviewComment {
  path: string;
  body: string;
  line: number;
  side?: "LEFT" | "RIGHT";
}

export interface PostedReview {
  id: string;
  url: string;
}

export interface ResolvedPull {
  installationId: number;
  accountId: number;
  repositoryId: number;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  prHtmlUrl: string;
  prAuthor: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  draft: boolean;
}

export interface ManualTriggerPort {
  getRepoInstallation(
    owner: string,
    repo: string,
  ): Promise<{ installationId: number; accountId: number }>;
  getRepository(owner: string, repo: string, installationId: number): Promise<{ id: number }>;
  getPull(installationId: number, owner: string, repo: string, pullNumber: number): Promise<ResolvedPull>;
}

export interface GithubPort {
  getInstallationToken(installationId: number): Promise<string>;
  getPullDiff(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    maxBytes?: number,
  ): Promise<string>;
  listReviews(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ id: number; body: string; commitId?: string; htmlUrl?: string; userLogin?: string }[]>;
  createCommentReview(input: {
    installationId: number;
    owner: string;
    repo: string;
    pullNumber: number;
    commitId: string;
    body: string;
    comments: PullReviewComment[];
  }): Promise<PostedReview>;
}

export class GithubClient implements GithubPort, ManualTriggerPort {
  constructor(private readonly config: Config) {}

  private appOctokit(): Octokit {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.github.appId,
        privateKey: this.config.github.privateKey,
      },
    });
  }

  private installationOctokit(installationId: number): Octokit {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.github.appId,
        privateKey: this.config.github.privateKey,
        installationId,
      },
    });
  }

  async getInstallationToken(installationId: number): Promise<string> {
    const auth = createAppAuth({
      appId: this.config.github.appId,
      privateKey: this.config.github.privateKey,
    });
    const result = await auth({ type: "installation", installationId });
    return result.token;
  }

  /**
   * JWT-authenticated App lookup. Requires a numeric `account.id` even when
   * allowlists are empty, so later authorization can fail closed on that axis.
   */
  async getRepoInstallation(
    owner: string,
    repo: string,
  ): Promise<{ installationId: number; accountId: number }> {
    try {
      const response = await this.appOctokit().rest.apps.getRepoInstallation({ owner, repo });
      const account = response.data.account;
      const accountId = account && "id" in account ? Number(account.id) : Number.NaN;
      if (!response.data.id || !Number.isSafeInteger(accountId) || accountId <= 0) {
        throw new Error("GitHub App installation is missing a numeric account id");
      }
      return { installationId: response.data.id, accountId };
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      if (status === 404) {
        throw new Error(`GitHub App is not installed on ${owner}/${repo}`);
      }
      throw error instanceof Error ? error : new Error(`Could not resolve installation for ${owner}/${repo}`);
    }
  }

  async getRepository(owner: string, repo: string, installationId: number): Promise<{ id: number }> {
    const response = await this.installationOctokit(installationId).rest.repos.get({ owner, repo });
    const id = Number(response.data.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("repository is missing a numeric id");
    }
    return { id };
  }

  async getPull(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<ResolvedPull> {
    try {
      const response = await this.installationOctokit(installationId).rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });
      const pr = response.data;
      if (!pr.head?.sha || !pr.base?.sha) {
        throw new Error("pull request is missing base or head SHA");
      }
      const repositoryId = Number(pr.base.repo?.id);
      const accountId = Number(pr.base.repo?.owner?.id);
      if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
        throw new Error("pull request is missing a numeric repository id");
      }
      if (!Number.isSafeInteger(accountId) || accountId <= 0) {
        throw new Error("pull request is missing a numeric account id");
      }
      return {
        installationId,
        accountId,
        repositoryId,
        repoOwner: owner,
        repoName: repo,
        repoFullName: `${owner}/${repo}`,
        prNumber: pr.number,
        prTitle: pr.title ?? "",
        prBody: pr.body ?? "",
        prHtmlUrl: pr.html_url ?? `https://github.com/${owner}/${repo}/pull/${pr.number}`,
        prAuthor: pr.user?.login ?? "",
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        baseRef: pr.base.ref ?? "",
        headRef: pr.head.ref ?? "",
        draft: Boolean(pr.draft),
      };
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      if (status === 404) {
        throw new Error(`Pull request ${owner}/${repo}#${pullNumber} was not found`);
      }
      throw error instanceof Error ? error : new Error(`Could not load ${owner}/${repo}#${pullNumber}`);
    }
  }

  async getPullDiff(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    maxBytes = 0,
  ): Promise<string> {
    const octokit = this.installationOctokit(installationId);
    try {
      const response = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
        mediaType: { format: "diff" },
        request: maxBytes > 0 ? { fetch: limitedGithubFetch(maxBytes) } : undefined,
      });
      return String(response.data);
    } catch (error) {
      const tooLarge = unwrapDiffTooLarge(error);
      if (tooLarge) throw tooLarge;
      throw error;
    }
  }

  async listReviews(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ id: number; body: string; commitId?: string; htmlUrl?: string; userLogin?: string }[]> {
    const octokit = this.installationOctokit(installationId);
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    return reviews.map((review) => ({
      id: review.id,
      body: review.body ?? "",
      commitId: review.commit_id ?? undefined,
      htmlUrl: review.html_url,
      userLogin: review.user?.login ?? undefined,
    }));
  }

  async createCommentReview(input: {
    installationId: number;
    owner: string;
    repo: string;
    pullNumber: number;
    commitId: string;
    body: string;
    comments: PullReviewComment[];
  }): Promise<PostedReview> {
    const octokit = this.installationOctokit(input.installationId);
    try {
      const response = await octokit.rest.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        commit_id: input.commitId,
        event: "COMMENT",
        body: input.body,
        comments: input.comments.map((comment) => ({
          path: comment.path,
          body: comment.body,
          line: comment.line,
          side: comment.side ?? "RIGHT",
        })),
      });
      return { id: String(response.data.id), url: response.data.html_url ?? "" };
    } catch (error) {
      if (input.comments.length === 0) throw error;
      // Inline comments must land on diff lines; fall back to a body-only COMMENT.
      const response = await octokit.rest.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        commit_id: input.commitId,
        event: "COMMENT",
        body: `${input.body}\n\n_Inline comments were omitted because GitHub rejected one or more diff locations._`,
      });
      return { id: String(response.data.id), url: response.data.html_url ?? "" };
    }
  }
}

export function findExistingReview(
  reviews: { id: number; body: string; commitId?: string; htmlUrl?: string }[],
  headSha: string,
): PostedReview | undefined {
  const marker = reviewMarker(headSha);
  const match = reviews.find((review) => review.body.includes(marker));
  if (!match) return undefined;
  return { id: String(match.id), url: match.htmlUrl ?? "" };
}

export function buildReviewBody(input: {
  headSha: string;
  summary: string;
  findingsCount: number;
  reviewerCount: number;
}): string {
  const marker = reviewMarker(input.headSha);
  const header = [
    marker,
    `Maomao reviewed commit \`${input.headSha}\` with ${input.reviewerCount} specialist run(s).`,
    "",
  ].join("\n");
  return `${header}${input.summary.trim()}\n`;
}

export function toInlineComments(
  findings: { file?: string; line?: number; summary: string; body?: string; severity: string }[],
  limit: number,
): PullReviewComment[] {
  const comments: PullReviewComment[] = [];
  for (const finding of findings) {
    if (comments.length >= limit) break;
    if (!finding.file || !finding.line) continue;
    comments.push({
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: `**${finding.severity}**: ${finding.summary}${finding.body ? `\n\n${finding.body}` : ""}`,
    });
  }
  return comments;
}
