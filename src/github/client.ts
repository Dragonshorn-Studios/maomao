import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
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

export interface GithubPort {
  getInstallationToken(installationId: number): Promise<string>;
  getPullDiff(installationId: number, owner: string, repo: string, pullNumber: number): Promise<string>;
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

export class GithubClient implements GithubPort {
  constructor(private readonly config: Config) {}

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

  async getPullDiff(installationId: number, owner: string, repo: string, pullNumber: number): Promise<string> {
    const octokit = this.installationOctokit(installationId);
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: "diff" },
    });
    return String(response.data);
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
