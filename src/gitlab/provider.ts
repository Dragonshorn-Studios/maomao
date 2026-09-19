/**
 * GitLabProvider: binds one forge connection to the forge-neutral port for
 * merge-request reviews. API v4 through the safe-http boundary; inline
 * comments use position objects with diff refs; credentials never appear in
 * clone URLs, logs, or model context.
 */
import type { ForgePort } from "../forge/port.js";
import type { OpenedConnection } from "../forge/connections.js";
import { SafeHttpError, safeHttpRequest } from "../forge/safe-http.js";
import { reviewMarker } from "../prompts.js";
import type {
  ForgeChange,
  ForgeCloneSpec,
  ForgeDiscussion,
  ForgePermission,
  ForgePublishInput,
  ForgePublishResult,
  ForgeRepoTarget,
  ForgeSummary,
} from "../forge/types.js";

interface GitLabMergeRequestResponse {
  iid: number;
  title?: string;
  description?: string | null;
  state?: string;
  web_url?: string;
  author?: { username?: string };
  source_branch?: string;
  target_branch?: string;
  sha?: string;
  diff_refs?: { base_sha?: string; start_sha?: string; head_sha?: string };
  work_in_progress?: boolean;
  draft?: boolean;
}

interface GitLabChange {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff?: string;
}

interface GitLabDiffVersion {
  base_sha?: string;
  start_sha?: string;
  head_sha?: string;
}

interface GitLabNote {
  id: number;
  body?: string;
  system?: boolean;
  author?: { username?: string };
}

export class GitLabProvider implements ForgePort {
  readonly provider = "gitlab";
  readonly instance: string;

  constructor(private readonly connection: OpenedConnection) {
    this.instance = connection.instance.hostname;
  }

  private projectPath(projectId: number): string {
    return `${this.connection.instance.apiBaseUrl}/projects/${encodeURIComponent(String(projectId))}`;
  }

  private mrPath(projectId: number, iid: number): string {
    return `${this.projectPath(projectId)}/merge_requests/${iid}`;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    url: string,
    opts: { body?: Record<string, unknown>; maxBytes?: number; timeoutMs?: number } = {},
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
      throw new SafeHttpError(`GitLab API returned status ${response.status} for ${url}`, response.status);
    }
    return JSON.parse(response.body) as T;
  }

  async getChange(target: ForgeRepoTarget): Promise<ForgeChange> {
    const mr = await this.request<GitLabMergeRequestResponse>(
      "GET",
      `${this.mrPath(this.projectIdOf(target), target.changeNumber)}`,
    );
    return this.toForgeChange(target, mr);
  }

  private toForgeChange(target: ForgeRepoTarget, mr: GitLabMergeRequestResponse): ForgeChange {
    if (!mr.sha || !mr.diff_refs?.base_sha) {
      throw new SafeHttpError("merge request response is missing sha or diff_refs");
    }
    return {
      repoOwner: target.repoOwner,
      repoName: target.repoName,
      repoFullName: target.repoFullName,
      changeNumber: target.changeNumber,
      title: mr.title ?? "",
      body: mr.description ?? "",
      htmlUrl: mr.web_url ?? "",
      author: mr.author?.username ?? "",
      baseSha: mr.diff_refs.base_sha,
      headSha: mr.sha,
      baseRef: mr.target_branch ?? "",
      headRef: mr.source_branch ?? "",
      draft: Boolean(mr.work_in_progress || mr.draft),
    };
  }

  async getChangeDiff(target: ForgeRepoTarget, maxBytes?: number): Promise<string> {
    const changes = await this.request<{ changes?: GitLabChange[] }>(
      "GET",
      `${this.mrPath(this.projectIdOf(target), target.changeNumber)}/changes?access_raw_diffs=true`,
      { maxBytes: maxBytes ? maxBytes * 4 : undefined },
    );
    return renderChangesDiff(changes.changes ?? []);
  }

  async getCommitDiff(target: Omit<ForgeRepoTarget, "changeNumber">, sha: string): Promise<string> {
    const changes = await this.request<GitLabChange[]>(
      "GET",
      `${this.projectPath(this.projectIdOf({ ...target, changeNumber: 0 }))}/repository/commits/${encodeURIComponent(sha)}/diff`,
    );
    return renderChangesDiff(changes);
  }

  /**
   * The provider-native project id rides in the job's installation_id column
   * and reaches the provider through ForgeRepoTarget.nativeProjectId.
   */
  private projectIdOf(target: ForgeRepoTarget): number {
    if (!Number.isSafeInteger(target.nativeProjectId) || (target.nativeProjectId ?? 0) <= 0) {
      throw new SafeHttpError(`forge target for ${target.repoFullName} is missing its native project id`);
    }
    return target.nativeProjectId!;
  }

  async listSummaries(target: ForgeRepoTarget): Promise<ForgeSummary[]> {
    const notes = await this.request<GitLabNote[]>(
      "GET",
      `${this.mrPath(this.projectIdOf(target), target.changeNumber)}/notes?per_page=100&sort=desc&order_by=created_at`,
      { maxBytes: 8 * 1024 * 1024 },
    );
    return notes
      .filter((note) => !note.system && (note.body ?? "").includes("<!-- maomao-review"))
      .slice(0, 100)
      .map((note) => ({ id: String(note.id), body: note.body ?? "" }));
  }

  async publishReview(input: ForgePublishInput): Promise<ForgePublishResult> {
    const projectId = this.projectIdOf(input.target);
    // Idempotency: a Maomao summary note for this head SHA already posted.
    const existing = await this.listSummaries(input.target);
    const already = existing.find((summary) => summary.body.includes(reviewMarker(input.commitId)));
    if (already) {
      return { id: already.id, url: "", postedComments: [] };
    }

    const note = await this.request<{ id?: number }>("POST", `${this.mrPath(projectId, input.target.changeNumber)}/notes`, {
      body: { body: input.body },
    });
    const noteId = note.id != null ? String(note.id) : "";

    const posted: ForgePublishInput["comments"] = [];
    for (const comment of input.comments) {
      try {
        await this.postInlineDiscussion(projectId, input.target.changeNumber, input.target, input.commitId, comment);
        posted.push(comment);
      } catch (error) {
        // An invalid or stale position degrades to the summary listing —
        // never loses the finding, never fails the publish.
        const message = error instanceof Error ? error.message : String(error);
        await this.request("POST", `${this.mrPath(projectId, input.target.changeNumber)}/notes`, {
          body: {
            body: `_${message.slice(0, 200)} — inline location was not anchorable; see the summary listing._`,
          },
        }).catch(() => undefined);
      }
    }

    // Approval is capability-gated: only when the connection policy allows
    // it and the forge accepts; otherwise the verdict degrades to comments
    // while the stored verdict keeps Maomao's internal decision.
    if (input.verdict === "APPROVE" && this.connection.row.allow_approve === 1) {
      // Capability-gated; a rejection degrades to the comment-only review
      // that was already posted above. The stored verdict is unchanged.
      await this.request("PUT", `${this.mrPath(projectId, input.target.changeNumber)}/approve`).catch(() => undefined);
    }
    return { id: noteId, url: "", postedComments: posted };
  }

  private async postInlineDiscussion(
    projectId: number,
    iid: number,
    target: ForgeRepoTarget,
    commitId: string,
    comment: ForgePublishInput["comments"][number],
  ): Promise<void> {
    const refs = await this.diffRefs(projectId, iid);
    const position: Record<string, unknown> = {
      position_type: "text",
      base_sha: refs.base,
      start_sha: refs.start,
      head_sha: refs.head || commitId,
      old_path: comment.path,
      new_path: comment.path,
    };
    if (comment.side === "LEFT") {
      position.old_line = comment.line;
    } else {
      position.new_line = comment.line;
    }
    await this.request("POST", `${this.mrPath(projectId, iid)}/discussions`, {
      body: { body: comment.body, position },
    });
  }

  private diffRefsCache = new Map<number, { base: string; start: string; head: string }>();

  private async diffRefs(projectId: number, iid: number): Promise<{ base: string; start: string; head: string }> {
    const cached = this.diffRefsCache.get(projectId * 1_000_000 + iid);
    if (cached) return cached;
    const versions = await this.request<GitLabDiffVersion[]>(
      "GET",
      `${this.mrPath(projectId, iid)}/versions?per_page=1`,
    );
    const latest = versions[0];
    if (!latest?.base_sha || !latest.head_sha) {
      throw new SafeHttpError("merge request has no diff versions; cannot anchor inline comments");
    }
    const refs = { base: latest.base_sha, start: latest.start_sha ?? latest.base_sha, head: latest.head_sha };
    this.diffRefsCache.set(projectId * 1_000_000 + iid, refs);
    return refs;
  }

  async listDiscussions(target: ForgeRepoTarget): Promise<ForgeDiscussion[]> {
    const page = await this.request<{ discussions?: Array<{ id: string; notes: Array<{ id: number; body: string; system?: boolean; resolvable?: boolean; resolved?: boolean; author?: { username?: string } }> }> }>(
      "GET",
      `${this.mrPath(this.projectIdOf(target), target.changeNumber)}/discussions?per_page=100`,
      { maxBytes: 8 * 1024 * 1024 },
    );
    return (page.discussions ?? []).map((discussion) => ({
      id: discussion.id,
      isResolved: discussion.notes.some((note) => note.resolvable === true && note.resolved === true),
      comments: discussion.notes
        .filter((note) => !note.system)
        .map((note) => ({
          id: String(note.id),
          databaseId: note.id,
          body: note.body,
          authorLogin: note.author?.username,
        })),
    }));
  }

  async resolveDiscussion(target: ForgeRepoTarget, discussionId: string): Promise<void> {
    await this.request("PUT", `${this.mrPath(this.projectIdOf(target), target.changeNumber)}/discussions/${encodeURIComponent(discussionId)}?resolved=true`);
  }

  async unresolveDiscussion(target: ForgeRepoTarget, discussionId: string): Promise<void> {
    await this.request("PUT", `${this.mrPath(this.projectIdOf(target), target.changeNumber)}/discussions/${encodeURIComponent(discussionId)}?resolved=false`);
  }

  async getActorPermission(target: ForgeRepoTarget, username: string): Promise<ForgePermission> {
    // Member lookup by username requires the users API; project members are
    // queried by id, so resolve the username first (fail closed on miss).
    try {
      const users = await this.request<Array<{ id?: number }>>(
        "GET",
        `${this.connection.instance.apiBaseUrl}/users?username=${encodeURIComponent(username)}`,
      );
      const userId = users[0]?.id;
      if (!Number.isSafeInteger(userId)) return "none";
      const level = await this.request<{ access_level?: number }>(
        "GET",
        `${this.projectPath(this.projectIdOf(target))}/members/all/${userId}`,
      );
      const value = level.access_level ?? 0;
      if (value >= 50) return "admin";
      if (value >= 40) return "maintain";
      if (value >= 30) return "write";
      if (value >= 20) return "triage";
      if (value >= 10) return "read";
      return "none";
    } catch {
      return "none";
    }
  }

  async cloneSpec(target: ForgeRepoTarget): Promise<ForgeCloneSpec> {
    const token = this.connection.token;
    return {
      cloneUrl: `https://${this.instance}/${target.repoFullName}.git`,
      gitAuthArgs: ["-c", `http.extraHeader=Authorization: Bearer ${token}`],
      remoteRef: `refs/merge-requests/${target.changeNumber}/head`,
      secrets: [token, `Bearer ${token}`, `http.extraHeader=Authorization: Bearer ${token}`],
    };
  }

  /**
   * The GitLab bot is a service-account user; its probed username is the
   * authoritative identity. Marker-based ownership remains the primary
   * guard for comment content.
   */
  isBotLogin(login: string | undefined): boolean {
    if (!login) return false;
    const botUsername = this.connection.row.bot_username?.toLowerCase();
    return botUsername != null && botUsername !== "" && login.toLowerCase() === botUsername;
  }
}

/**
 * Renders GitLab per-file change records into one unified diff string the
 * shared hunk-anchoring code can parse.
 */
export function renderChangesDiff(changes: GitLabChange[]): string {
  return changes
    .map((change) => {
      const oldPath = change.old_path ?? "";
      const newPath = change.new_path ?? "";
      // Trailing newlines are normalized so joined file sections stay clean.
      const body = (change.diff ?? "").replace(/\n$/, "");
      const hasHeaderLines = body.startsWith("--- ") || body.includes("\n+++ ");
      const header = [
        `diff --git a/${oldPath} b/${newPath}`,
        change.new_file ? "new file mode 100644" : "",
        change.deleted_file ? "deleted file mode 100644" : "",
      ]
        .filter(Boolean)
        .join("\n");
      // GitLab's raw diff already carries the ---/+++ lines; only synthesize
      // them when the record arrived without them.
      return hasHeaderLines ? `${header}\n${body}` : `${header}\n--- ${change.new_file ? "/dev/null" : `a/${oldPath}`}\n+++ ${change.deleted_file ? "/dev/null" : `b/${newPath}`}\n${body}`;
    })
    .join("\n");
}
