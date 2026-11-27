import { escapeHtml } from "../util.js";
import { diskAssetUrl, GUIDED_BUNDLE_HREF } from "./paths.js";
import type { GuidedInboxItem, GuidedInboxPage } from "../guided/inbox.js";
import type { GuidedDiffFile } from "../guided/diff.js";
import type { GuidedCommentView, GuidedSessionView } from "../guided/store.js";
import type { GuidedWalkthroughPayload, GuidedWalkthroughView } from "../guided/walkthrough-store.js";
import type { GuidedComparisonPair, GuidedComparisonSide, GuidedComparisonView } from "../guided/comparison.js";
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

function jsJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function fileIconLabel(path: string): string {
  const ext = path.includes(".") ? path.split(".").pop()!.slice(0, 4).toLowerCase() : path.split("/").pop()!.slice(0, 4).toLowerCase();
  return ext || "file";
}

function inlineCommentsFor(comments: GuidedCommentView[] | undefined, file: GuidedDiffFile, line: GuidedDiffFile["hunks"][number]["lines"][number]): GuidedCommentView[] {
  const lineNumber = line.kind === "del" ? line.oldLine : line.newLine;
  const side = line.kind === "del" ? "LEFT" : "RIGHT";
  if (!lineNumber) return [];
  return (comments ?? []).filter((comment) => !comment.deletedAt && comment.kind === "inline" && comment.path === file.path && comment.side === side && comment.line === lineNumber);
}

function guidedInlineCommentHtml(comment: GuidedCommentView): string {
  return `<tr class="gd-inline-note-row"><td colspan="4"><article class="gd-comment gd-comment--inline" data-client-id="${escapeHtml(comment.clientId)}" data-kind="inline" data-path="${escapeHtml(comment.path ?? "")}" data-side="${escapeHtml(comment.side ?? "")}" data-line="${comment.line ?? ""}" data-severity="${escapeHtml(comment.severity ?? "")}" data-category="${escapeHtml(comment.category ?? "")}" data-publishable="${comment.publishable ? "1" : ""}" data-anchor-status="${escapeHtml(comment.anchorStatus)}">
    <div class="gd-comment-head"><strong>You</strong><span class="muted">${comment.publishable ? "candidate GitHub comment" : "private note"}${comment.severity ? ` · ${escapeHtml(comment.severity)}` : ""}</span><button type="button" class="if-button if-button--sm" data-edit-comment="${escapeHtml(comment.clientId)}">Edit</button><button type="button" class="if-button if-button--sm" data-delete-comment="${escapeHtml(comment.clientId)}">Delete</button></div>
    <p class="gd-comment-body">${escapeHtml(comment.body)}</p>
  </article></td></tr>`;
}

interface GuidedInlineAnnotation {
  side: "additions" | "deletions";
  lineNumber: number;
  metadata: {
    source: "human" | "maomao";
    summary: string;
    body?: string;
    severity?: string;
    clientId?: string;
    publishable?: boolean;
    category?: string;
    path?: string;
    side?: "LEFT" | "RIGHT";
    line?: number;
    match?: string;
  };
}

function guidedAnnotationsFor(file: GuidedDiffFile, comments: GuidedCommentView[] | undefined, comparison: GuidedComparisonView | undefined): GuidedInlineAnnotation[] {
  const annotations: GuidedInlineAnnotation[] = [];
  for (const comment of comments ?? []) {
    if (comment.deletedAt || comment.kind !== "inline" || comment.path !== file.path || !comment.line || !comment.side) continue;
    annotations.push({
      side: comment.side === "LEFT" ? "deletions" : "additions",
      lineNumber: comment.line,
      metadata: { source: "human", summary: comment.body, body: comment.body, severity: comment.severity ?? undefined, clientId: comment.clientId, publishable: comment.publishable, category: comment.category ?? undefined, path: comment.path, side: comment.side, line: comment.line },
    });
  }
  if (!comparison || comparison.state !== "ready" && comparison.state !== "stale") return annotations;
  const addMaomao = (side: GuidedComparisonSide, match: string) => {
    if (side.path !== file.path || !side.line) return;
    annotations.push({
      side: "additions",
      lineNumber: side.line,
      metadata: { source: "maomao", summary: side.summary, body: side.body, severity: side.severity, match },
    });
  };
  for (const pair of [...comparison.agreements, ...comparison.uncertain]) addMaomao(pair.maomao, pair.match === "agreement" ? "same issue" : "possible match");
  for (const item of comparison.maomaoOnly) addMaomao(item, "Maomao only");
  return annotations;
}

function guidedDiffLineHtml(file: GuidedDiffFile, hunkIndex: number, line: GuidedDiffFile["hunks"][number]["lines"][number], baseSha = "", headSha = "", commentable = false): string {
  const side = line.kind === "del" ? "LEFT" : "RIGHT";
  const lineNumber = line.kind === "del" ? line.oldLine : line.newLine;
  const anchor = lineNumber ? `L${side === "LEFT" ? "o" : "n"}${lineNumber}` : "";
  const oldText = line.oldLine ?? "";
  const newText = line.newLine ?? "";
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "meta" ? "…" : "";
  return `<tr class="gd-line gd-${line.kind}"${anchor ? ` id="f${encodeURIComponent(file.path)}-h${hunkIndex}-${anchor}" data-anchor-path="${escapeHtml(file.path)}" data-anchor-side="${side}" data-anchor-line="${lineNumber}" data-anchor-sha="${escapeHtml(side === "LEFT" ? baseSha : headSha)}"` : ""}>
    <td class="gd-no gd-old">${oldText}</td><td class="gd-no gd-new">${newText}</td><td class="gd-sign" aria-hidden="true">${marker}</td><td class="gd-code"><span>${escapeHtml(line.text)}</span>${commentable && lineNumber ? `<button type="button" class="gd-comment-trigger" data-guided-comment-anchor data-path="${escapeHtml(file.path)}" data-side="${side}" data-line="${lineNumber}" data-sha="${escapeHtml(side === "LEFT" ? baseSha : headSha)}" aria-label="Add inline draft note">+</button>` : ""}</td>
  </tr>`;
}

function renderGuidedComment(comment: GuidedCommentView): string {
  const where = comment.kind === "inline" ? `${comment.path ?? "?"} ${comment.side ?? ""}:${comment.line ?? "unplaced"}` : "general note";
  return `<article class="gd-comment" data-client-id="${escapeHtml(comment.clientId)}" data-kind="${escapeHtml(comment.kind)}" data-path="${escapeHtml(comment.path ?? "")}" data-side="${escapeHtml(comment.side ?? "")}" data-line="${comment.line ?? ""}" data-severity="${escapeHtml(comment.severity ?? "")}" data-category="${escapeHtml(comment.category ?? "")}" data-publishable="${comment.publishable ? "1" : ""}" data-anchor-status="${escapeHtml(comment.anchorStatus)}">
    <div class="gd-comment-head"><span class="muted">${escapeHtml(where)} · ${comment.publishable ? "candidate GitHub comment" : "private note"}${comment.anchorStatus === "unplaced" ? " · unplaced" : ""}</span><button type="button" class="if-button if-button--sm" data-edit-comment="${escapeHtml(comment.clientId)}">Edit</button><button type="button" class="if-button if-button--sm" data-delete-comment="${escapeHtml(comment.clientId)}">Delete</button></div>
    <p class="gd-comment-body">${escapeHtml(comment.body)}</p>
    ${comment.anchorStatus === "unplaced" ? `<p class="muted">Unplaced stale-hunk note: edit/re-anchor it before it can be selected for publication.</p>` : ""}
  </article>`;
}

function severityOptions(value = ""): string {
  return `<option value="">No severity</option>${["low", "medium", "high", "critical"].map((severity) => `<option value="${severity}"${value === severity ? " selected" : ""}>${severity}</option>`).join("")}`;
}

export function renderGuidedDraftPanel(input: { session: GuidedSessionView; comments: GuidedCommentView[]; csrfToken?: string; readOnly?: boolean }): string {
  if (input.readOnly) return "";
  const active = input.comments.filter((comment) => !comment.deletedAt && comment.kind === "general");
  return `<section class="config-section gd-human-draft" data-guided-draft data-session-id="${input.session.id}" data-version="${input.session.version}" data-csrf="${escapeHtml(input.csrfToken ?? "")}">
    <div class="gd-head"><h2>Your private draft</h2><span class="gd-save-state" data-save-state data-state="saved">Saved privately</span></div>
    <p class="error if-banner if-banner--danger" data-guided-bundle-error hidden>Guided draft enhancement failed to load. Run the asset build; these controls require JavaScript.</p>
    <p class="muted">Nothing here publishes to GitHub. Notes and the verdict are actor-private until a later deliberate publish step.</p>
    <noscript><p class="notice if-banner if-banner--warning">Guided notes and publication preview require JavaScript. The diff remains readable, but draft controls are inactive.</p></noscript>
    <div class="gd-draft-grid">
      <label>Draft summary <textarea data-draft-summary rows="3" maxlength="10000" placeholder="Overall human review summary (optional)">${escapeHtml(input.session.draftSummary)}</textarea></label>
      <label>Verdict <select data-draft-verdict>
        <option value="">No verdict required</option>
        ${["COMMENT", "APPROVE", "REQUEST_CHANGES"].map((verdict) => `<option value="${verdict}"${input.session.draftVerdict === verdict ? " selected" : ""}>${verdict.replaceAll("_", " ")}</option>`).join("")}
      </select></label>
    </div>
    <div class="gd-step-actions"><button type="button" class="if-button if-button--primary" data-goto-step="compare">Continue to comparison</button><span class="muted">Inline notes save automatically while you review.</span></div>
    <details class="gd-draft-details"><summary>General notes and publication controls</summary>
    <h3>General notes</h3>
    <div data-comment-list>${active.length ? active.map(renderGuidedComment).join("\n") : `<p class="muted">No general notes yet. Inline notes appear directly in the diff.</p>`}</div>
    <div class="gd-inline-editor" data-inline-editor hidden>
      <h4>Inline note <span class="muted" data-inline-target></span></h4>
      <input type="hidden" data-comment-client-id/>
      <label>Note <textarea data-comment-body rows="4" maxlength="4000" required></textarea></label>
      <div class="gd-inline-fields">
        <label>Severity <select data-comment-severity>${severityOptions()}</select></label>
        <label>Category <input data-comment-category maxlength="80" placeholder="optional"/></label>
        <label class="gd-check"><input type="checkbox" data-comment-publishable/> Candidate GitHub comment</label>
      </div>
      <button type="button" class="if-button if-button--primary" data-save-inline>Save inline note</button>
      <button type="button" class="if-button" data-cancel-inline>Cancel</button>
      <p class="muted">Unchecked stays private. Unplaced stale-hunk notes cannot be candidates until re-anchored.</p>
    </div>
    <form data-general-form class="gd-general-form">
      <h4>General note</h4>
      <input type="hidden" data-comment-client-id/>
      <label>Note <textarea data-comment-body rows="4" maxlength="4000" required></textarea></label>
      <div class="gd-inline-fields">
        <label>Severity <select data-comment-severity>${severityOptions()}</select></label>
        <label>Category <input data-comment-category maxlength="80" placeholder="optional"/></label>
        <label class="gd-check"><input type="checkbox" data-comment-publishable/> Candidate for review summary</label>
      </div>
      <button type="submit" class="if-button if-button--primary">Save general note</button>
    </form>
    <div class="gd-preview-controls">
      <button type="button" class="if-button" data-refresh-draft>Refresh draft</button>
      <button type="button" class="if-button if-button--primary" data-preview-publish>Preview publication payload</button>
    </div>
    <div data-preview-output class="gd-preview-output" aria-live="polite"></div>
    </details>
  </section>`;
}


function guidedWalkthroughStatusText(status: string): string {
  if (status === "pending") return "Queued";
  if (status === "running") return "Generating";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Stale";
}

function guidedPathHref(path: string | undefined, anchors: Map<string, number>): string | undefined {
  if (!path) return undefined;
  const index = anchors.get(path);
  return index === undefined ? undefined : `#guided-file-${index}`;
}

function shortPrimerText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  const clipped = normalized.slice(0, Math.max(1, maxChars - 1));
  const boundary = Math.max(clipped.lastIndexOf(" "), Math.floor(maxChars * 0.65));
  return `${clipped.slice(0, boundary).trimEnd()}…`;
}

function primerChangeFor(payload: GuidedWalkthroughPayload | undefined, path: string): GuidedWalkthroughPayload["changeMap"][number] | undefined {
  return payload?.changeMap.find((change) => change.path === path);
}

function renderFilePrimerContent(change: GuidedWalkthroughPayload["changeMap"][number] | undefined): string {
  if (!change) return `<strong>Maomao exploration</strong><p class="muted">No concise file-specific evidence was produced by the independent exploration.</p>`;
  return `<strong>Maomao exploration</strong><p>${escapeHtml(shortPrimerText(change.summary, 220))}</p><p class="muted">${escapeHtml(shortPrimerText(change.evidence, 160))}</p>`;
}

function renderGuidedExplorationPrimer(input: { walkthrough?: GuidedWalkthroughView; sessionId?: number }): string {
  if (!input.sessionId) return "";
  const status = input.walkthrough?.status ?? "pending";
  const payload = input.walkthrough?.payload;
  const ready = payload && (status === "ready" || status === "stale");
  const primerBadge = status === "stale" ? "stale pinned head" : "independent · no findings or verdicts";
  const body = ready
    ? `<div class="gd-primer-head"><h2>Maomao exploration primer</h2><span class="job-chip">${primerBadge}</span></div>
      <p>${escapeHtml(shortPrimerText(payload.intent.text, 420))}</p>
      <p class="muted"><strong>Flow:</strong> ${escapeHtml(shortPrimerText(payload.flow, 520))}</p>
      <p class="muted">Uncertainty: ${escapeHtml(shortPrimerText(payload.intent.uncertainty, 220))}</p>`
    : status === "pending" || status === "running"
      ? `<div class="gd-primer-head"><h2>Maomao exploration primer</h2><span class="job-chip">${escapeHtml(guidedWalkthroughStatusText(status))}</span></div><p class="muted"><span class="gd-spinner" aria-hidden="true"></span> Independent exploration is running. It explains the pinned change without using Maomao review findings or verdicts.</p>`
      : status === "failed"
        ? `<div class="gd-primer-head"><h2>Maomao exploration primer</h2><span class="job-chip">failed</span></div><p class="muted">Exploration failed${input.walkthrough?.error ? `: ${escapeHtml(input.walkthrough.error)}` : "."} Review can continue manually.</p>`
        : status === "cancelled"
          ? `<div class="gd-primer-head"><h2>Maomao exploration primer</h2><span class="job-chip">cancelled</span></div><p class="muted">Independent exploration was cancelled.</p>`
          : `<div class="gd-primer-head"><h2>Maomao exploration primer</h2><span class="job-chip">stale</span></div><p class="muted">This exploration belongs to an older pinned head.</p>`;
  return `<section class="gd-primer" data-guided-primer data-status="${escapeHtml(status)}">${body}</section>`;
}

function renderGuidedWalkthroughPayload(payload: GuidedWalkthroughPayload, files: GuidedDiffFile[]): string {
  const anchors = new Map(files.map((file, index) => [file.path, index]));
  const exactLineHref = (path: string | undefined, line?: number) => {
    if (!path || !line) return undefined;
    const file = files.find((entry) => entry.path === path);
    if (!file) return undefined;
    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      const matched = hunk.lines.find((entry) => entry.newLine === line || entry.oldLine === line);
      if (!matched) continue;
      const side = matched.kind === "del" ? "LEFT" : "RIGHT";
      const lineNumber = matched.kind === "del" ? matched.oldLine : matched.newLine;
      if (lineNumber) return `#f${encodeURIComponent(file.path)}-h${hunkIndex}-L${side === "LEFT" ? "o" : "n"}${lineNumber}`;
    }
    return undefined;
  };
  const evidenceLink = (path: string | undefined, label: string, line?: number) => {
    const href = exactLineHref(path, line) ?? guidedPathHref(path, anchors);
    return href ? `<a href="${href}">${escapeHtml(label)}</a>` : `<span>${escapeHtml(label)}</span>`;
  };
  const changes = payload.changeMap.map((change) => `<li>${evidenceLink(change.path, change.path)} — ${escapeHtml(change.summary)} <span class="muted">${escapeHtml(change.evidence)}</span></li>`).join("\n");
  const decisions = payload.decisions.map((decision) => `<li><strong>${escapeHtml(decision.title)}</strong> — ${escapeHtml(decision.details)} <span class="muted">${escapeHtml(decision.evidence)}</span></li>`).join("\n");
  const risks = payload.risks.map((risk) => `<li>${escapeHtml(risk.question)} ${risk.path ? evidenceLink(risk.path, risk.line ? `${risk.path}:${risk.line}` : risk.path, risk.line) : ""} <span class="muted">${escapeHtml(risk.evidence)}</span></li>`).join("\n");
  return `<details class="gd-walkthrough-full"><summary>Full exploration evidence</summary><div class="gd-walkthrough-content">
    <h3>Intent as expressed</h3><p>${escapeHtml(payload.intent.text)}</p><p class="muted">Uncertainty: ${escapeHtml(payload.intent.uncertainty)}</p>
    <h3>Change map</h3><ul>${changes || "<li>No file evidence was available.</li>"}</ul>
    <h3>Execution and data flow</h3><p>${escapeHtml(payload.flow)}</p>
    <h3>Decisions and invariants</h3><ul>${decisions || "<li>No consequential decisions were evidenced.</li>"}</ul>
    <h3>Tests</h3><p>${escapeHtml(payload.tests)}</p>
    <h3>Reviewer questions</h3><ul>${risks || "<li>No explicit risk questions were evidenced.</li>"}</ul>
  </div></details>`;
}

function renderGuidedWalkthroughPanel(input: { walkthrough?: GuidedWalkthroughView; files: GuidedDiffFile[]; sessionId?: number; csrfToken?: string }): string {
  if (!input.sessionId) return "";
  const walkthrough = input.walkthrough;
  const status = walkthrough?.status ?? "pending";
  const active = status === "pending" || status === "running";
  const payload = walkthrough?.payload;
  const detail = active
    ? `<p class="notice if-banner" role="status"><span class="gd-spinner" aria-hidden="true"></span> ${guidedWalkthroughStatusText(status)} walkthrough in the background. You can inspect the diff immediately; this panel updates without blocking the page.</p>`
    : status === "failed"
      ? `<p class="error if-banner if-banner--danger" role="alert">Walkthrough generation failed${walkthrough?.error ? `: ${escapeHtml(walkthrough.error)}` : "."} Manual review remains available.</p>`
      : status === "cancelled"
        ? `<p class="notice if-banner if-banner--warning">Walkthrough generation was cancelled.</p>`
        : status === "stale"
          ? `<p class="notice if-banner if-banner--warning">This walkthrough belongs to an older head SHA and is stale.</p>`
          : "";
  const controls = `<div class="gd-walkthrough-controls">
    <button type="button" class="if-button if-button--sm" data-walkthrough-cancel${active ? "" : " hidden"}>Cancel generation</button>
    <button type="button" class="if-button if-button--sm" data-walkthrough-retry${status === "failed" || status === "cancelled" ? "" : " hidden"}>Retry walkthrough</button>
    <button type="button" class="if-button if-button--sm" data-walkthrough-refresh>Refresh</button>
  </div>`;
  return `<section class="config-section gd-walkthrough" data-guided-walkthrough data-session-id="${input.sessionId}" data-csrf="${escapeHtml(input.csrfToken ?? "")}" data-status="${escapeHtml(status)}">
    <div class="gd-head"><h2>Independent exploration evidence</h2><span class="job-chip" data-walkthrough-state>${escapeHtml(guidedWalkthroughStatusText(status))}</span></div>
    <div data-walkthrough-detail>${detail}</div>
    <div data-walkthrough-body>${payload && (status === "ready" || status === "stale") ? renderGuidedWalkthroughPayload(payload, input.files) : ""}</div>
    ${controls}
    <noscript><p class="notice if-banner if-banner--warning">Walkthrough progress updates require JavaScript. Reload this page to check generation state.</p></noscript>
  </section>`;
}

function comparisonHref(path: string | undefined, line: number | undefined, anchors: Map<string, number>, files: GuidedDiffFile[]): string | undefined {
  if (!path) return undefined;
  const index = anchors.get(path);
  if (index === undefined) return undefined;
  const file = files[index];
  if (line !== undefined && file) {
    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      const row = hunk.lines.find((candidate) => candidate.newLine === line || candidate.oldLine === line);
      if (row) {
        const lineNumber = row.kind === "del" ? row.oldLine : row.newLine;
        if (lineNumber) return `#f${encodeURIComponent(path)}-h${hunkIndex}-L${row.kind === "del" ? "o" : "n"}${lineNumber}`;
      }
    }
  }
  return `#guided-file-${index}`;
}

function comparisonLink(path: string | undefined, line: number | undefined, label: string, anchors: Map<string, number>, files: GuidedDiffFile[]): string {
  const href = comparisonHref(path, line, anchors, files);
  return href ? `<a href="${href}">${escapeHtml(label)}</a>` : `<span>${escapeHtml(label)}</span>`;
}

function comparisonSide(side: GuidedComparisonSide, anchors: Map<string, number>, files: GuidedDiffFile[]): string {
  const where = side.path ? comparisonLink(side.path, side.line, side.line ? `${side.path}:${side.line}` : side.path, anchors, files) : `<span class="muted">no location</span>`;
  return `<div class="gd-compare-side"><strong>${side.source === "human" ? "Human" : "Maomao"}</strong> ${where}${side.severity ? ` <span class="job-chip">${escapeHtml(side.severity)}</span>` : ""}${side.status ? ` <span class="job-chip">${escapeHtml(side.status)}</span>` : ""}<p>${escapeHtml(side.summary)}</p>${side.body && side.body !== side.summary ? `<p class="muted">${escapeHtml(side.body)}</p>` : ""}${side.rationale ? `<p class="muted">${escapeHtml(side.rationale)}</p>` : ""}</div>`;
}

function comparisonPair(pair: GuidedComparisonPair, anchors: Map<string, number>, files: GuidedDiffFile[], sessionId: number | undefined, version: number | undefined, csrfToken: string | undefined): string {
  const decisionForm = (decision: "confirm" | "reject", label: string) => `<form method="post" action="/guided/sessions/${sessionId}/comparison/pair" class="gd-compare-actions">
    ${csrfInput(csrfToken)}<input type="hidden" name="version" value="${version}"/><input type="hidden" name="humanClientId" value="${escapeHtml(pair.human.key)}"/><input type="hidden" name="fingerprint" value="${escapeHtml(pair.maomao.fingerprint)}"/><input type="hidden" name="decision" value="${decision}"/>
    <button class="if-button if-button--sm" type="submit">${label}</button>
  </form>`;
  const controls = sessionId && version ? `<div class="gd-compare-actions">
    ${pair.match === "uncertain" ? decisionForm("confirm", "Confirm same issue") : ""}
    ${decisionForm("reject", "Mark unrelated")}
  </div>` : "";
  return `<li class="gd-compare-pair">${comparisonSide(pair.human, anchors, files)}${comparisonSide(pair.maomao, anchors, files)}<p class="muted">${escapeHtml(pair.signals.join(", ") || "manual pairing")} · confidence ${pair.confidence.toFixed(2)}${pair.confirmed ? " · confirmed by human" : ""}</p>${pair.severityDifference ? `<p class="notice if-banner if-banner--warning">Severity differs: ${escapeHtml(pair.severityDifference)}</p>` : ""}${controls}</li>`;
}

function compactComparisonSide(side: GuidedComparisonSide, anchors: Map<string, number>, files: GuidedDiffFile[], options: { matched?: string; controls?: string } = {}): string {
  const where = side.path ? comparisonLink(side.path, side.line, side.line ? `${side.path}:${side.line}` : side.path, anchors, files) : `<span class="muted">unanchored</span>`;
  const detail = side.body && side.body !== side.summary ? `<details class="gd-evidence"><summary>Detail</summary><p>${escapeHtml(side.body)}</p></details>` : "";
  const rationale = side.rationale ? `<details class="gd-evidence"><summary>Evidence</summary><p>${escapeHtml(side.rationale)}</p></details>` : "";
  return `<article class="gd-review-card gd-review-card--${side.source}">
    <div class="gd-review-card-head"><span class="gd-author">${side.source === "human" ? "You" : "Maomao"}</span>${where}${side.severity ? ` <span class="job-chip">${escapeHtml(side.severity)}</span>` : ""}${side.status ? ` <span class="job-chip">${escapeHtml(side.status)}</span>` : ""}${options.matched ? ` <span class="job-chip gd-match-chip">${escapeHtml(options.matched)}</span>` : ""}</div>
    <p class="gd-review-summary">${escapeHtml(side.summary)}</p>
    ${detail}${rationale}${options.controls ?? ""}
  </article>`;
}

export function renderGuidedComparisonPanel(input: { comparison?: GuidedComparisonView; files: GuidedDiffFile[]; sessionId?: number; sessionVersion?: number; csrfToken?: string; pullUrl?: string }): string {
  if (!input.comparison || !input.sessionId) return "";
  const comparison = input.comparison;
  const sourceFile = (path: string) => /\.(c|cc|cpp|cs|css|go|h|hpp|java|js|jsx|kt|mjs|mts|php|py|rb|rs|scala|sh|sql|swift|ts|tsx|vue)$/i.test(path);
  const sourceFiles = input.files.filter((file) => sourceFile(file.path));
  const anchors = new Map(sourceFiles.map((file) => [file.path, input.files.indexOf(file)]));
  const pairByHuman = new Map<string, GuidedComparisonPair>();
  const pairByMaomao = new Map<string, GuidedComparisonPair>();
  for (const item of [...comparison.agreements, ...comparison.uncertain]) {
    pairByHuman.set(item.human.key, item);
    pairByMaomao.set(item.maomao.fingerprint, item);
  }
  const decisionForm = (pair: GuidedComparisonPair, decision: "confirm" | "reject", label: string) => `<form method="post" action="/guided/sessions/${input.sessionId}/comparison/pair" class="gd-inline-action">
    ${csrfInput(input.csrfToken)}<input type="hidden" name="version" value="${input.sessionVersion}"/><input type="hidden" name="humanClientId" value="${escapeHtml(pair.human.key)}"/><input type="hidden" name="fingerprint" value="${escapeHtml(pair.maomao.fingerprint)}"/><input type="hidden" name="decision" value="${decision}"/>
    <button class="if-button if-button--sm" type="submit">${label}</button>
  </form>`;
  const maomaoAction = (item: GuidedComparisonSide, decision: "adopt" | "exclude", label: string) => `<form method="post" action="/guided/sessions/${input.sessionId}/comparison/pair" class="gd-inline-action">
    ${csrfInput(input.csrfToken)}<input type="hidden" name="version" value="${input.sessionVersion}"/><input type="hidden" name="fingerprint" value="${escapeHtml(item.fingerprint)}"/><input type="hidden" name="decision" value="${decision}"/>
    <button class="if-button if-button--sm" type="submit">${label}</button>
  </form>`;
  const restoreExclusion = (item: GuidedComparisonSide) => `<form method="post" action="/guided/sessions/${input.sessionId}/comparison/pair" class="gd-inline-action">
    ${csrfInput(input.csrfToken)}<input type="hidden" name="version" value="${input.sessionVersion}"/><input type="hidden" name="humanClientId" value="maomao-exclude-${escapeHtml(item.fingerprint)}"/><input type="hidden" name="decision" value="clear"/>
    <button class="if-button if-button--sm" type="submit">Restore to merge review</button>
  </form>`;

  type FileGroup = { pairs: GuidedComparisonPair[]; humans: GuidedComparisonSide[]; maomaos: GuidedComparisonSide[] };
  const groups = new Map<string, FileGroup>();
  const outside = { pairs: [] as GuidedComparisonPair[], humans: [] as GuidedComparisonSide[], maomaos: [] as GuidedComparisonSide[] };
  const groupFor = (path: string): FileGroup => {
    const existing = groups.get(path);
    if (existing) return existing;
    const created = { pairs: [], humans: [], maomaos: [] } as FileGroup;
    groups.set(path, created);
    return created;
  };
  const inDiff = (side: GuidedComparisonSide) => Boolean(side.path && anchors.has(side.path));
  for (const item of [...comparison.agreements, ...comparison.uncertain]) {
    const path = inDiff(item.human) ? item.human.path! : inDiff(item.maomao) ? item.maomao.path! : undefined;
    if (path) groupFor(path).pairs.push(item);
    else outside.pairs.push(item);
  }
  for (const item of comparison.humanOnly) (inDiff(item) ? groupFor(item.path!).humans : outside.humans).push(item);
  for (const item of comparison.maomaoOnly) (inDiff(item) ? groupFor(item.path!).maomaos : outside.maomaos).push(item);

  const pairControls = (pair: GuidedComparisonPair) => `${pair.severityDifference ? `<p class="notice if-banner if-banner--warning">Severity differs: ${escapeHtml(pair.severityDifference)}</p>` : ""}<div class="gd-card-actions">
    ${pair.match === "uncertain" ? decisionForm(pair, "confirm", "Confirm same issue") : ""}
    ${decisionForm(pair, "reject", "Mark unrelated")}
  </div>`;
  const humanCards = (group: FileGroup) => [
    ...group.pairs.map((item) => compactComparisonSide(item.human, anchors, input.files, { matched: item.match === "agreement" ? "matched" : "possible match" })),
    ...group.humans.map((item) => compactComparisonSide(item, anchors, input.files, { matched: "your only note" })),
  ].join("") || `<p class="muted">No human notes on this file yet.</p>`;
  const maomaoCards = (group: FileGroup) => [
    ...group.pairs.map((item) => compactComparisonSide(item.maomao, anchors, input.files, {
      matched: `${item.match} · ${item.confidence.toFixed(2)}`,
      controls: input.sessionVersion ? pairControls(item) : "",
    })),
    ...group.maomaos.map((item) => compactComparisonSide(item, anchors, input.files, {
      matched: "Maomao only",
      controls: input.sessionVersion ? `<div class="gd-card-actions">${maomaoAction(item, "adopt", "Add to my review")}${maomaoAction(item, "exclude", "Remove from merge")}</div>` : "",
    })),
  ].join("") || `<p class="muted">No Maomao findings on this file.</p>`;
  const fileSections = [...groups.entries()].map(([path, group], index) => {
    const count = group.pairs.length * 2 + group.humans.length + group.maomaos.length;
    return `<details class="gd-compare-file"${index === 0 ? " open" : ""}><summary><span>${escapeHtml(path)}</span><span class="muted">${count} review item${count === 1 ? "" : "s"}</span></summary>
      <div class="gd-compare-lanes">
        <section class="gd-lane"><h3>Your review</h3>${humanCards(group)}</section>
        <section class="gd-lane"><h3>Maomao review</h3>${maomaoCards(group)}</section>
      </div>
    </details>`;
  }).join("\n");

  const verboseList = (items: GuidedComparisonSide[], emptyText: string) => items.length
    ? `<ul>${items.map((item) => `<li>${compactComparisonSide(item, anchors, input.files)}</li>`).join("\n")}</ul>`
    : `<p class="muted">${emptyText}</p>`;
  const outsideCount = outside.pairs.length + outside.humans.length + outside.maomaos.length;
  const outsideSection = outsideCount ? `<details class="gd-compare-outside"><summary>Unanchored or outside the pinned source diff (${outsideCount})</summary>
    ${outside.pairs.length ? `<h3>Paired items</h3>${outside.pairs.map((item) => `<div class="gd-compare-lanes"><section class="gd-lane">${compactComparisonSide(item.human, anchors, input.files)}</section><section class="gd-lane">${compactComparisonSide(item.maomao, anchors, input.files, { controls: input.sessionVersion ? pairControls(item) : "" })}</section></div>`).join("")}` : ""}
    ${outside.humans.length ? `<h3>Human-only</h3>${verboseList(outside.humans, "")}` : ""}
    ${outside.maomaos.length ? `<h3>Maomao-only</h3>${outside.maomaos.map((item) => compactComparisonSide(item, anchors, input.files, { controls: input.sessionVersion ? `<div class="gd-card-actions">${maomaoAction(item, "adopt", "Add to my review")}${maomaoAction(item, "exclude", "Remove from merge")}</div>` : "" })).join("\n")}` : ""}
  </details>` : "";
  const enqueue = comparison.state === "missing" && input.pullUrl ? `<form method="post" action="/reviews" class="gd-compare-actions">${csrfInput(input.csrfToken)}<input type="hidden" name="url" value="${escapeHtml(input.pullUrl)}"/><button class="if-button if-button--sm" type="submit">Deliberately enqueue Maomao review for the current pull head</button></form>` : "";
  const manual = (comparison.state === "ready" || comparison.state === "stale") && comparison.humanOnly.length && comparison.maomaoOnly.length && input.sessionVersion
    ? `<details class="gd-manual-pair"><summary>Advanced: pair a human note with a Maomao finding manually</summary><form method="post" action="/guided/sessions/${input.sessionId}/comparison/pair" class="gd-compare-actions">
      ${csrfInput(input.csrfToken)}<input type="hidden" name="version" value="${input.sessionVersion}"/><input type="hidden" name="decision" value="confirm"/>
      <label>Human note <select name="humanClientId">${comparison.humanOnly.map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.summary.slice(0, 80))}</option>`).join("")}</select></label>
      <label>Maomao finding <select name="fingerprint">${comparison.maomaoOnly.map((item) => `<option value="${escapeHtml(item.fingerprint)}">${escapeHtml(item.summary.slice(0, 80))}</option>`).join("")}</select></label>
      <button class="if-button if-button--sm" type="submit">Pair selected findings</button>
    </form></details>`
    : "";
  const excluded = comparison.excludedMaomao.length && input.sessionVersion
    ? `<details class="gd-excluded"><summary>Removed Maomao findings (${comparison.excludedMaomao.length})</summary>${comparison.excludedMaomao.map((item) => compactComparisonSide(item, anchors, input.files, { controls: restoreExclusion(item) })).join("")}</details>`
    : "";
  return `<section id="compare" class="config-section gd-comparison" data-guided-comparison data-session-id="${input.sessionId}" data-state="${escapeHtml(comparison.state)}">
    <div class="gd-head"><div><h2>Merge review</h2><p class="muted">Compare file-by-file, adopt useful Maomao findings into your draft, and remove noise before publishing. Maomao's already-published review is never mutated.</p></div><span class="job-chip">${escapeHtml(comparison.state)}</span></div>
    <p class="muted">${escapeHtml(comparison.message)} Exact head <code>${escapeHtml(comparison.headSha)}</code>${comparison.jobId ? ` · <a href="/jobs/${comparison.jobId}">Maomao job #${comparison.jobId}</a>` : ""}</p>
    ${enqueue}
    ${manual}
    ${comparison.verdictDifference ? `<p class="notice if-banner if-banner--warning">Verdict differs: ${escapeHtml(comparison.verdictDifference)}</p>` : ""}
    <div class="gd-merge-stats" aria-label="Comparison coverage"><span>${comparison.summary.agreement} matched</span><span>${comparison.summary.humanOnly} yours only</span><span>${comparison.summary.maomaoOnly} Maomao only</span><span>${comparison.summary.uncertain} uncertain</span><span>${comparison.excludedMaomao.length} removed</span></div>
    ${fileSections || `<p class="muted">No file-anchored review findings in the pinned source diff yet.</p>`}
    ${outsideSection}
    ${excluded}
    <details class="gd-inactive"><summary>Suppressed or resolved Maomao findings (${comparison.summary.inactive})</summary>${verboseList(comparison.inactiveMaomao, "No suppressed or resolved findings.")}</details>
    <div class="gd-step-actions"><button type="button" class="if-button if-button--primary" data-goto-step="publish">Continue to publish preview</button></div>
  </section>`;
}

export interface GuidedPublishPanelView {
  state: "unsupported" | "password" | "missing" | "expired" | "revoked" | "ready" | "published" | "pending" | "stale_pending" | "failed" | "uncertain";
  message: string;
  scope?: string;
  login?: string;
  publicationUrl?: string;
  canConnect: boolean;
  connectHref?: string;
}

export function renderGuidedPublishPanel(input: { publish?: GuidedPublishPanelView; sessionId?: number; sessionVersion?: number; csrfToken?: string }): string {
  if (!input.publish || !input.sessionId) return "";
  const publish = input.publish;
  const canWrite = input.sessionVersion && input.csrfToken;
  const connect = publish.canConnect && publish.connectHref ? `<p><a class="if-button if-button--sm" href="${escapeHtml(publish.connectHref)}">Connect human GitHub publication</a></p>` : "";
  const disconnect = publish.state === "ready" && canWrite ? `<form method="post" action="/guided/publish/github/disconnect" class="gd-compare-actions">${csrfInput(input.csrfToken)}<button class="if-button if-button--sm" type="submit">Disconnect publication token</button></form>` : "";
  const retryable = publish.state === "ready" || publish.state === "stale_pending" || publish.state === "failed" || publish.state === "uncertain";
  const action = publish.state === "ready" ? "Publish human review" : "Retry human review publication";
  const confirm = retryable && canWrite ? `<form method="post" action="/guided/sessions/${input.sessionId}/publish" class="gd-human-publish">
    ${csrfInput(input.csrfToken)}<input type="hidden" name="version" value="${input.sessionVersion}"/>
    <label class="gd-check"><input type="checkbox" name="confirm" value="yes" required/> I confirm the exact previewed event, body and selected inline comments may be published as ${escapeHtml(publish.login ?? "my GitHub account")}.</label>
    <button class="if-button if-button--primary" type="submit">${action} as ${escapeHtml(publish.login ?? "GitHub user")}</button>
  </form>` : "";
  const published = publish.publicationUrl ? `<p><a href="${escapeHtml(publish.publicationUrl)}">Open published human review</a></p>` : "";
  return `<section id="publish" class="config-section gd-human-publish-panel">
    <div class="gd-head"><h2>Publish as human</h2><span class="job-chip">${escapeHtml(publish.state)}</span></div>
    <p class="muted">${escapeHtml(publish.message)}${publish.scope ? ` Granted scope: ${escapeHtml(publish.scope)}.` : ""} Bot publication semantics are unchanged.</p>
    <div class="gd-publish-preview-box" data-guided-publish-preview data-session-id="${input.sessionId}"><div class="gd-head"><h3>Publication preview</h3><button type="button" class="if-button if-button--sm" data-load-publish-preview>Refresh exact preview</button></div><div data-publish-preview-output><p class="muted">Loading the exact review body and selected inline comments…</p></div></div>
    ${published}${connect}${confirm}${disconnect}
    <section class="gd-maomao-discussions" data-guided-discussions data-session-id="${input.sessionId}" data-csrf="${escapeHtml(input.csrfToken ?? "")}"><h3>Published Maomao threads</h3><div data-discussion-list><p class="muted">Loading unresolved threads…</p></div></section>
  </section>`;
}


export interface GuidedAttentionPanelView {
  state: "pending" | "decided" | "informational";
  profile: string;
  message: string;
  optional?: boolean;
  decision?: { action: string; actor: string; reasonTag: string; createdAt: string };
}

export function renderGuidedAttentionPanel(input: { attention?: GuidedAttentionPanelView; sessionId?: number; csrfToken?: string; readOnly?: boolean }): string {
  if (!input.attention || !input.sessionId) return "";
  const attention = input.attention;
  const decision = attention.decision ? `<p class="muted">Decision: ${escapeHtml(attention.decision.action)} by ${escapeHtml(attention.decision.actor)} at ${escapeHtml(attention.decision.createdAt)} · ${escapeHtml(attention.decision.reasonTag)}</p>` : "";
  const controls = attention.state === "pending" && input.csrfToken && !input.readOnly ? `<form method="post" action="/guided/sessions/${input.sessionId}/attention" class="gd-attention-form">
    ${csrfInput(input.csrfToken)}
    <label>Reason tag <select name="reasonTag"><option value="risk-review">risk-review</option><option value="author-context">author-context</option><option value="time-sensitive">time-sensitive</option><option value="policy">policy</option><option value="other">other</option></select></label>
    <label>Optional reason detail <input name="reasonDetail" maxlength="300" placeholder="explainable decision context"/></label>
    <div class="gd-compare-actions">
      <button class="if-button if-button--primary" type="submit" name="action" value="review_myself">Review myself</button>
      <button class="if-button" type="submit" name="action" value="delegate_to_maomao">Delegate this review to Maomao</button>
      ${attention.optional ? `<button class="if-button gd-button-warning" type="submit" name="action" value="skip_guided_review">Continue without Guided Review</button>` : ""}
    </div>
  </form>` : "";
  return `<section id="attention" class="config-section gd-attention" data-guided-attention>
    <div class="gd-head"><h2>Human attention gate</h2><span class="job-chip">${escapeHtml(attention.state)}</span></div>
    <p class="muted">${escapeHtml(attention.message)} Exact-SHA decisions are auditable and a newer head invalidates them.${attention.optional ? " This profile keeps the gate green without a decision; the warning action only records an explicit opt-out." : ""}</p>
    ${decision}${controls}
  </section>`;
}

export function renderGuidedDiffWorkspace(input: {
  files: GuidedDiffFile[];
  statusFilter?: string;
  fileFilter?: string;
  diffError?: string;
  diffTruncated?: boolean;
  baseSha?: string;
  headSha?: string;
  sessionId?: number;
  sessionVersion?: number;
  viewedFiles?: string[];
  csrfToken?: string;
  comments?: GuidedCommentView[];
  sessionView?: GuidedSessionView;
  walkthrough?: GuidedWalkthroughView;
  comparison?: GuidedComparisonView;
  publish?: GuidedPublishPanelView;
  attention?: GuidedAttentionPanelView;
  pullUrl?: string;
  readOnly?: boolean;
}): string {
  if (input.diffError) {
    return `<section class="config-section guided-diff-workspace"><h2>Diff workspace</h2><p class="error if-banner if-banner--danger" role="alert">${escapeHtml(input.diffError)}</p><p class="muted">Maomao cannot imply unseen changes were reviewed. Retry after the forge recovers or raise the diff size limit.</p></section>`;
  }
  const statuses = [...new Set(input.files.map((file) => file.status))].sort();
  const filtered = input.files.filter((file) =>
    (!input.statusFilter || input.statusFilter === "all" || file.status === input.statusFilter),
  );
  const total = input.files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const viewed = new Set(input.viewedFiles ?? []);
  const walkthroughPayload = input.walkthrough && (input.walkthrough.status === "ready" || input.walkthrough.status === "stale") ? input.walkthrough.payload : undefined;
  const treeItems = filtered.map((file, index) => ({ file, index }));
  const tree = treeItems.map(({ file, index }) => `<li><a href="#guided-file-${index}" data-guided-file-link><span class="gd-file-icon" aria-hidden="true">${escapeHtml(fileIconLabel(file.path))}</span><span class="gd-tree-path">${viewed.has(file.path) ? "✓ " : ""}${escapeHtml(file.path)}</span></a><span class="muted">+${file.additions} −${file.deletions}</span></li>`).join("");
  type TreeNode = { dirs: Map<string, TreeNode>; files: typeof treeItems };
  const root: TreeNode = { dirs: new Map(), files: [] };
  for (const item of treeItems) {
    const parts = item.file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, next = { dirs: new Map(), files: [] });
      node = next;
    }
    node.files.push(item);
  }
  const renderTreeNode = (node: TreeNode): string => `${node.files.map(({ file, index }) => `<li><a href="#guided-file-${index}" data-guided-file-link><span class="gd-file-icon" aria-hidden="true">${escapeHtml(fileIconLabel(file.path))}</span><span class="gd-tree-path">${viewed.has(file.path) ? "✓ " : ""}${escapeHtml(file.path.split("/").pop() ?? file.path)}</span></a><span class="muted">+${file.additions} −${file.deletions}</span></li>`).join("")}${[...node.dirs.entries()].map(([dir, child]) => `<li class="gd-tree-dir"><details open><summary>${escapeHtml(dir)}/</summary><ol>${renderTreeNode(child)}</ol></details></li>`).join("")}`;
  const treeView = `<ol>${renderTreeNode(root)}</ol>`;
  const rendered = filtered.map((file, index) => {
    const filePrimer = primerChangeFor(walkthroughPayload, file.path);
    const hunks = file.hunks.map((hunk, hunkIndex) => `<details class="gd-hunk" open>
      <summary>${escapeHtml(hunk.header)}</summary>
      <table class="gd-table"><tbody>${hunk.lines.map((line) => `${guidedDiffLineHtml(file, hunkIndex, line, input.baseSha, input.headSha, Boolean(input.sessionView && !input.readOnly))}${inlineCommentsFor(input.comments, file, line).map(guidedInlineCommentHtml).join("")}`).join("\n")}</tbody></table>
    </details>`).join("\n");
    const empty = file.binary ? `<p class="muted">Binary file changed; inline diff is unavailable.</p>` : file.hunks.length === 0 ? `<p class="muted">No textual hunks are available for this file.</p>` : "";
    return `<article class="gd-file${viewed.has(file.path) ? " gd-viewed" : ""}" id="guided-file-${index}" data-guided-file data-path="${escapeHtml(file.path)}" data-status="${escapeHtml(file.status)}">
      <h3 class="gd-file-header"><span class="gd-file-title"><span class="gd-file-icon" aria-hidden="true">${escapeHtml(fileIconLabel(file.path))}</span><span>${escapeHtml(file.path)}</span></span><span class="muted">${escapeHtml(file.status)} +${file.additions} −${file.deletions}</span>${input.sessionView && !input.readOnly ? `<label class="gd-viewed-check"><input type="checkbox" data-guided-viewed-toggle data-path="${escapeHtml(file.path)}"${viewed.has(file.path) ? " checked" : ""}/> Viewed</label>` : ""}</h3>
      <div class="gd-file-primer" data-file-primer data-path="${escapeHtml(file.path)}"${walkthroughPayload ? "" : " hidden"}>${renderFilePrimerContent(filePrimer)}</div>
      ${file.truncated ? `<p class="notice if-banner if-banner--warning">This file exceeded the per-file rendering bound and is partially shown.</p>` : ""}
      <div class="guided-pierre-file" data-guided-pierre data-path="${escapeHtml(file.path)}" data-old-path="${escapeHtml(file.oldPath ?? file.path)}" data-session-id="${input.sessionId ?? ""}" data-commentable="${input.sessionView && !input.readOnly ? "1" : ""}">
        <div class="gd-fallback">${hunks}${empty}</div>
        <script type="application/json" class="guided-patch-raw">${jsJson(file.patch)}</script>
        <script type="application/json" class="guided-annotations-raw">${jsJson(guidedAnnotationsFor(file, input.comments, input.comparison))}</script>
      </div>
      ${input.sessionId ? `<details class="gd-context"><summary>Read-only surrounding code at the pinned SHA</summary><button type="button" class="if-button if-button--sm" data-load-context="${escapeHtml(file.path)}">Load head-side file</button><pre class="gd-context-panel" hidden></pre><p class="muted">Path-boundary validated; oversized or unavailable files fail explicitly.</p></details>` : ""}
    </article>`;
  }).join("\n");
  const draftPanel = input.sessionView ? renderGuidedDraftPanel({ session: input.sessionView, comments: input.comments ?? [], csrfToken: input.csrfToken, readOnly: input.readOnly }) : "";
  const explorationPrimer = renderGuidedExplorationPrimer({ walkthrough: input.walkthrough, sessionId: input.sessionId });
  const walkthroughPanel = renderGuidedWalkthroughPanel({ walkthrough: input.walkthrough, files: filtered, sessionId: input.sessionId, csrfToken: input.csrfToken });
  const attentionPanel = renderGuidedAttentionPanel({ attention: input.attention, sessionId: input.sessionId, csrfToken: input.csrfToken, readOnly: input.readOnly });
  const publishPanel = renderGuidedPublishPanel({ publish: input.publish, sessionId: input.sessionId, sessionVersion: input.sessionVersion, csrfToken: input.csrfToken });
  const comparisonPanel = renderGuidedComparisonPanel({ comparison: input.comparison, files: filtered, sessionId: input.sessionId, sessionVersion: input.sessionVersion, csrfToken: input.csrfToken, pullUrl: input.pullUrl });
  const diffSection = `<section class="config-section guided-diff-workspace" data-guided-diff-workspace>
    <div class="gd-head gd-diff-toolbar"><div><h2>Files changed</h2><p class="muted">Review the pinned diff; press <kbd>j</kbd>/<kbd>k</kbd> to move line-by-line and click a line number to comment.</p></div><button type="button" class="if-button if-button--sm guided-layout-toggle">Switch diff layout</button></div>
    <p class="muted">${input.files.length} files · ${total} changed lines${input.diffTruncated ? " · diff input truncated by configured byte bound" : ""}</p>
    <p class="error if-banner if-banner--danger" role="alert" data-guided-write-error hidden>Could not save viewed-file progress.</p>
    ${input.diffTruncated ? `<p class="notice if-banner if-banner--warning">The forge diff reached the configured byte bound. Hidden changes are not implied to be reviewed.</p>` : ""}
    <form class="trigger job-filters" method="get">
      <label>Status <select name="status"><option value="all">All statuses</option>${statuses.map((status) => `<option value="${status}"${input.statusFilter === status ? " selected" : ""}>${status}</option>`).join("")}</select></label>
      <button class="if-button if-button--sm" type="submit">Filter diff</button>
    </form>
    <div class="gd-layout"><nav class="gd-tree" aria-label="Changed files"><div class="gd-tree-head"><span>Changed files</span><label class="gd-tree-toggle"><input type="checkbox" data-guided-tree-toggle/> Tree</label></div><div class="gd-tree-flat"><ol>${tree}</ol></div><div class="gd-tree-nested">${treeView}</div></nav><div class="gd-files">${rendered || `<div class="empty">No files match this diff filter.</div>`}</div></div>
  </section>`;
  const reviewStep = `${explorationPrimer}${draftPanel}${diffSection}<div class="gd-review-secondary">${walkthroughPanel}</div>`;
  return `<div class="gd-wizard" data-guided-wizard>
    <input class="gd-wizard-radio" type="radio" name="gd-wizard-step" id="gd-step-review" checked/>
    <input class="gd-wizard-radio" type="radio" name="gd-wizard-step" id="gd-step-compare"/>
    <input class="gd-wizard-radio" type="radio" name="gd-wizard-step" id="gd-step-publish"/>
    <nav class="gd-wizard-nav" aria-label="Guided review steps">
      <label for="gd-step-review"><span>1</span><strong>Explore &amp; review</strong><small>primer, diff, private notes</small></label>
      <label for="gd-step-compare"><span>2</span><strong>Compare &amp; decide</strong><small>Maomao evidence and attention decision</small></label>
      <label for="gd-step-publish"><span>3</span><strong>Publish</strong><small>deliberate human review publication</small></label>
    </nav>
    <p class="muted gd-wizard-help">A guided flow, not a score or hard lock: inspect the exact pinned diff first, reconcile it with Maomao, then choose whether anything is published.</p>
    <div class="gd-wizard-panels">
      <div class="gd-wizard-panel gd-panel-review" data-wizard-panel="review">${reviewStep}</div>
      <div class="gd-wizard-panel gd-panel-compare" data-wizard-panel="compare">${attentionPanel}${comparisonPanel}</div>
      <div class="gd-wizard-panel gd-panel-publish" data-wizard-panel="publish">${publishPanel}</div>
    </div>
  </div>
  <script>
  (function(){
    var guidedSessionId=${jsJson(input.sessionId ?? null)};
    function move(delta){var rows=Array.from(document.querySelectorAll('[data-anchor-line]'));if(!rows.length)return;var current=document.activeElement&&rows.indexOf(document.activeElement);var next=rows[(current<0?0:current+delta+rows.length)%rows.length];next.tabIndex=-1;next.focus();next.scrollIntoView({block:'center'});}
    document.addEventListener('keydown',function(event){if(event.target&&/INPUT|TEXTAREA|SELECT/.test(event.target.tagName))return;if(event.key==='j'){event.preventDefault();move(1);}if(event.key==='k'){event.preventDefault();move(-1);}});
    var treeToggle=document.querySelector('[data-guided-tree-toggle]'),treeNav=document.querySelector('.gd-tree');
    if(treeToggle&&treeNav){treeToggle.checked=localStorage.getItem('maomao-guided-file-tree')==='tree';treeNav.classList.toggle('gd-tree-mode',treeToggle.checked);treeToggle.addEventListener('change',function(){localStorage.setItem('maomao-guided-file-tree',treeToggle.checked?'tree':'flat');treeNav.classList.toggle('gd-tree-mode',treeToggle.checked);});}
    document.addEventListener('click',async function(event){var button=event.target.closest('[data-load-context]');if(!button||!guidedSessionId)return;var details=button.closest('details'),panel=details&&details.querySelector('.gd-context-panel');if(!panel)return;button.disabled=true;button.textContent='Loading…';try{var res=await fetch('/api/guided-review/sessions/'+guidedSessionId+'/file?path='+encodeURIComponent(button.getAttribute('data-load-context'))+'&side=head');var body=await res.json();if(!res.ok)throw new Error(body.message||body.error||'load failed');panel.textContent=body.content;panel.hidden=false;button.textContent='Reload head-side file';}catch(error){panel.textContent='Could not load surrounding code: '+(error&&error.message?error.message:error);panel.hidden=false;button.textContent='Retry';}finally{button.disabled=false;}});
    var wizardRoot=document.querySelector('[data-guided-wizard]');
    function wizardStepForHash(hash){if(hash==='#compare'||hash==='#attention')return 'compare';if(hash==='#publish')return 'publish';return 'review';}
    function selectWizardStep(step,updateHash){var input=document.getElementById('gd-step-'+step);if(!input)return;input.checked=true;if(window.__maomaoPierre&&window.__maomaoPierre.setGuidedComparisonVisible)window.__maomaoPierre.setGuidedComparisonVisible(step==='compare');if(updateHash&&window.history&&history.replaceState)history.replaceState(null,'','#'+step);}
    if(wizardRoot){
      wizardRoot.addEventListener('change',function(event){if(event.target&&event.target.matches('.gd-wizard-radio'))selectWizardStep(event.target.id.replace('gd-step-',''),true);});
      var syncWizard=function(){var hash=window.location.hash||'#review';var step=wizardStepForHash(hash);selectWizardStep(step,false);if(hash.length>1&&step==='review'){var target=document.getElementById(hash.slice(1));if(target)target.scrollIntoView({block:'start'});}};
      document.addEventListener('click',function(event){var stepButton=event.target&&event.target.closest?event.target.closest('[data-goto-step]'):null;if(stepButton){selectWizardStep(stepButton.getAttribute('data-goto-step'),true);window.scrollTo({top:0,behavior:'smooth'});return;}var link=event.target&&event.target.closest?event.target.closest('a[href^="#f"],a[href^="#guided-file-"]'):null;if(!link)return;var hash=link.getAttribute('href')||'';selectWizardStep('review',false);setTimeout(function(){var target=document.getElementById(hash.slice(1));if(target)target.scrollIntoView({block:'center'});},0);});
      syncWizard();window.addEventListener('hashchange',syncWizard);
    }
  })();
  </script>`;
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
  diffWorkspace?: string;
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
    <section class="config-section guided-session-meta">
      <h2>SHA-pinned workspace</h2>
      <dl class="facts">
        <div><dt>Base</dt><dd><code>${escapeHtml(input.baseSha)}</code></dd></div>
        <div><dt>Head</dt><dd><code>${escapeHtml(input.headSha)}</code></dd></div>
        ${input.sessionId ? `<div><dt>Draft session</dt><dd>#${input.sessionId} · version ${input.sessionVersion ?? 1} · ${input.commentCount ?? 0} comments</dd></div>` : ""}
      </dl>
      ${input.canStart ? `<form method="post" action="/guided/github/${encodeURIComponent(input.repoFullName.split("/")[0])}/${encodeURIComponent(input.repoFullName.split("/")[1])}/${input.prNumber}/open">${csrfInput(input.options.csrfToken)}<button class="if-button if-button--primary" type="submit">Start guided draft</button></form><p class="muted">Starting creates your actor-private SHA-pinned draft; returning to the same SHAs resumes it. Publication remains a later deliberate step.</p>` : ""}
    </section>
    ${input.diffWorkspace ?? ""}
    <script src="${diskAssetUrl(GUIDED_BUNDLE_HREF)}" defer onerror="document.querySelectorAll('[data-guided-bundle-error]').forEach(function(el){el.hidden=false})"></script>`;
  return layout(`Guided Review #${input.prNumber}`, body, { ...input.options, nav: "guided" });
}
