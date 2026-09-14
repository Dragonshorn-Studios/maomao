import type { Config } from "../config.js";

export interface GithubAuthSubject {
  installationId?: number;
  accountId?: number;
  repositoryId?: number;
}

export type GithubAuthDecision = { ok: true } | { ok: false; reason: string };

export function authorizeGithubAccount(config: Config, subject: GithubAuthSubject): GithubAuthDecision {
  const accounts = config.allowedGithubAccountIds;
  if (accounts.length === 0) return { ok: true };
  if (subject.accountId == null || !Number.isSafeInteger(subject.accountId) || subject.accountId <= 0) {
    return { ok: false, reason: "missing account id" };
  }
  if (!accounts.includes(subject.accountId)) {
    return { ok: false, reason: "unauthorized account" };
  }
  return { ok: true };
}

export function authorizeGithubRepository(config: Config, subject: GithubAuthSubject): GithubAuthDecision {
  const repositories = config.allowedGithubRepositoryIds;
  if (repositories.length === 0) return { ok: true };
  if (subject.repositoryId == null || !Number.isSafeInteger(subject.repositoryId) || subject.repositoryId <= 0) {
    return { ok: false, reason: "missing repository id" };
  }
  if (!repositories.includes(subject.repositoryId)) {
    return { ok: false, reason: "unauthorized repository" };
  }
  return { ok: true };
}

/**
 * Server-side allowlist for GitHub App installations and repositories.
 * Empty allowlists are unrestricted on that axis (legacy / local). When an
 * allowlist is set, missing IDs fail closed so renames cannot skip the check.
 */
export function authorizeGithubTarget(config: Config, subject: GithubAuthSubject): GithubAuthDecision {
  const account = authorizeGithubAccount(config, subject);
  if (!account.ok) return account;
  return authorizeGithubRepository(config, subject);
}

/** Log only stable numeric IDs and the rejection reason — never names, URLs, or authors. */
export function logAuthorizationRejection(subject: GithubAuthSubject & { reason: string }): void {
  console.warn(
    JSON.stringify({
      msg: "github authorization rejected",
      installation_id: subject.installationId ?? null,
      repository_id: subject.repositoryId ?? null,
      reason: subject.reason,
    }),
  );
}

export function authorizationLogLine(subject: GithubAuthSubject & { reason: string }): string {
  return `installation_id=${subject.installationId ?? "none"} repository_id=${subject.repositoryId ?? "none"} reason=${subject.reason}`;
}
