import type { Config } from "../config.js";
import { authorizeGithubAccount, authorizeGithubRepository } from "./authorize.js";
import type { GithubPort } from "./client.js";

export interface GithubInstallationRepoOption {
  fullName: string;
  installationId: number;
  repositoryId: number;
  accountId: number | null;
}

/** Allowlist-filtered repositories visible to the configured GitHub App. */
export async function enumerateGithubInstallationRepositories(
  github: Pick<GithubPort, "listAppInstallations" | "listInstallationRepositories">,
  config: Config,
  logPrefix: string,
): Promise<GithubInstallationRepoOption[]> {
  if (!github.listAppInstallations || !github.listInstallationRepositories) {
    throw new Error("this GitHub client does not support repository enumeration");
  }
  const options: GithubInstallationRepoOption[] = [];
  const installations = await github.listAppInstallations();
  for (const installation of installations) {
    const subject = { installationId: installation.id, accountId: installation.accountId };
    if (!authorizeGithubAccount(config, subject).ok) continue;
    try {
      const repos = await github.listInstallationRepositories(installation.id);
      for (const repo of repos) {
        if (!authorizeGithubRepository(config, { ...subject, repositoryId: repo.id }).ok) continue;
        options.push({ fullName: repo.fullName, installationId: installation.id, repositoryId: repo.id, accountId: installation.accountId });
      }
    } catch (error) {
      console.warn(`${logPrefix}: could not list repositories for installation ${installation.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return options.sort((a, b) => a.fullName.localeCompare(b.fullName)).slice(0, 500);
}
