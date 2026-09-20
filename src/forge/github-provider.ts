/**
 * GitHubProvider: binds the existing GithubClient to the forge-neutral port
 * for one App installation. All GitHub API specifics (installation tokens,
 * Basic x-access-token checkout auth, refs/pull refspecs, GraphQL thread ids)
 * stay behind this adapter.
 */
import type { GithubPort, ManualTriggerPort } from "../github/client.js";
import { isMaomaoLogin } from "../github/client.js";
import { gitAuthSecrets, gitHttpAuthArgs } from "../checkout.js";
import { MAX_OVERRIDE_COMMENTS } from "../findings/overrides.js";
import type { ForgePort } from "./port.js";
import { GITHUB_INSTANCE, GITHUB_PROVIDER } from "./types.js";
import type {
  ForgeChange,
  ForgeCloneSpec,
  ForgeConversationComment,
  ForgeDiscussion,
  ForgePermission,
  ForgePublishInput,
  ForgePublishResult,
  ForgeRepoTarget,
  ForgeSummary,
} from "./types.js";

/** getPull arrives via ManualTriggerPort; partial so port fakes without it still construct. */
export type GithubPortWithPulls = GithubPort & Partial<Pick<ManualTriggerPort, "getPull">>;

export class GitHubProvider implements ForgePort {
  readonly provider = GITHUB_PROVIDER;
  readonly instance = GITHUB_INSTANCE;

  constructor(
    private readonly client: GithubPortWithPulls,
    readonly installationId: number,
    private readonly appSlug: string,
    private readonly getToken?: (installationId: number) => Promise<string>,
  ) {}

  async getChange(target: ForgeRepoTarget): Promise<ForgeChange> {
    if (!this.client.getPull) {
      throw new Error("GitHub client cannot resolve pull request metadata");
    }
    const pull = await this.client.getPull(
      this.installationId,
      target.repoOwner,
      target.repoName,
      target.changeNumber,
    );
    return {
      repoOwner: pull.repoOwner,
      repoName: pull.repoName,
      repoFullName: pull.repoFullName,
      changeNumber: pull.prNumber,
      title: pull.prTitle,
      body: pull.prBody,
      htmlUrl: pull.prHtmlUrl,
      author: pull.prAuthor,
      baseSha: pull.baseSha,
      headSha: pull.headSha,
      baseRef: pull.baseRef,
      headRef: pull.headRef,
      draft: pull.draft,
      repositoryId: pull.repositoryId,
      accountId: pull.accountId,
    };
  }

  async getChangeDiff(target: ForgeRepoTarget, maxBytes?: number): Promise<string> {
    return this.client.getPullDiff(
      this.installationId,
      target.repoOwner,
      target.repoName,
      target.changeNumber,
      maxBytes,
    );
  }

  async getCommitDiff(target: Omit<ForgeRepoTarget, "changeNumber">, sha: string): Promise<string> {
    if (!this.client.getCommitDiff) {
      throw new Error("health scans require a GitHub client with commit diff support");
    }
    return this.client.getCommitDiff(this.installationId, target.repoOwner, target.repoName, sha);
  }

  async listSummaries(target: ForgeRepoTarget): Promise<ForgeSummary[]> {
    const reviews = await this.client.listReviews(
      this.installationId,
      target.repoOwner,
      target.repoName,
      target.changeNumber,
    );
    return reviews.map((review) => ({
      id: String(review.id),
      body: review.body,
      commitId: review.commitId,
      htmlUrl: review.htmlUrl,
      userLogin: review.userLogin,
    }));
  }

  async publishReview(input: ForgePublishInput): Promise<ForgePublishResult> {
    return this.client.createCommentReview({
      installationId: this.installationId,
      owner: input.target.repoOwner,
      repo: input.target.repoName,
      pullNumber: input.target.changeNumber,
      commitId: input.commitId,
      body: input.body,
      comments: input.comments,
      event: input.verdict,
      forgeLabel: "GitHub",
    });
  }

  async listDiscussions(target: ForgeRepoTarget): Promise<ForgeDiscussion[]> {
    return this.client.listReviewThreads(
      this.installationId,
      target.repoOwner,
      target.repoName,
      target.changeNumber,
    );
  }

  async resolveDiscussion(target: ForgeRepoTarget, discussionId: string): Promise<void> {
    await this.client.resolveReviewThread(this.installationId, discussionId);
  }

  async unresolveDiscussion(target: ForgeRepoTarget, discussionId: string): Promise<void> {
    await this.client.unresolveReviewThread(this.installationId, discussionId);
  }

  async getActorPermission(target: ForgeRepoTarget, username: string): Promise<ForgePermission> {
    return this.client.getCollaboratorPermission(
      this.installationId,
      target.repoOwner,
      target.repoName,
      username,
    );
  }

  /**
   * Last MAX_OVERRIDE_COMMENTS per source (conversation and inline are capped
   * separately). The override scanner consumes port output uncapped, so the
   * adapter owns the historical bound.
   */
  async listConversationComments(target: ForgeRepoTarget): Promise<ForgeConversationComment[]> {
    const out: ForgeConversationComment[] = [];
    if (this.client.listIssueComments) {
      const comments = await this.client.listIssueComments(
        this.installationId,
        target.repoOwner,
        target.repoName,
        target.changeNumber,
      );
      for (const comment of comments.slice(-MAX_OVERRIDE_COMMENTS)) {
        out.push({
          id: String(comment.id),
          source: "conversation",
          body: comment.body,
          login: comment.userLogin,
          userType: comment.userType,
          authorAssociation: comment.authorAssociation,
        });
      }
    }
    if (this.client.listPullReviewComments) {
      const comments = await this.client.listPullReviewComments(
        this.installationId,
        target.repoOwner,
        target.repoName,
        target.changeNumber,
      );
      for (const comment of comments.slice(-MAX_OVERRIDE_COMMENTS)) {
        out.push({
          id: String(comment.id),
          source: "inline",
          body: comment.body,
          login: comment.userLogin,
          userType: comment.userType,
          authorAssociation: comment.authorAssociation,
          path: comment.path,
          line: comment.line,
          inReplyToId: comment.inReplyToId != null ? String(comment.inReplyToId) : undefined,
        });
      }
    }
    return out;
  }

  async cloneSpec(target: ForgeRepoTarget, opts?: { anonymous?: boolean }): Promise<ForgeCloneSpec> {
    const cloneUrl = `https://${this.instance}/${target.repoFullName}.git`;
    const remoteRef = `refs/pull/${target.changeNumber}/head`;
    // Installation id 0 marks unauthenticated public-repository scans. A
    // pull-request review job with installation 0 is a broken binding: fail
    // fast instead of silently fetching anonymously (and spending the whole
    // pipeline on a review that could never be published).
    if (this.installationId === 0) {
      if (!opts?.anonymous) {
        throw new Error(
          `job targets installation_id 0; the GitHub App cannot authenticate a review of ${target.repoFullName}`,
        );
      }
      return { cloneUrl, gitAuthArgs: [], remoteRef, secrets: [] };
    }
    const token = this.getToken
      ? await this.getToken(this.installationId)
      : await this.client.getInstallationToken(this.installationId);
    return {
      cloneUrl,
      gitAuthArgs: gitHttpAuthArgs(token),
      remoteRef,
      secrets: gitAuthSecrets(token),
    };
  }

  isBotLogin(login: string | undefined): boolean {
    return isMaomaoLogin(login, this.appSlug);
  }
}
