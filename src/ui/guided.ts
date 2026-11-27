import { escapeHtml } from "../util.js";
import type { GuidedInboxItem, GuidedInboxPage } from "../guided/inbox.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";

function qs(filters: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "" && value !== "all" && value !== 0) params.set(key, String(value));
  }
  const out = params.toString();
  return out ? `?${out}` : "";
}

function guidedHref(item: Pick<GuidedInboxItem, "repoFullName" | "prNumber">): string {
  const [owner, repo] = item.repoFullName.split("/");
  return `/guided/github/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${item.prNumber}`;
}

function stateLabel(state: string | undefined): string {
  if (!state) return "No Maomao review";
  return `Maomao ${state.replaceAll("_", " ")}`;
}

function inboxRow(item: GuidedInboxItem, csrfToken: string | undefined): string {
  const requested = item.reviewRequested === undefined ? "review state unknown" : item.reviewRequested ? "review requested" : "no review requested";
  const guided = item.guidedState === "current"
    ? `Draft current${item.guidedCommentCount ? ` · ${item.guidedCommentCount} comment${item.guidedCommentCount === 1 ? "" : "s"}` : ""}`
    : item.guidedState === "stale"
      ? "Draft pinned to older SHAs"
      : item.guidedState === "historical"
        ? "Historical draft"
        : "No guided draft";
  return `<li class="guided-inbox-row">
    <a class="guided-inbox-main" href="${guidedHref(item)}">
      <span class="guided-inbox-title">${escapeHtml(item.title)}</span>
      <span class="guided-inbox-meta"><strong>${escapeHtml(item.repoFullName)}#${item.prNumber}</strong> · ${escapeHtml(item.author || "unknown author")}${item.draft ? " · forge draft" : ""}${item.updatedAt ? ` · updated ${escapeHtml(item.updatedAt.slice(0, 10))}` : ""}</span>
    </a>
    <span class="guided-inbox-facts">
      <span class="job-chip" data-state="${escapeHtml(item.maomaoState ?? "none")}">${escapeHtml(stateLabel(item.maomaoState))}</span>
      <span class="muted">${escapeHtml(requested)}</span>
      <span class="muted">${escapeHtml(guided)}</span>
      <form method="post" action="${guidedHref(item)}/open">${csrfInput(csrfToken)}<button class="if-button if-button--sm" type="submit">Open</button></form>
    </span>
  </li>`;
}

export function renderGuidedInboxPage(input: {
  options: PageOptions;
  page: GuidedInboxPage;
  filters: { repo?: string; author?: string; reviewState?: string; maomaoState?: string };
  directUrl?: string;
  directError?: string;
}): string {
  const { page, filters } = input;
  const filterQuery = { ...filters };
  const newerOffset = Math.max(0, page.offset - page.limit);
  const olderOffset = page.offset + page.limit;
  const rows = page.items.map((item) => inboxRow(item, input.options.csrfToken)).join("\n");
  const repoOptions = page.repos.map((repo) => `<option value="${escapeHtml(repo)}"${filters.repo === repo ? " selected" : ""}>${escapeHtml(repo)}</option>`).join("");
  const errorHtml = [...page.unsupported, ...page.errors].map((error) => `<p class="error if-banner if-banner--danger" role="alert">${escapeHtml(error)}</p>`).join("\n");
  const body = `
    <h1>Guided Review</h1>
    <p class="lede">Choose an open pull request, pin its exact base and head SHAs, and review deliberately. Guided drafts stay separate from Maomao's autonomous review queue.</p>
    <form class="trigger" method="post" action="/guided/open">
      ${csrfInput(input.options.csrfToken)}
      <label>Open by GitHub URL
        <input type="url" name="url" placeholder="https://github.com/owner/repo/pull/123" value="${escapeHtml(input.directUrl ?? "")}" required/>
      </label>
      <button class="if-button if-button--primary" type="submit">Open guided review</button>
    </form>
    ${input.directError ? `<p class="error if-banner if-banner--danger" role="alert">${escapeHtml(input.directError)}</p>` : ""}
    <form class="trigger job-filters" method="get" action="/guided">
      <label>Repository
        <select name="repo"><option value="">All repositories</option>${repoOptions}</select>
      </label>
      <label>Author
        <input type="search" name="author" value="${escapeHtml(filters.author ?? "")}" placeholder="author"/>
      </label>
      <label>Review state
        <select name="reviewState">
          ${[["all", "Any"], ["requested", "Requested"], ["unrequested", "Not requested"], ["unknown", "Unknown"]].map(([value, label]) => `<option value="${value}"${(filters.reviewState ?? "all") === value ? " selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <label>Maomao state
        <select name="maomaoState">
          ${["all", "none", "queued", "running", "waiting", "completed", "failed", "cancelled", "stale"].map((value) => `<option value="${value}"${(filters.maomaoState ?? "all") === value ? " selected" : ""}>${value === "all" ? "Any" : value}</option>`).join("")}
        </select>
      </label>
      <button class="if-button if-button--sm" type="submit">Filter</button>
      ${Object.values(filters).some(Boolean) ? `<a class="top-link" href="/guided">Clear filters</a>` : ""}
    </form>
    ${errorHtml}
    ${rows ? `<ol class="queue guided-inbox">${rows}</ol>` : `<div class="empty" role="status"><p><strong>No open pull requests match.</strong></p><p class="muted">Adjust the filters, or open a pull request directly by URL.</p></div>`}
    <nav class="pagination" aria-label="Guided inbox pages">
      ${page.offset > 0 ? `<a rel="prev" href="/guided${qs({ ...filterQuery, offset: newerOffset })}">Newer</a>` : ""}
      <span class="muted">${page.total === 0 ? "0" : `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)}`} of ${page.total}</span>
      ${olderOffset < page.total ? `<a rel="next" href="/guided${qs({ ...filterQuery, offset: olderOffset })}">Older</a>` : ""}
    </nav>`;
  return layout("Guided Review", body, { ...input.options, nav: "guided" });
}

export function renderGuidedOpenError(input: { options: PageOptions; error: string; url?: string }): string {
  return renderGuidedInboxPage({
    options: input.options,
    page: { items: [], total: 0, offset: 0, limit: 25, repos: [], errors: [], unsupported: [] },
    filters: {},
    directUrl: input.url,
    directError: input.error,
  });
}

export function renderGuidedSessionPage(input: {
  options: PageOptions;
  repoFullName: string;
  prNumber: number;
  title: string;
  author: string;
  url: string;
  baseSha: string;
  headSha: string;
  sessionId?: number;
  sessionVersion?: number;
  commentCount?: number;
  readOnly?: boolean;
  canStart?: boolean;
  staleFrom?: { id: number; baseSha: string; headSha: string };
}): string {
  const readonly = input.readOnly
    ? `<p class="notice if-banner if-banner--warning" role="status">Password-only sessions are read-only here because Guided Review drafts must belong to a stable GitHub OAuth identity.</p>`
    : "";
  const stale = input.staleFrom
    ? `<p class="notice if-banner if-banner--warning" role="status">The pull moved since your prior draft (#${input.staleFrom.id}). This opened a fresh SHA-pinned workspace; the old draft remains historical until you copy it forward.</p>`
    : "";
  const body = `
    <p><a class="top-link" href="/guided">← Guided Review inbox</a></p>
    <h1>${escapeHtml(input.title)}</h1>
    <p class="lede"><strong>${escapeHtml(input.repoFullName)}#${input.prNumber}</strong> by ${escapeHtml(input.author || "unknown author")} · <a href="${escapeHtml(input.url)}" target="_blank" rel="noopener noreferrer">open on GitHub</a></p>
    ${readonly}${stale}
    <section class="config-section">
      <h2>SHA-pinned workspace</h2>
      <dl class="facts">
        <div><dt>Base</dt><dd><code>${escapeHtml(input.baseSha)}</code></dd></div>
        <div><dt>Head</dt><dd><code>${escapeHtml(input.headSha)}</code></dd></div>
        ${input.sessionId ? `<div><dt>Draft session</dt><dd>#${input.sessionId} · version ${input.sessionVersion ?? 1} · ${input.commentCount ?? 0} comments</dd></div>` : ""}
      </dl>
      ${input.canStart ? `<form method="post" action="/guided/github/${encodeURIComponent(input.repoFullName.split("/")[0])}/${encodeURIComponent(input.repoFullName.split("/")[1])}/${input.prNumber}/open">${csrfInput(input.options.csrfToken)}<button class="if-button if-button--primary" type="submit">Start guided draft</button></form>` : ""}
      <p class="muted">The diff workspace and walkthrough land in the next Guided Review slices. Starting creates your actor-private SHA-pinned draft; returning to the same SHAs resumes it.</p>
    </section>`;
  return layout(`Guided Review #${input.prNumber}`, body, { ...input.options, nav: "guided" });
}
