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

interface GitLabDiscussionPage {
  id: string;
  notes: Array<{ id: number; body: string; system?: boolean; resolvable?: boolean; resolved?: boolean; author?: { username?: string } }>;
}

/** GitLab truncates notes well below this; chunks stay readable and accepted. */
const MAX_DEGRADE_NOTE_CHARS = 30_000;

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
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new SafeHttpError(
        `GitLab API returned a non-JSON body (status ${response.status}, type ${response.contentType ?? "none"}) for ${url}: ${response.body.slice(0, 80)}`,
        response.status,
      );
    }
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
    // Bounded pagination: long-lived MRs accumulate hundreds of notes and a
    // single-page scan would silently duplicate reviews.
    const summaries: ForgeSummary[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const notes = await this.request<GitLabNote[]>(
        "GET",
        `${this.mrPath(this.projectIdOf(target), target.changeNumber)}/notes?per_page=100&page=${page}&sort=desc&order_by=created_at`,
        { maxBytes: 8 * 1024 * 1024 },
      );
      if (!Array.isArray(notes)) break;
      for (const note of notes) {
        if (!note.system && (note.body ?? "").includes("<!-- maomao-review")) {
          summaries.push({ id: String(note.id), body: note.body ?? "" });
        }
      }
      if (notes.length < 100) break;
    }
    return summaries;
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
    const degraded: Array<{ path: string; line: number; body: string; reason: string }> = [];
    for (const comment of input.comments) {
      try {
        await this.postInlineDiscussion(projectId, input.target.changeNumber, input.commitId, comment);
        posted.push(comment);
      } catch (error) {
        // An invalid or stale position degrades to a body note carrying the
        // finding (its comment body begins with the fingerprint marker) — the
        // raw error stays out of reader-visible text.
        const reason = error instanceof SafeHttpError ? `status ${error.status ?? "unknown"}` : "unanchorable position";
        degraded.push({ path: comment.path, line: comment.line, body: comment.body, reason });
      }
    }
    const warnings: string[] = [];
    if (degraded.length > 0) {
      // Chunked so a long batch cannot exceed GitLab's note size limit.
      const entries = degraded.map(
        (entry) => `${entry.body}\n\n_${entry.path}:${entry.line} could not be anchored inline (${entry.reason}); listed here instead._`,
      );
      const chunks: string[] = [];
      let current = "";
      for (const entry of entries) {
        if (current.length > 0 && current.length + entry.length > MAX_DEGRADE_NOTE_CHARS) {
          chunks.push(current);
          current = "";
        }
        current = current.length > 0 ? `${current}\n\n${entry}` : entry;
      }
      if (current.length > 0) chunks.push(current);
      for (const chunk of chunks) {
        try {
          await this.request("POST", `${this.mrPath(projectId, input.target.changeNumber)}/notes`, {
            body: { body: chunk },
          });
        } catch (error) {
          warnings.push(
            `a degrade note for ${degraded.length} inline finding(s) could not be posted: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Approval is capability-gated: only when the connection policy allows
    // it and the forge accepts; otherwise the verdict degrades to comments
    // while the stored verdict keeps Maomao's internal decision.
    if (input.verdict === "APPROVE" && this.connection.row.allow_approve === 1) {
      // Capability-gated; a rejection is surfaced as a warning so the stored
      // verdict can be reconciled with what the forge actually accepted.
      try {
        await this.request("PUT", `${this.mrPath(projectId, input.target.changeNumber)}/approve`);
      } catch (error) {
        warnings.push(
          `approval was rejected by the instance: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { id: noteId, url: "", postedComments: posted, warnings };
  }

  private async postInlineDiscussion(
    projectId: number,
    iid: number,
    commitId: string,
    comment: ForgePublishInput["comments"][number],
  ): Promise<void> {
    // Anchor to the version of the EXACT SHA the job reviewed. Anchoring to
    // the live head would silently attach reviewed line numbers to a newer
    // diff; a rewritten history (no matching version) degrades the comment.
    const refs = await this.diffRefsForCommit(projectId, iid, commitId);
    const position: Record<string, unknown> = {
      position_type: "text",
      base_sha: refs.base,
      start_sha: refs.start,
      head_sha: refs.head,
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

  private diffRefsCache = new Map<string, { base: string; start: string; head: string }>();

  private async diffRefsForCommit(
    projectId: number,
    iid: number,
    commitId: string,
  ): Promise<{ base: string; start: string; head: string }> {
    const cacheKey = `${projectId}:${iid}:${commitId}`;
    const cached = this.diffRefsCache.get(cacheKey);
    if (cached) return cached;
    // Newer heads first; the reviewed SHA may be any version in the history.
    for (let page = 1; page <= 5; page += 1) {
      const versions = await this.request<GitLabDiffVersion[]>(
        "GET",
        `${this.mrPath(projectId, iid)}/versions?per_page=100&page=${page}`,
      );
      if (!Array.isArray(versions) || versions.length === 0) break;
      const match = versions.find((version) => version.head_sha === commitId);
      if (match?.base_sha && match.head_sha) {
        const refs = { base: match.base_sha, start: match.start_sha ?? match.base_sha, head: match.head_sha };
        this.diffRefsCache.set(cacheKey, refs);
        return refs;
      }
      if (versions.length < 100) break;
    }
    throw new SafeHttpError(
      `merge request history has no diff version for the reviewed sha ${commitId}; the MR moved past the reviewed commit`,
    );
  }

  /**
   * GitLab returns a BARE ARRAY from the discussions endpoint (not a
   * wrapper object); bounded pagination follows while full pages come back.
   * The 5-page/500-discussion bound means discussions past the cap are
   * invisible to reconciliation (forge-resolved priors stop re-checking,
   * late buries are missed) — the same documented trade-off as the webhook
   * path's processing cap, minus its refusal-to-act signal.
   */
  async listDiscussions(target: ForgeRepoTarget): Promise<ForgeDiscussion[]> {
    const discussions: ForgeDiscussion[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const page_ = await this.request<GitLabDiscussionPage[]>(
        "GET",
        `${this.mrPath(this.projectIdOf(target), target.changeNumber)}/discussions?per_page=100&page=${page}`,
        { maxBytes: 8 * 1024 * 1024 },
      );
      if (!Array.isArray(page_)) {
        // This bug class previously zeroed reconciliation silently; keep it
        // visible if the endpoint shape drifts again.
        console.error(`gitlab webhook: discussions endpoint returned a non-array body (page ${page}); treating as no discussions`);
        break;
      }
      discussions.push(...page_.map((discussion) => ({
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
      })));
      if (page_.length < 100) break;
    }
    return discussions;
  }

  async resolveDiscussion(target: ForgeRepoTarget, discussionId: string): Promise<void> {
    await this.request("PUT", `${this.mrPath(this.projectIdOf(target), target.changeNumber)}/discussions/${encodeURIComponent(discussionId)}?resolved=true`);
  }

  async unresolveDiscussion(target: ForgeRepoTarget, discussionId: string): Promise<void> {
    await this.request("PUT", `${this.mrPath(this.projectIdOf(target), target.changeNumber)}/discussions/${encodeURIComponent(discussionId)}?resolved=false`);
  }

  async getActorPermission(target: ForgeRepoTarget, username: string): Promise<ForgePermission> {
    // /users?username= is exact-match, but verify the returned username rather
    // than trusting positional behavior across self-managed versions. Only
    // "user does not exist / not a member" fails closed to none; transport
    // and auth failures propagate so the caller can log the demotion.
    const users = await this.request<Array<{ id?: number; username?: string }>>(
      "GET",
      `${this.connection.instance.apiBaseUrl}/users?username=${encodeURIComponent(username)}`,
    );
    const match = users.find((candidate) => candidate.username?.toLowerCase() === username.toLowerCase());
    const userId = match?.id;
    if (!Number.isSafeInteger(userId)) return "none";
    try {
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
    } catch (error) {
      if (error instanceof SafeHttpError && error.status === 404) return "none";
      throw error;
    }
  }

  async cloneSpec(target: ForgeRepoTarget): Promise<ForgeCloneSpec> {
    const token = this.connection.token;
    // GitLab documents token-as-password (any username, conventionally
    // oauth2) for git-over-HTTPS; Bearer is REST-only and can 401 on older
    // self-managed instances.
    const basic = Buffer.from(`oauth2:${token}`, "utf8").toString("base64");
    const header = `Authorization: Basic ${basic}`;
    return {
      cloneUrl: `https://${this.instance}/${target.repoFullName}.git`,
      gitAuthArgs: ["-c", `http.extraHeader=${header}`],
      remoteRef: `refs/merge-requests/${target.changeNumber}/head`,
      secrets: [token, basic, header],
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
