/**
 * Resolves the ForgePort bound to the connection a job belongs to: the
 * env-configured GitHub App for github-scoped rows, the matching persisted
 * forge connection for everything else. The resolve is the single place a
 * job's provider identity becomes an adapter; adapter state (tokens,
 * rate-limit budgets) must never be shared across connections. Unknown
 * providers and unresolvable connections fail closed; a missing scope falls
 * back to the default GitHub connection (legacy rows).
 */
import type { GithubPortWithPulls } from "./github-provider.js";
import { GitHubProvider } from "./github-provider.js";
import type { ForgeConnectionStore } from "./connections.js";
import { GitLabProvider } from "../gitlab/provider.js";
import type { ForgePort } from "./port.js";
import { GITHUB_INSTANCE, GITHUB_PROVIDER, normalizeScope } from "./types.js";

export interface ForgeJobIdentity {
  provider: string | null;
  provider_instance: string | null;
  /** Connection binding for non-default forges (GitLab). */
  forge_connection_id?: string | null;
  installation_id: number;
}

export class ForgeRegistry {
  constructor(
    private readonly githubClient: GithubPortWithPulls,
    private readonly appSlug: string,
    private readonly getToken?: (installationId: number) => Promise<string>,
    private readonly connections?: ForgeConnectionStore,
  ) {}

  /** Port bound to the connection that owns `job`. Unresolvable jobs fail closed. */
  forJob(job: ForgeJobIdentity): ForgePort {
    const scope = normalizeScope({
      provider: job.provider ?? undefined,
      instance: job.provider_instance ?? undefined,
    });
    if (scope.provider === GITHUB_PROVIDER) {
      if (job.forge_connection_id) {
        throw new Error(
          `job references forge connection ${job.forge_connection_id}; github-scoped jobs use the environment connection`,
        );
      }
      const forge = new GitHubProvider(this.githubClient, job.installation_id, this.appSlug, this.getToken);
      if (scope.instance !== GITHUB_INSTANCE || forge.instance !== scope.instance) {
        throw new Error(`no forge connection configured for ${scope.provider}:${scope.instance}`);
      }
      return forge;
    }
    // Persisted connections: the job's binding must exist, be enabled, and
    // belong to the same provider+instance as the row's scope.
    if (!this.connections) {
      throw new Error(`no forge connection configured for ${scope.provider}:${scope.instance}`);
    }
    if (!job.forge_connection_id) {
      throw new Error(`${scope.provider}-scoped job is missing its forge connection binding`);
    }
    const raw = this.connections.get(job.forge_connection_id);
    if (!raw || raw.provider !== scope.provider || raw.enabled !== 1) {
      throw new Error(`forge connection ${job.forge_connection_id} is not available for ${scope.provider}:${scope.instance}`);
    }
    const opened = this.connections.open(job.forge_connection_id);
    if (opened.instance.hostname !== scope.instance) {
      throw new Error(
        `forge connection ${opened.row.id} serves ${opened.instance.hostname}, not ${scope.instance}`,
      );
    }
    const forge = new GitLabProvider(opened);
    if (forge.provider !== scope.provider || forge.instance !== scope.instance) {
      throw new Error(`forge adapter identity ${forge.provider}:${forge.instance} does not match job scope`);
    }
    return forge;
  }
}
