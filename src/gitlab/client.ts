/**
 * GitLab API v4 client bound to one forge connection. Slice 3 ships only
 * what webhook command handling needs (discussion lookup, member access
 * level); the review operations (MR metadata, diffs, publication) arrive
 * with GitLabProvider in slice 4 and belong here too.
 */
import type { ForgeDiscussion } from "../forge/types.js";
import type { OpenedConnection } from "../forge/connections.js";
import { SafeHttpError, safeHttpRequest } from "../forge/safe-http.js";

export interface GitLabDiscussionNote {
  id: number;
  body: string;
  author: { id?: number; username?: string };
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
}

export interface GitLabDiscussion {
  id: string;
  individual_note?: boolean;
  notes: GitLabDiscussionNote[];
}

/** Maps GitLab discussions onto the neutral port shape the pipeline shares. */
export function toForgeDiscussions(discussions: GitLabDiscussion[]): ForgeDiscussion[] {
  return discussions.map((discussion) => ({
    id: discussion.id,
    isResolved: discussion.notes.some((note) => note.resolvable && note.resolved) ?? false,
    comments: discussion.notes.map((note) => ({
      id: String(note.id),
      databaseId: note.id,
      body: note.body,
      authorLogin: note.author?.username,
    })),
  }));
}

/**
 * The discussion/membership surface webhook command handling needs. Slice 4's
 * provider extends GitLabApiClient; tests can stub just this shape.
 */
export interface GitLabCommandApi {
  listDiscussions(projectId: number, mergeRequestIid: number): Promise<GitLabDiscussion[]>;
  resolveDiscussion(projectId: number, mergeRequestIid: number, discussionId: string, resolved: boolean): Promise<void>;
  getAccessLevel(projectId: number, userId: number): Promise<number | undefined>;
}

export class GitLabApiClient implements GitLabCommandApi {
  constructor(private readonly connection: OpenedConnection) {}

  private projectPath(projectId: number): string {
    return `${this.connection.instance.apiBaseUrl}/projects/${encodeURIComponent(String(projectId))}`;
  }

  /** GET with the connection's token; bounded and origin-pinned by the safe client. */
  async getJson<T>(path: string): Promise<T> {
    const response = await safeHttpRequest({
      url: path.startsWith("http") ? path : `${this.connection.instance.apiBaseUrl}${path}`,
      instance: this.connection.instance,
      allowPrivateNetwork: this.connection.row.allow_private_network === 1,
      caPem: this.connection.row.ca_pem ?? undefined,
      bearerToken: this.connection.token,
      timeoutMs: 15_000,
      maxBytes: 8 * 1024 * 1024,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new SafeHttpError(`GitLab API returned status ${response.status} for ${path}`, response.status);
    }
    return JSON.parse(response.body) as T;
  }

  async listDiscussions(projectId: number, mergeRequestIid: number): Promise<GitLabDiscussion[]> {
    const discussions: GitLabDiscussion[] = [];
    let page = 1;
    // GitLab paginates at 20 by default; a MR rarely has more than a few
    // hundred discussions, and the cap keeps a hostile instance bounded.
    while (discussions.length < 500) {
      const page_ = await this.getJson<GitLabDiscussion[]>(
        `${this.projectPath(projectId)}/merge_requests/${mergeRequestIid}/discussions?per_page=100&page=${page}`,
      );
      if (!Array.isArray(page_)) break;
      discussions.push(...page_);
      const nextPage = page_.length >= 100 ? page + 1 : 0;
      if (!nextPage) break;
      page = nextPage;
    }
    return discussions;
  }

  async resolveDiscussion(projectId: number, mergeRequestIid: number, discussionId: string, resolved: boolean): Promise<void> {
    const response = await safeHttpRequest({
      method: "PUT",
      url: `${this.projectPath(projectId)}/merge_requests/${mergeRequestIid}/discussions/${encodeURIComponent(discussionId)}?resolved=${resolved}`,
      instance: this.connection.instance,
      allowPrivateNetwork: this.connection.row.allow_private_network === 1,
      caPem: this.connection.row.ca_pem ?? undefined,
      bearerToken: this.connection.token,
      timeoutMs: 15_000,
      maxBytes: 1024 * 1024,
    });
    // GitLab returns 400 when the discussion is not resolvable (system or
    // diff-less notes); treat those as already satisfied.
    if (response.status >= 400 && response.status !== 404 && !(response.status === 400 && !resolved)) {
      throw new SafeHttpError(`could not ${resolved ? "resolve" : "unresolve"} discussion: status ${response.status}`, response.status);
    }
  }

  /**
   * Effective access level of a user on the project (inherited memberships
   * included via /members/all). Returns undefined when the user is not a
   * member — callers fail closed.
   */
  async getAccessLevel(projectId: number, userId: number): Promise<number | undefined> {
    try {
      const member = await this.getJson<{ access_level?: number }>(
        `${this.projectPath(projectId)}/members/all/${encodeURIComponent(String(userId))}`,
      );
      return member.access_level;
    } catch (error) {
      if (error instanceof SafeHttpError && error.status === 404) return undefined;
      throw error;
    }
  }
}

/** GitLab access level (10 guest … 50 owner) mapped to the neutral vocabulary. */
export function accessLevelToPermission(level: number | undefined): "admin" | "maintain" | "write" | "triage" | "read" | "none" {
  if (level == null) return "none";
  if (level >= 50) return "admin";
  if (level >= 40) return "maintain";
  if (level >= 30) return "write";
  if (level >= 20) return "triage";
  if (level >= 10) return "read";
  return "none";
}
