/**
 * Resolves the ForgePort bound to the connection a job belongs to. Slice 1
 * knows only the environment-configured GitHub App connection; the connection
 * registry (forge_connections) extends this to GitLab instances later. The
 * resolve is the single place a job's provider identity becomes an adapter;
 * adapter state (tokens, rate-limit budgets) must never be shared across
 * connections. Non-GitHub providers and non-default connections fail closed;
 * a missing provider falls back to the default GitHub scope (legacy rows).
 */
import type { GithubPortWithPulls } from "./github-provider.js";
import { GitHubProvider } from "./github-provider.js";
import type { ForgePort } from "./port.js";
import { GITHUB_INSTANCE, GITHUB_PROVIDER, normalizeScope } from "./types.js";

export interface ForgeJobIdentity {
  provider: string | null;
  provider_instance: string | null;
  /** Set on non-default connections; unresolvable until the connection registry ships. */
  forge_connection_id?: string | null;
  installation_id: number;
}

export class ForgeRegistry {
  constructor(
    private readonly githubClient: GithubPortWithPulls,
    private readonly appSlug: string,
    private readonly getToken?: (installationId: number) => Promise<string>,
  ) {}

  /** Port bound to the connection that owns `job`. Unknown connections fail closed. */
  forJob(job: ForgeJobIdentity): ForgePort {
    if (job.forge_connection_id) {
      throw new Error(
        `job references forge connection ${job.forge_connection_id}; non-default connections are not resolvable yet`,
      );
    }
    const scope = normalizeScope({
      provider: job.provider ?? undefined,
      instance: job.provider_instance ?? undefined,
    });
    if (scope.provider !== GITHUB_PROVIDER || scope.instance !== GITHUB_INSTANCE) {
      throw new Error(`no forge connection configured for ${scope.provider}:${scope.instance}`);
    }
    const forge = new GitHubProvider(this.githubClient, job.installation_id, this.appSlug, this.getToken);
    // The port's declared identity must match the scope it was resolved for;
    // a mismatch means the adapter and the storage row disagree on connection.
    if (forge.provider !== scope.provider || forge.instance !== scope.instance) {
      throw new Error(`forge adapter identity ${forge.provider}:${forge.instance} does not match job scope`);
    }
    return forge;
  }
}
