import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "../config.js";
import { limitedGithubFetch, unwrapDiffTooLarge } from "./diff-limit.js";
import { diffCommentAnchor } from "../findings/context.js";
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
  /** Inline comments GitHub actually accepted; empty when the fallback posted a body-only review. */
  postedComments?: PullReviewComment[];
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

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

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
    event?: ReviewEvent;
  }): Promise<PostedReview>;
  getRepositoryHead?(
    installationId: number,
    owner: string,
    repo: string,
  ): Promise<{ defaultBranch: string; headSha: string }>;
  getCommitDiff?(installationId: number, owner: string, repo: string, sha: string): Promise<string>;
  listOpenIssuesByMarker?(
    installationId: number,
    owner: string,
    repo: string,
    marker: string,
  ): Promise<Array<{ number: number; title: string; url: string; state: string }>>;
  /**
   * Read-only keyword search over a repository's open issues, used to surface
   * likely human-authored duplicates for operator review. Never modifies anything.
   */
  searchOpenIssues?(
    installationId: number,
    owner: string,
    repo: string,
    query: string,
  ): Promise<Array<{ number: number; title: string; url: string }>>;
  /** App-level installation listing for the scan-page repository typeahead. */
  listAppInstallations?(): Promise<Array<{ id: number; accountId: number }>>;
  /** Repositories reachable through one installation (first page, capped). */
  listInstallationRepositories?(installationId: number): Promise<Array<{ id: number; fullName: string }>>;
  createIssue?(
    installationId: number,
    owner: string,
    repo: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string }>;
  getIssue?(
    installationId: number,
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<{ number: number; title: string; body: string; state: string; url: string; isPullRequest: boolean } | undefined>;
  closeIssue?(installationId: number, owner: string, repo: string, issueNumber: number): Promise<void>;
  listIssueComments?(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<
    { id: number; body: string; userLogin?: string; userType?: string; authorAssociation?: string }[]
  >;
  /** Inline review comments on a pull request (read-only; existing App permissions). */
  listPullReviewComments?(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<
    {
      id: number;
      body: string;
      userLogin?: string;
      userType?: string;
      authorAssociation?: string;
      path?: string;
      line?: number;
      inReplyToId?: number;
    }[]
  >;
  createIssueComment?(input: {
    installationId: number;
    owner: string;
    repo: string;
    pullNumber: number;
    body: string;
  }): Promise<{ id: string; url: string }>;
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

/**
 * Builds the search `q` for open-issue duplicate lookups. Strips control
 * qualifiers (":", quotes) from the caller-supplied terms so they cannot add
 * `repo:`/`org:` filters and read issues outside this repository.
 */
export function buildIssueSearchQuery(owner: string, repo: string, query: string): string {
  const safeQuery = query.replace(/[:"]/g, " ").trim();
  return `repo:${owner}/${repo} is:issue is:open ${safeQuery}`;
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

  async getRepositoryHead(installationId: number, owner: string, repo: string) {
    const octokit = this.installationOctokit(installationId);
    const info = await octokit.rest.repos.get({ owner, repo });
    const branch = await octokit.rest.repos.getBranch({ owner, repo, branch: info.data.default_branch });
    return { defaultBranch: info.data.default_branch, headSha: branch.data.commit.sha };
  }

  async getCommitDiff(installationId: number, owner: string, repo: string, sha: string) {
    const octokit = this.installationOctokit(installationId);
    const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo,
      ref: sha,
      headers: { accept: "application/vnd.github.diff" },
    });
    return String(response.data);
  }

  async listOpenIssuesByMarker(installationId: number, owner: string, repo: string, marker: string) {
    const octokit = this.installationOctokit(installationId);
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });
    return issues
      .filter((issue) => !issue.pull_request && (issue.body ?? "").includes(marker))
      .map((issue) => ({ number: issue.number, title: issue.title ?? "", url: issue.html_url, state: issue.state }));
  }

  async searchOpenIssues(installationId: number, owner: string, repo: string, query: string) {
    const octokit = this.installationOctokit(installationId);
    const response = await octokit.rest.search.issuesAndPullRequests({
      q: buildIssueSearchQuery(owner, repo, query),
      per_page: 5,
    });
    return response.data.items
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({ number: issue.number, title: issue.title ?? "", url: issue.html_url }));
  }

  async listAppInstallations() {
    const octokit = this.appOctokit();
    const installations = await octokit.paginate(octokit.rest.apps.listInstallations, { per_page: 100 });
    return installations
      .filter((installation) => installation.account && "id" in installation.account)
      .map((installation) => ({
        id: Number(installation.id),
        accountId: Number((installation.account as { id: number }).id),
      }));
  }

  async listInstallationRepositories(installationId: number) {
    const response = await this.installationOctokit(installationId).rest.apps.listReposAccessibleToInstallation({
      per_page: 100,
    });
    return response.data.repositories.map((repo) => ({
      id: Number(repo.id),
      fullName: repo.full_name ?? `${repo.owner.login}/${repo.name}`,
    }));
  }

  async createIssue(installationId: number, owner: string, repo: string, title: string, body: string) {
    const octokit = this.installationOctokit(installationId);
    const response = await octokit.rest.issues.create({ owner, repo, title, body });
    return { number: response.data.number, url: response.data.html_url };
  }

  async getIssue(installationId: number, owner: string, repo: string, issueNumber: number) {
    const octokit = this.installationOctokit(installationId);
    try {
      const response = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
      return {
        number: response.data.number,
        title: response.data.title ?? "",
        body: response.data.body ?? "",
        state: String(response.data.state ?? "open"),
        url: response.data.html_url,
        isPullRequest: Boolean(response.data.pull_request),
      };
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      if (status === 404) return undefined;
      throw error;
    }
  }

  async closeIssue(installationId: number, owner: string, repo: string, issueNumber: number) {
    const octokit = this.installationOctokit(installationId);
    try {
      await octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, state: "closed" });
    } catch (error) {
      if (isAlreadyClosedError(error)) return;
      throw error;
    }
  }

  async createCommentReview(input: {
    installationId: number;
    owner: string;
    repo: string;
    pullNumber: number;
    commitId: string;
    body: string;
    comments: PullReviewComment[];
    event?: ReviewEvent;
  }): Promise<PostedReview> {
    const octokit = this.installationOctokit(input.installationId);
    const event = input.event ?? "COMMENT";
    return createReviewWithFallback({
      comments: input.comments,
      body: input.body,
      post: async (comments, body) => {
        const response = await octokit.rest.pulls.createReview({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pullNumber,
          commit_id: input.commitId,
          event,
          body,
          comments: comments.map((comment) => ({
            path: comment.path,
            body: comment.body,
            line: comment.line,
            side: comment.side ?? "RIGHT",
          })),
        });
        return { id: response.data.id, url: response.data.html_url ?? "" };
      },
    });
  }

  async listIssueComments(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<
    { id: number; body: string; userLogin?: string; userType?: string; authorAssociation?: string }[]
  > {
    const octokit = this.installationOctokit(installationId);
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });
    return comments.slice(-200).map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      userLogin: comment.user?.login ?? undefined,
      userType: comment.user?.type ?? undefined,
      authorAssociation: comment.author_association ?? undefined,
    }));
  }

  async listPullReviewComments(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<
    {
      id: number;
      body: string;
      userLogin?: string;
      userType?: string;
      authorAssociation?: string;
      path?: string;
      line?: number;
      inReplyToId?: number;
    }[]
  > {
    const octokit = this.installationOctokit(installationId);
    const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    return comments.slice(-200).map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      userLogin: comment.user?.login ?? undefined,
      userType: comment.user?.type ?? undefined,
      authorAssociation: comment.author_association ?? undefined,
      path: comment.path ?? undefined,
      line: comment.line ?? comment.original_line ?? undefined,
      inReplyToId: comment.in_reply_to_id ?? undefined,
    }));
  }

  async createIssueComment(input: {
    installationId: number;
    owner: string;
    repo: string;
    pullNumber: number;
    body: string;
  }): Promise<{ id: string; url: string }> {
    const octokit = this.installationOctokit(input.installationId);
    const response = await octokit.rest.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.pullNumber,
      body: input.body,
    });
    return { id: String(response.data.id), url: response.data.html_url ?? "" };
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

/**
 * Post a review with inline comments, degrading instead of dying: if GitHub rejects
 * the batch, retry once as a body-only review; if that retry also fails, surface the
 * original error (it explains why we degraded).
 */
export async function createReviewWithFallback(input: {
  comments: PullReviewComment[];
  body: string;
  post: (comments: PullReviewComment[], body: string) => Promise<{ id: number | string; url?: string }>;
}): Promise<PostedReview> {
  try {
    const review = await input.post(input.comments, input.body);
    return { id: String(review.id), url: review.url ?? "", postedComments: input.comments };
  } catch (error) {
    if (input.comments.length === 0) throw error;
    // Inline comments must land on diff lines; fall back to a body-only review.
    try {
      const review = await input.post(
        [],
        `${input.body}\n\n_Inline comments were omitted because GitHub rejected one or more diff locations._`,
      );
      return { id: String(review.id), url: review.url ?? "", postedComments: [] };
    } catch {
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

export interface InlineCommentFinding {
  file?: string;
  line?: number;
  summary: string;
  body?: string;
  severity: string;
  category?: string;
  fingerprint?: string;
}

/** A finding whose reported location cannot anchor in the diff, demoted to the review body. */
export interface DemotedFinding {
  finding: InlineCommentFinding;
  reason: string;
}

const DEMOTED_BODY_LIMIT = 10;

export function buildReviewBody(input: {
  headSha: string;
  summary: string;
  findingsCount: number;
  reviewerCount: number;
  demoted?: DemotedFinding[];
}): string {
  const marker = reviewMarker(input.headSha);
  const header = [
    marker,
    `Maomao reviewed commit \`${input.headSha}\` with ${input.reviewerCount} specialist run(s).`,
    "",
  ].join("\n");
  let body = `${header}${input.summary.trim()}\n`;
  const demoted = input.demoted ?? [];
  if (demoted.length > 0) {
    const shown = demoted.slice(0, DEMOTED_BODY_LIMIT);
    const lines = shown.map(
      (entry) =>
        `- **${entry.finding.severity}**: ${entry.finding.summary} — \`${entry.finding.file}:${entry.finding.line}\``,
    );
    if (demoted.length > shown.length) lines.push(`- … and ${demoted.length - shown.length} more`);
    body += `\n#### Findings not shown inline\n\nThese locations are not part of the diff hunks, so they are listed here instead:\n\n${lines.join("\n")}\n`;
  }
  return body;
}

function inlineComment(finding: InlineCommentFinding, headSha: string, side: "LEFT" | "RIGHT"): PullReviewComment {
  const fingerprint = finding.fingerprint ?? fingerprintFinding(finding);
  return {
    path: finding.file ?? "",
    line: finding.line ?? 1,
    side,
    body: `${findingMarker(fingerprint, headSha)}\n**${finding.severity}**: ${finding.summary}${finding.body ? `\n\n${finding.body}` : ""}`,
  };
}

/**
 * Split publishable findings into inline comments GitHub will accept and findings whose
 * reported location is not in the diff (demoted to the review body by the caller). Without
 * a diff to validate against, every located finding passes through as before.
 */
export function selectInlineComments(
  findings: InlineCommentFinding[],
  opts: { limit: number; headSha: string; diff?: string },
): { comments: PullReviewComment[]; demoted: DemotedFinding[] } {
  const comments: PullReviewComment[] = [];
  const demoted: DemotedFinding[] = [];
  for (const finding of findings) {
    if (!finding.file || !finding.line) continue;
    const anchor = opts.diff
      ? diffCommentAnchor(opts.diff, finding.file, finding.line)
      : ({ ok: true, side: "RIGHT" } as const);
    if (!anchor.ok) {
      demoted.push({ finding, reason: anchor.reason });
      continue;
    }
    // Cap only the inline set: findings beyond it stay unlisted (summary only),
    // exactly as before, while unanchorable ones always reach the body.
    if (comments.length >= opts.limit) continue;
    comments.push(inlineComment(finding, opts.headSha, anchor.side));
  }
  return { comments, demoted };
}

export function toInlineComments(
  findings: InlineCommentFinding[],
  limit: number,
  headSha: string,
): PullReviewComment[] {
  return selectInlineComments(findings, { limit, headSha }).comments;
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

/** The comment that carries the Maomao finding marker, even if it is not comments[0]. */
export function findingComment(thread: ReviewThread): ReviewThreadComment | undefined {
  return thread.comments.find((comment) => Boolean(parseFindingMarker(comment.body))) ?? thread.comments[0];
}

export function parseThreadFindingMarker(thread: ReviewThread): { id: string; sha: string } | undefined {
  for (const comment of thread.comments) {
    const marker = parseFindingMarker(comment.body);
    if (marker) return marker;
  }
  return undefined;
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
          comments(first: 100) {
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

function isAlreadyClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already closed|is closed/i.test(message);
}
