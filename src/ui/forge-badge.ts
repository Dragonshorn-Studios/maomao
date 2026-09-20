/**
 * Forge identity rendering for the dashboard (issue #18, #86): every job is
 * visually attributed with a GitHub/GitLab mark next to its title, with
 * provider-native change identifiers (# for GitHub pulls, ! for GitLab
 * merge requests). Square-bracket prefixes are avoided so a PR titled
 * `[RFC] …` is not preceded by another `[GitHub]`. Text titles (document
 * `<title>`) name the provider without brackets. The full instance hostname
 * stays in the accessible label and, for self-managed hosts, after the id.
 */
import { escapeHtml } from "../util.js";
import { forgeMark } from "./glyphs.js";

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

function canonicalInstance(instance: string): boolean {
  const host = instance.toLowerCase();
  return host === "github.com" || host === "gitlab.com" || host === "";
}

function instanceHost(fields: ForgeBadgeFields): string {
  return canonicalInstance(fields.provider_instance) ? "" : fields.provider_instance;
}

/**
 * Plain-text badge for document titles and copy: no square brackets.
 * `GitHub · acme/widgets #7` or `GitLab · gitlab.corp.internal · team/project !17`.
 */
export function forgeBadgeTitle(fields: ForgeBadgeFields, repoFullName: string, changeNumber: number): string {
  const provider = providerLabel(fields.provider);
  const host = instanceHost(fields);
  const id = `${repoFullName} ${changeIdentifier(fields.provider, changeNumber)}`;
  return host ? `${provider} · ${host} · ${id}` : `${provider} · ${id}`;
}

/**
 * Filter-chip label: collapses the canonical public instances to the
 * provider name and qualifies everything else with its hostname.
 */
export function forgeChipLabel(scope: ForgeBadgeFields): string {
  const host = instanceHost(scope);
  return host ? `${providerLabel(scope.provider)} · ${host}` : providerLabel(scope.provider);
}

/** Accessible provider + host for the icon `title` / `aria-label`. */
export function forgeMarkLabel(fields: ForgeBadgeFields): string {
  const host = instanceHost(fields);
  return host ? `${providerLabel(fields.provider)} · ${host}` : providerLabel(fields.provider);
}

/**
 * Inline mark + repository + native id. Self-managed hosts render after the
 * identifier so they cannot be mistaken for a `[tag]` on the PR title.
 */
export function forgeBadgeTitleHtml(fields: ForgeBadgeFields, repoFullName: string, changeNumber: number): string {
  const label = forgeMarkLabel(fields);
  const mark = forgeMark(fields.provider);
  const icon = mark
    ? `<span class="forge-mark" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${mark}</span>`
    : `<span class="forge-mark forge-mark-text">${escapeHtml(label)}</span> `;
  const id = `${escapeHtml(repoFullName)} ${escapeHtml(changeIdentifier(fields.provider, changeNumber))}`;
  const host = instanceHost(fields);
  const hostBit = host ? ` <span class="muted forge-host">${escapeHtml(host)}</span>` : "";
  return `${icon}${id}${hostBit}`;
}
