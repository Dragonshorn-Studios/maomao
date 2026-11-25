/**
 * ForgejoProvider: one persisted connection bound to the forge-neutral port.
 * Forgejo/Gitea API differences stay here: commit statuses instead of Check
 * Runs, issue comments instead of GitHub review threads, and refs/pull refs
 * for exact review checkouts.
 */
import type { OpenedConnection } from "../forge/connections.js";
import type { ForgePort } from "../forge/port.js";
import { SafeHttpError, safeHttpRequest } from "../forge/safe-http.js";
import type {
  ForgeChange,
  ForgeCheckPublishInput,
  ForgeCheckPublishResult,
  ForgeCloneSpec,
  ForgeDiscussion,
  ForgePermission,
  ForgePublishInput,
  ForgePublishResult,
  ForgeRepoTarget,
  ForgeSummary,
} from "../forge/types.js";
import { reviewMarker } from "../prompts.js";

interface ForgejoPull {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  user?: { login?: string };
  base?: { sha?: string; ref?: string };
  head?: { sha?: string; ref?: string };
  draft?: boolean;
}

interface ForgejoComment {
  id?: number;
  body?: string;
  html_url?: string;
  user?: { login?: string };
}

export function forgejoStatusState(input: ForgeCheckPublishInput): "pending" | "success" | "error" | "failure" | "warning" | "skipped" {
  if (input.status !== "completed") return "pending";
  switch (input.conclusion) {
    case "success": return "success";
    case "failure": return "failure";
    case "neutral": return "warning";
    case "skipped": return "skipped";
    default: return "error";
  }
}

export class ForgejoProvider implements ForgePort {
  readonly provider = "forgejo";
  readonly instance: string;

  constructor(private readonly connection: OpenedConnection) {
    this.instance = connection.instance.hostname;
  }

  private repoPath(target: Pick<ForgeRepoTarget, "repoOwner" | "repoName">): string {
    return `${this.connection.instance.apiBaseUrl}/repos/${encodeURIComponent(target.repoOwner)}/${encodeURIComponent(target.repoName)}`;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    url: string,
    opts: { body?: Record<string, unknown>; maxBytes?: number; timeoutMs?: number; raw?: boolean } = {},
  ): Promise<T> {
    const response = await safeHttpRequest({
      method,
      url,
      instance: this.connection.instance,
      allowPrivateNetwork: this.connection.row.allow_private_network === 1,
      caPem: this.connection.row.ca_pem ?? undefined,
      bearerToken: this.connection.token,
      timeoutMs: opts.timeoutMs ?? 20_000,
      maxBytes: opts.maxBytes,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      headers: opts.body != null ? { "content-type": "application/json" } : undefined,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new SafeHttpError(`Forgejo API returned status ${response.status} for ${url}`, response.status);
    }
    if (opts.raw) return response.body as T;
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new SafeHttpError(
        `Forgejo API returned a non-JSON body (status ${response.status}, type ${response.contentType ?? "none"}) for ${url}: ${response.body.slice(0, 80)}`,
        response.status,
      );
    }
  }

  async getChange(target: ForgeRepoTarget): Promise<ForgeChange> {
    const pull = await this.request<ForgejoPull>("GET", `${this.repoPath(target)}/pulls/${target.changeNumber}`);
    if (!pull.base?.sha || !pull.head?.sha) throw new SafeHttpError("pull request response is missing base/head sha");
    return {
      repoOwner: target.repoOwner,
      repoName: target.repoName,
      repoFullName: target.repoFullName,
      changeNumber: target.changeNumber,
      title: pull.title ?? "",
      body: pull.body ?? "",
      htmlUrl: pull.html_url ?? "",
      author: pull.user?.login ?? "",
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      baseRef: pull.base.ref ?? "",
      headRef: pull.head.ref ?? "",
      draft: Boolean(pull.draft),
    };
  }

  async getChangeDiff(target: ForgeRepoTarget, maxBytes?: number): Promise<string> {
    return this.request<string>("GET", `${this.repoPath(target)}/pulls/${target.changeNumber}.diff`, {
      maxBytes,
      raw: true,
    });
  }

  async listSummaries(target: ForgeRepoTarget): Promise<ForgeSummary[]> {
    const summaries: ForgeSummary[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const comments = await this.request<ForgejoComment[]>(
        "GET",
        `${this.repoPath(target)}/issues/${target.changeNumber}/comments?limit=100&page=${page}`,
        { maxBytes: 8 * 1024 * 1024 },
      );
      if (!Array.isArray(comments)) break;
      for (const comment of comments) {
        if ((comment.body ?? "").includes("<!-- maomao-review")) {
          summaries.push({
            id: String(comment.id ?? ""),
            body: comment.body ?? "",
            htmlUrl: comment.html_url,
            userLogin: comment.user?.login,
          });
        }
      }
      if (comments.length < 100) break;
    }
    return summaries;
  }

  async publishReview(input: ForgePublishInput): Promise<ForgePublishResult> {
    const existing = await this.listSummaries(input.target);
    const already = existing.find((summary) => summary.body.includes(reviewMarker(input.commitId)));
    if (already) return { id: already.id, url: already.htmlUrl ?? "", postedComments: [] };
    // Forgejo's portable API does not expose GitHub-equivalent line-anchor
    // semantics across supported versions. Post the complete body as the
    // human-facing summary and report inline degradation explicitly.
    const inlineSection = input.comments.length
      ? `\n\n### Findings\n\n${input.comments.map((comment) => `${comment.body}\n\n_${comment.path}:${comment.line}_`).join("\n\n")}`
      : "";
    const posted = await this.request<ForgejoComment>(
      "POST",
      `${this.repoPath(input.target)}/issues/${input.target.changeNumber}/comments`,
      { body: { body: `${input.body}${inlineSection}` } },
    );
    return {
      id: String(posted.id ?? ""),
      url: posted.html_url ?? "",
      postedComments: [],
      ...(input.comments.length > 0
        ? { warnings: [`Forgejo does not support portable review line anchors; ${input.comments.length} inline finding(s) remained in the review body`] }
        : {}),
    };
  }

  supportsNativeChecks(): boolean {
    return true;
  }

  async publishCheck(input: ForgeCheckPublishInput): Promise<ForgeCheckPublishResult> {
    const state = forgejoStatusState(input);
    const created = await this.request<{ id?: number; status?: string; target_url?: string }>(
      "POST",
      `${this.repoPath(input.target)}/statuses/${encodeURIComponent(input.commitSha)}`,
      {
        body: {
          context: input.name,
          description: input.title.slice(0, 255),
          state,
          ...(input.detailsUrl ? { target_url: input.detailsUrl } : {}),
        },
      },
    );
    return { id: String(created.id ?? `${input.name}:${input.commitSha}`), url: created.target_url ?? input.detailsUrl };
  }

  /** Forgejo has no portable resolved-thread model; reconciliation degrades to no threads. */
  async listDiscussions(): Promise<ForgeDiscussion[]> {
    return [];
  }

  async resolveDiscussion(): Promise<void> {
    throw new SafeHttpError("Forgejo portable API does not support resolving review discussions");
  }

  async unresolveDiscussion(): Promise<void> {
    throw new SafeHttpError("Forgejo portable API does not support unresolving review discussions");
  }

  async getActorPermission(target: ForgeRepoTarget, username: string): Promise<ForgePermission> {
    try {
      const permission = await this.request<{ permission?: string }>(
        "GET",
        `${this.repoPath(target)}/collaborators/${encodeURIComponent(username)}/permission`,
      );
      const value = permission.permission ?? "";
      if (value === "owner" || value === "admin") return "admin";
      if (value === "write") return "write";
      if (value === "read") return "read";
      return "none";
    } catch (error) {
      if (error instanceof SafeHttpError && error.status === 404) return "none";
      throw error;
    }
  }

  async cloneSpec(target: ForgeRepoTarget): Promise<ForgeCloneSpec> {
    const username = this.connection.row.bot_username;
    if (!username) {
      throw new SafeHttpError("Forgejo connection has no probed bot username; probe the connection before cloning");
    }
    const basic = Buffer.from(`${username}:${this.connection.token}`, "utf8").toString("base64");
    const header = `Authorization: Basic ${basic}`;
    return {
      cloneUrl: `${this.connection.instance.origin}/${target.repoFullName}.git`,
      gitAuthArgs: ["-c", `http.extraHeader=${header}`],
      remoteRef: `refs/pull/${target.changeNumber}/head`,
      secrets: [this.connection.token, basic, header],
    };
  }

  isBotLogin(login: string | undefined): boolean {
    if (!login) return false;
    const botUsername = this.connection.row.bot_username?.toLowerCase();
    return botUsername != null && botUsername !== "" && login.toLowerCase() === botUsername;
  }
}
