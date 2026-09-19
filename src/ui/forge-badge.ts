/**
 * Forge identity rendering for the dashboard (issue #18): every job is
 * visually attributed to its forge and instance next to its title, with
 * provider-native change identifiers (# for GitHub pulls, ! for GitLab
 * merge requests). Text and wordmark only — never color alone — and the
 * full instance hostname stays in the accessible label.
 */
import { escapeHtml } from "../util.js";

export interface ForgeBadgeFields {
  provider: string;
  provider_instance: string;
}

/** Human label for a provider; unknown providers render as-is. */
export function providerLabel(provider: string): string {
  switch (provider.toLowerCase()) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    default:
      return provider;
  }
}

/** Provider-native change identifier: #7 on GitHub, !7 on GitLab. */
export function changeIdentifier(provider: string, changeNumber: number): string {
  return provider.toLowerCase() === "gitlab" ? `!${changeNumber}` : `#${changeNumber}`;
}

/**
 * The inline badge + repository + native id, e.g.
 * `[GitHub] acme/widgets #7` or `[GitLab · gitlab.corp.internal] acme/widgets !7`.
 * Self-managed (non-canonical) instances always show the hostname; the
 * canonical public forges collapse to the provider name alone.
 */
export function forgeBadgeTitle(fields: ForgeBadgeFields, repoFullName: string, changeNumber: number): string {
  const provider = providerLabel(fields.provider);
  const instance = fields.provider_instance.toLowerCase();
  const hostSuffix =
    instance === "github.com" || instance === "gitlab.com" || instance === "" ? "" : ` · ${fields.provider_instance}`;
  return `[${provider}${hostSuffix}] ${repoFullName} ${changeIdentifier(fields.provider, changeNumber)}`;
}

/** Escaped HTML form of {@link forgeBadgeTitle}. */
export function forgeBadgeTitleHtml(fields: ForgeBadgeFields, repoFullName: string, changeNumber: number): string {
  return escapeHtml(forgeBadgeTitle(fields, repoFullName, changeNumber));
}
