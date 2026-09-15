import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import { findingMarker, fingerprintFinding, parseFindingMarker } from "../findings/identity.js";
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
  getRepoInstallationId(owner: string, repo: string): Promise<number>;
  getPull(installationId: number, owner: string, repo: string, pullNumber: number): Promise<ResolvedPull>;
}

export type RepoPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

export interface ReviewThreadComment {
  id: string;
  databaseId?: number;
  body: string;
  path?: string;
  line?: number | null;
  authorLogin?: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  path?: string;
  line?: number | null;
  comments: ReviewThreadComment[];
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
  listReviewThreads(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<ReviewThread[]>;
  resolveReviewThread(installationId: number, threadId: string): Promise<void>;
  unresolveReviewThread(installationId: number, threadId: string): Promise<void>;
  getCollaboratorPermission(
    installationId: number,
    owner: string,
    repo: string,
    username: string,
  ): Promise<RepoPermission>;
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

  async getRepoInstallationId(owner: string, repo: string): Promise<number> {
    try {
      const response = await this.appOctokit().rest.apps.getRepoInstallation({ owner, repo });
      return response.data.id;
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      if (status === 404) {
        throw new Error(`GitHub App is not installed on ${owner}/${repo}`);
      }
      throw error instanceof Error ? error : new Error(`Could not resolve installation for ${owner}/${repo}`);
    }
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
      return {
        installationId,
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

  async listReviewThreads(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<ReviewThread[]> {
    const octokit = this.installationOctokit(installationId);
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;
    let hasNext = true;
    while (hasNext && threads.length < 400) {
      const data = (await octokit.graphql(REVIEW_THREADS_QUERY, {
        owner,
        repo,
        number: pullNumber,
        cursor,
      })) as ReviewThreadsResponse;
      const connection = data.repository?.pullRequest?.reviewThreads;
      for (const node of connection?.nodes ?? []) {
        if (!node?.id) continue;
        threads.push({
          id: node.id,
          isResolved: Boolean(node.isResolved),
          path: node.path ?? undefined,
          line: node.line ?? undefined,
          comments: (node.comments?.nodes ?? []).flatMap((comment) =>
            comment?.id
              ? [
                  {
                    id: comment.id,
                    databaseId: comment.databaseId ?? undefined,
                    body: comment.body ?? "",
                    path: comment.path ?? undefined,
                    line: comment.line ?? undefined,
                    authorLogin: comment.author?.login ?? undefined,
                  },
                ]
              : [],
          ),
        });
      }
      hasNext = Boolean(connection?.pageInfo.hasNextPage);
      cursor = connection?.pageInfo.endCursor ?? null;
      if (!cursor) hasNext = false;
    }
    return threads;
  }

  async resolveReviewThread(installationId: number, threadId: string): Promise<void> {
    const octokit = this.installationOctokit(installationId);
    try {
      await octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId });
    } catch (error) {
      if (isAlreadyResolvedError(error)) return;
      throw error;
    }
  }

  async unresolveReviewThread(installationId: number, threadId: string): Promise<void> {
    const octokit = this.installationOctokit(installationId);
    try {
      await octokit.graphql(UNRESOLVE_THREAD_MUTATION, { threadId });
    } catch (error) {
      if (isAlreadyUnresolvedError(error)) return;
      throw error;
    }
  }

  async getCollaboratorPermission(
    installationId: number,
    owner: string,
    repo: string,
    username: string,
  ): Promise<RepoPermission> {
    const octokit = this.installationOctokit(installationId);
    try {
      const response = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username,
      });
      const permission = String(response.data.permission ?? "none").toLowerCase();
      const roleName =
        "role_name" in response.data ? String((response.data as { role_name?: string }).role_name ?? "") : "";
      return normalizePermission(permission, roleName);
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      // 404 = not a collaborator (or the App cannot see them). Fail closed as none;
      // OWNER association may fill this gap only for personal-repo owners.
      if (status === 404) return "none";
      throw error;
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
  findings: {
    file?: string;
    line?: number;
    summary: string;
    body?: string;
    severity: string;
    category?: string;
    fingerprint?: string;
  }[],
  limit: number,
  headSha: string,
): PullReviewComment[] {
  const comments: PullReviewComment[] = [];
  for (const finding of findings) {
    if (comments.length >= limit) break;
    if (!finding.file || !finding.line) continue;
    const fingerprint = finding.fingerprint ?? fingerprintFinding(finding);
    comments.push({
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: `${findingMarker(fingerprint, headSha)}\n**${finding.severity}**: ${finding.summary}${finding.body ? `\n\n${finding.body}` : ""}`,
    });
  }
  return comments;
}

export function inlineCommentFingerprints(comments: PullReviewComment[]): string[] {
  const ids: string[] = [];
  for (const comment of comments) {
    const marker = parseFindingMarker(comment.body);
    if (marker?.id) ids.push(marker.id);
  }
  return ids;
}

export function threadRoot(thread: ReviewThread): ReviewThreadComment | undefined {
  return thread.comments[0];
}

export function isMaomaoThread(thread: ReviewThread): boolean {
  return thread.comments.some((comment) => Boolean(parseFindingMarker(comment.body)));
}

export function threadContainsComment(thread: ReviewThread, commentId: number): boolean {
  return thread.comments.some((comment) => comment.databaseId === commentId);
}

export function maomaoBotLogins(appSlug: string): string[] {
  const slug = (appSlug || "maomao").replace(/\[bot\]$/i, "").toLowerCase();
  return [`${slug}[bot]`, slug];
}

export function isMaomaoLogin(login: string | undefined, appSlug: string): boolean {
  if (!login) return false;
  return maomaoBotLogins(appSlug).includes(login.toLowerCase());
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          comments(first: 50) {
            nodes {
              id
              databaseId
              body
              path
              line
              author { login }
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { isResolved }
  }
}`;

const UNRESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { isResolved }
  }
}`;

interface ReviewThreadsResponse {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
        nodes?: Array<{
          id?: string;
          isResolved?: boolean;
          path?: string | null;
          line?: number | null;
          comments?: {
            nodes?: Array<{
              id?: string;
              databaseId?: number | null;
              body?: string | null;
              path?: string | null;
              line?: number | null;
              author?: { login?: string | null } | null;
            } | null>;
          } | null;
        } | null>;
      };
    };
  };
}

function normalizePermission(permission: string, roleName: string): RepoPermission {
  const candidates = [permission, roleName.toLowerCase()];
  for (const value of candidates) {
    if (value === "admin" || value === "maintain" || value === "write" || value === "triage" || value === "read") {
      return value;
    }
  }
  return "none";
}

function isAlreadyResolvedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already resolved|is resolved/i.test(message);
}

function isAlreadyUnresolvedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not resolved|already unresolved|is not resolved/i.test(message);
}
