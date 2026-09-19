/**
 * Resolves the ForgePort bound to the connection a job belongs to. Slice 1
 * knows only the environment-configured GitHub App connection; the connection
 * registry (forge_connections) extends this to GitLab instances later. The
 * resolve is the single place a job's provider identity turns into API calls,
 * so credentials and rate limits can never cross connections.
 */
import type { GithubPortWithPulls } from "./github-provider.js";
import { GitHubProvider } from "./github-provider.js";
import type { ForgePort } from "./port.js";
import { GITHUB_PROVIDER, normalizeScope } from "./types.js";

export interface ForgeJobIdentity {
  provider: string | null;
  provider_instance: string | null;
  installation_id: number;
}

export class ForgeRegistry {
  constructor(
    private readonly githubClient: GithubPortWithPulls,
    private readonly appSlug: string,
    private readonly getToken?: (installationId: number) => Promise<string>,
  ) {}

  /** Port bound to the connection that owns `job`. Unknown providers fail closed. */
  forJob(job: ForgeJobIdentity): ForgePort {
    const scope = normalizeScope({ provider: job.provider ?? undefined, instance: job.provider_instance ?? undefined });
    if (scope.provider !== GITHUB_PROVIDER) {
      throw new Error(`no forge connection configured for ${scope.provider}:${scope.instance}`);
    }
    return new GitHubProvider(this.githubClient, job.installation_id, this.appSlug, this.getToken);
  }
}
