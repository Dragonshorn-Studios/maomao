import { escapeHtml } from "../util.js";
import type { GuidedInboxItem, GuidedInboxPage } from "../guided/inbox.js";
import type { GuidedDiffFile } from "../guided/diff.js";
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

function scriptText(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

function jsJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function guidedDiffLineHtml(file: GuidedDiffFile, hunkIndex: number, line: GuidedDiffFile["hunks"][number]["lines"][number], baseSha = "", headSha = ""): string {
  const side = line.kind === "del" ? "LEFT" : "RIGHT";
  const lineNumber = line.kind === "del" ? line.oldLine : line.newLine;
  const anchor = lineNumber ? `L${side === "LEFT" ? "o" : "n"}${lineNumber}` : "";
  const oldText = line.oldLine ?? "";
  const newText = line.newLine ?? "";
  return `<tr class="gd-line gd-${line.kind}"${anchor ? ` id="f${encodeURIComponent(file.path)}-h${hunkIndex}-${anchor}" data-anchor-path="${escapeHtml(file.path)}" data-anchor-side="${side}" data-anchor-line="${lineNumber}" data-anchor-sha="${escapeHtml(side === "LEFT" ? baseSha : headSha)}"` : ""}>
    <td class="gd-no gd-old">${oldText}</td><td class="gd-no gd-new">${newText}</td><td class="gd-code"><span>${escapeHtml(line.text)}</span></td>
  </tr>`;
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
}): string {
  if (input.diffError) {
    return `<section class="config-section guided-diff-workspace"><h2>Diff workspace</h2><p class="error if-banner if-banner--danger" role="alert">${escapeHtml(input.diffError)}</p><p class="muted">Maomao cannot imply unseen changes were reviewed. Retry after the forge recovers or raise the diff size limit.</p></section>`;
  }
  const statuses = [...new Set(input.files.map((file) => file.status))].sort();
  const filtered = input.files.filter((file) =>
    (!input.statusFilter || input.statusFilter === "all" || file.status === input.statusFilter) &&
    (!input.fileFilter || file.path.toLowerCase().includes(input.fileFilter.toLowerCase())),
  );
  const total = input.files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const viewed = new Set(input.viewedFiles ?? []);
  const tree = filtered.map((file, index) => `<li><a href="#guided-file-${index}" data-guided-file-link>${viewed.has(file.path) ? "✓ " : ""}${escapeHtml(file.path)}</a> <span class="muted">${escapeHtml(file.status)} +${file.additions} −${file.deletions}</span></li>`).join("");
  const rendered = filtered.map((file, index) => {
    const hunks = file.hunks.map((hunk, hunkIndex) => `<details class="gd-hunk" open>
      <summary>${escapeHtml(hunk.header)}</summary>
      <table class="gd-table"><tbody>${hunk.lines.map((line) => guidedDiffLineHtml(file, hunkIndex, line, input.baseSha, input.headSha)).join("\n")}</tbody></table>
    </details>`).join("\n");
    const empty = file.binary ? `<p class="muted">Binary file changed; inline diff is unavailable.</p>` : file.hunks.length === 0 ? `<p class="muted">No textual hunks are available for this file.</p>` : "";
    return `<article class="gd-file${viewed.has(file.path) ? " gd-viewed" : ""}" id="guided-file-${index}" data-guided-file data-path="${escapeHtml(file.path)}" data-status="${escapeHtml(file.status)}">
      <h3>${escapeHtml(file.path)} <span class="muted">${escapeHtml(file.status)} +${file.additions} −${file.deletions}</span></h3>
      ${file.truncated ? `<p class="notice if-banner if-banner--warning">This file exceeded the per-file rendering bound and is partially shown.</p>` : ""}
      ${input.sessionId ? `<details class="gd-context"><summary>Read-only surrounding code at the pinned SHA</summary><button type="button" class="if-button if-button--sm" data-load-context="${escapeHtml(file.path)}">Load head-side file</button><pre class="gd-context-panel" hidden></pre><p class="muted">Path-boundary validated; oversized or unavailable files fail explicitly.</p></details>` : ""}
      <div class="guided-pierre-file" data-guided-pierre data-path="${escapeHtml(file.path)}">
        <div class="gd-fallback">${hunks}${empty}</div>
        <script type="text/plain" class="guided-patch-raw">${scriptText(file.patch)}</script>
      </div>
    </article>`;
  }).join("\n");
  return `<section class="config-section guided-diff-workspace" data-guided-diff-workspace>
    <div class="gd-head"><h2>Diff workspace</h2><button type="button" class="if-button if-button--sm guided-layout-toggle">Switch diff layout</button></div>
    <p class="muted">${input.files.length} files · ${total} changed lines${input.diffTruncated ? " · diff input truncated by configured byte bound" : ""}</p>
    <p class="error if-banner if-banner--danger" role="alert" data-guided-write-error hidden>Could not save viewed-file progress.</p>
    ${input.diffTruncated ? `<p class="notice if-banner if-banner--warning">The forge diff reached the configured byte bound. Hidden changes are not implied to be reviewed.</p>` : ""}
    <form class="trigger job-filters" method="get">
      <label>File filter <input type="search" name="file" value="${escapeHtml(input.fileFilter ?? "")}" placeholder="path"/></label>
      <label>Status <select name="status"><option value="all">All statuses</option>${statuses.map((status) => `<option value="${status}"${input.statusFilter === status ? " selected" : ""}>${status}</option>`).join("")}</select></label>
      <button class="if-button if-button--sm" type="submit">Filter diff</button>
    </form>
    <div class="gd-layout"><nav class="gd-tree" aria-label="Changed files"><ol>${tree}</ol></nav><div class="gd-files">${rendered || `<div class="empty">No files match this diff filter.</div>`}</div></div>
  </section>
  <script>
  (function(){
    var guidedSessionId=${jsJson(input.sessionId ?? null)},guidedVersion=${jsJson(input.sessionVersion ?? null)},guidedCsrf=${jsJson(input.csrfToken ?? "")},guidedViewed=${jsJson(input.viewedFiles ?? [])};
    function move(delta){var rows=Array.from(document.querySelectorAll('[data-anchor-line]'));if(!rows.length)return;var current=document.activeElement&&rows.indexOf(document.activeElement);var next=rows[(current<0?0:current+delta+rows.length)%rows.length];next.tabIndex=-1;next.focus();next.scrollIntoView({block:'center'});}
    document.addEventListener('keydown',function(event){if(event.target&&/INPUT|TEXTAREA|SELECT/.test(event.target.tagName))return;if(event.key==='j'){event.preventDefault();move(1);}if(event.key==='k'){event.preventDefault();move(-1);}});
    var viewedQueue=Promise.resolve();
    function markViewed(path){if(!guidedSessionId||!guidedVersion||guidedViewed.indexOf(path)>=0)return;guidedViewed.push(path);viewedQueue=viewedQueue.then(async function(){try{var res=await fetch('/api/guided-review/sessions/'+guidedSessionId,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:guidedVersion,viewedFiles:guidedViewed,csrf_token:guidedCsrf})});if(!res.ok)throw new Error('viewed save failed');var body=await res.json();guidedVersion=body.session.version;var file=document.querySelector('[data-guided-file][data-path="'+CSS.escape(path)+'"]');if(file)file.classList.add('gd-viewed');}catch(error){console.warn('guided viewed-file save failed',error);var warning=document.querySelector('[data-guided-write-error]');if(warning)warning.hidden=false;guidedViewed=guidedViewed.filter(function(entry){return entry!==path});}});}
    if('IntersectionObserver' in window){var seen=new WeakSet(),observer=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting&&!seen.has(entry.target)){seen.add(entry.target);setTimeout(function(){markViewed(entry.target.getAttribute('data-path')||'')},500);}})},{threshold:.35});document.querySelectorAll('[data-guided-file]').forEach(function(file){observer.observe(file)});}
    document.addEventListener('click',async function(event){var button=event.target.closest('[data-load-context]');if(!button||!guidedSessionId)return;var details=button.closest('details'),panel=details&&details.querySelector('.gd-context-panel');if(!panel)return;button.disabled=true;button.textContent='Loading…';try{var res=await fetch('/api/guided-review/sessions/'+guidedSessionId+'/file?path='+encodeURIComponent(button.getAttribute('data-load-context'))+'&side=head');var body=await res.json();if(!res.ok)throw new Error(body.message||body.error||'load failed');panel.textContent=body.content;panel.hidden=false;button.textContent='Reload head-side file';}catch(error){panel.textContent='Could not load surrounding code: '+(error&&error.message?error.message:error);panel.hidden=false;button.textContent='Retry';}finally{button.disabled=false;}});
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
    <section class="config-section">
      <h2>SHA-pinned workspace</h2>
      <dl class="facts">
        <div><dt>Base</dt><dd><code>${escapeHtml(input.baseSha)}</code></dd></div>
        <div><dt>Head</dt><dd><code>${escapeHtml(input.headSha)}</code></dd></div>
        ${input.sessionId ? `<div><dt>Draft session</dt><dd>#${input.sessionId} · version ${input.sessionVersion ?? 1} · ${input.commentCount ?? 0} comments</dd></div>` : ""}
      </dl>
      ${input.canStart ? `<form method="post" action="/guided/github/${encodeURIComponent(input.repoFullName.split("/")[0])}/${encodeURIComponent(input.repoFullName.split("/")[1])}/${input.prNumber}/open">${csrfInput(input.options.csrfToken)}<button class="if-button if-button--primary" type="submit">Start guided draft</button></form>` : ""}
      <p class="muted">The diff workspace and walkthrough land in the next Guided Review slices. Starting creates your actor-private SHA-pinned draft; returning to the same SHAs resumes it.</p>
    </section>
    ${input.diffWorkspace ?? ""}`;
  return layout(`Guided Review #${input.prNumber}`, body, { ...input.options, nav: "guided" });
}
