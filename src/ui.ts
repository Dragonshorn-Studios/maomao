import type { JobRow, JobStore, ReviewerRunRow } from "./jobs/store.js";
import { elapsedMs, escapeHtml, formatDuration, shortSha } from "./util.js";
import type { ReviewerResult } from "./schema.js";

export interface PageOptions {
  showLogout?: boolean;
  live?: boolean;
  notice?: string;
  error?: string;
  reviewUrl?: string;
}

export function layout(title: string, body: string, options: PageOptions = {}): string {
  const live = options.live !== false;
  const logout = options.showLogout
    ? `<form method="post" action="/logout" class="logout"><button type="submit">Log out</button></form>`
    : "";
  const script = live
    ? `<script>
    const events = new EventSource("/events");
    events.addEventListener("message", () => {});
    events.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "hello") return;
        if (location.pathname === "/" && (data.type === "jobs" || data.type === "job")) {
          location.reload();
        }
        if (location.pathname.startsWith("/jobs/") && (data.type === "job" || data.type === "log")) {
          const id = Number(location.pathname.split("/")[2]);
          if (!data.jobId || data.jobId === id) location.reload();
        }
      } catch {}
    };
  </script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>${css()}</style>
</head>
<body>
  <header class="top">
    <a class="brand" href="/">Maomao</a>
    <span class="tag">PR review factory</span>
    <span class="grow"></span>
    <a href="/health">health</a>
    ${logout}
  </header>
  <main>${body}</main>
  ${script}
</body>
</html>`;
}

export function renderLogin(error: boolean, nextPath: string): string {
  const body = `
    <h1>Sign in</h1>
    <p class="lede">Enter the monitoring password to view jobs, logs, and APIs.</p>
    ${error ? `<p class="error">Invalid password.</p>` : ""}
    <form class="login" method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}"/>
      <label>
        Password
        <input type="password" name="password" autocomplete="current-password" autofocus required/>
      </label>
      <button type="submit">Sign in</button>
    </form>`;
  return layout("Maomao sign in", body, { live: false });
}

export function renderHome(jobs: JobRow[], store: JobStore, options: PageOptions = {}): string {
  const rows = jobs
    .map((job) => {
      const summary = store.jobSummary(job);
      const elapsed = formatDuration(elapsedMs(job.started_at, job.finished_at) ?? elapsedMs(job.created_at));
      return `<tr>
        <td><a href="/jobs/${job.id}">#${job.id}</a></td>
        <td>
          <div class="repo">${escapeHtml(job.repo_full_name)}#${job.pr_number}</div>
          <div class="muted">${escapeHtml(job.pr_title || "(no title)")}</div>
        </td>
        <td><code>${escapeHtml(shortSha(job.head_sha, 10))}</code></td>
        <td><span class="state state-${escapeHtml(job.state)}">${escapeHtml(job.state)}</span></td>
        <td>${summary.reviewersDone}/${summary.reviewersTotal}</td>
        <td>${escapeHtml(job.aggregator_state)}</td>
        <td>${escapeHtml(elapsed)}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <h1>Review jobs</h1>
    <p class="lede">Recent pull request reviews. Jobs are anchored to an exact head SHA.</p>
    ${options.notice ? `<p class="notice">${escapeHtml(options.notice)}</p>` : ""}
    ${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ""}
    <form class="trigger" method="post" action="/reviews">
      <label>
        Queue a GitHub pull request
        <input type="url" name="url" placeholder="https://github.com/owner/repo/pull/123" value="${escapeHtml(options.reviewUrl ?? "")}" required/>
      </label>
      <button type="submit">Queue review</button>
    </form>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Pull request</th><th>SHA</th><th>State</th><th>Reviewers</th><th>Aggregator</th><th>Elapsed</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="7" class="muted">No jobs yet. Waiting for GitHub pull_request webhooks.</td></tr>`}
      </tbody>
    </table>`;
  return layout("Maomao", body, options);
}

export function renderJob(
  job: JobRow,
  runs: ReviewerRunRow[],
  logs: { created_at: string; level: string; message: string }[],
  options: PageOptions = {},
): string {
  const findings = collectFindings(runs);
  const body = `
    <p class="crumb"><a href="/">Jobs</a> / job ${job.id}</p>
    ${options.notice ? `<p class="notice">${escapeHtml(options.notice)}</p>` : ""}
    <h1>${escapeHtml(job.repo_full_name)}#${job.pr_number}</h1>
    <p class="lede">${escapeHtml(job.pr_title || "")}</p>
    <section class="meta">
      <div><span>State</span><span class="state state-${escapeHtml(job.state)}">${escapeHtml(job.state)}</span></div>
      <div><span>Head SHA</span><code>${escapeHtml(job.head_sha)}</code></div>
      <div><span>Base SHA</span><code>${escapeHtml(job.base_sha)}</code></div>
      <div><span>Elapsed</span>${escapeHtml(formatDuration(elapsedMs(job.started_at, job.finished_at) ?? elapsedMs(job.created_at)))}</div>
      <div><span>Aggregator</span>${escapeHtml(job.aggregator_state)} ${job.aggregator_model ? `<code>${escapeHtml(job.aggregator_model)}</code>` : ""}</div>
      <div><span>GitHub review</span>${job.github_review_url ? `<a href="${escapeHtml(job.github_review_url)}">${escapeHtml(job.github_review_id || "view")}</a>` : "—"}</div>
    </section>
    ${job.failure_reason ? `<p class="error">Failure: ${escapeHtml(job.failure_reason)}</p>` : ""}
    <h2>Reviewers</h2>
    <div class="cards">
      ${runs.map(renderRun).join("")}
    </div>
    <h2>Aggregator</h2>
    <pre>${escapeHtml(job.aggregator_normalized || job.aggregator_raw || "(pending)")}</pre>
    <h2>Findings</h2>
    ${findings || `<p class="muted">No normalized findings yet.</p>`}
    <h2>Logs</h2>
    <ol class="logs">
      ${logs.map((log) => `<li><span class="muted">${escapeHtml(log.created_at)}</span> <strong>${escapeHtml(log.level)}</strong> ${escapeHtml(log.message)}</li>`).join("") || "<li class='muted'>No logs</li>"}
    </ol>
  `;
  return layout(`${job.repo_full_name}#${job.pr_number}`, body, options);
}

function renderRun(run: ReviewerRunRow): string {
  let findingCount = 0;
  if (run.normalized_json) {
    try {
      findingCount = (JSON.parse(run.normalized_json) as ReviewerResult).findings.length;
    } catch {
      findingCount = 0;
    }
  }
  return `<article class="card">
    <header>
      <strong>${escapeHtml(run.title || run.role)}</strong>
      <span class="state state-${escapeHtml(run.state)}">${escapeHtml(run.state)}</span>
    </header>
    <p class="muted">${escapeHtml(run.model || "default model")} · attempt ${run.attempt} · ${escapeHtml(formatDuration(run.duration_ms))} · ${findingCount} finding(s)</p>
    ${run.validation_error ? `<p class="error">${escapeHtml(run.validation_error)}</p>` : ""}
    ${run.normalized_json ? `<details><summary>normalized JSON</summary><pre>${escapeHtml(run.normalized_json)}</pre></details>` : ""}
    ${run.stdout ? `<details><summary>stdout</summary><pre>${escapeHtml(run.stdout)}</pre></details>` : ""}
    ${run.stderr ? `<details><summary>stderr</summary><pre>${escapeHtml(run.stderr)}</pre></details>` : ""}
  </article>`;
}

function collectFindings(runs: ReviewerRunRow[]): string {
  const items: string[] = [];
  for (const run of runs) {
    if (!run.normalized_json) continue;
    try {
      const parsed = JSON.parse(run.normalized_json) as ReviewerResult;
      for (const finding of parsed.findings) {
        const loc = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
        items.push(
          `<li><strong>${escapeHtml(finding.severity)}</strong> <code>${escapeHtml(run.role)}</code> ${escapeHtml(loc)} — ${escapeHtml(finding.summary)}</li>`,
        );
      }
    } catch {
      // ignore
    }
  }
  return items.length ? `<ul class="findings">${items.join("")}</ul>` : "";
}

function css(): string {
  return `
    :root { color-scheme: dark; --bg:#101218; --fg:#e8e6df; --muted:#9a968a; --card:#1a1d27; --line:#2a2e3b; --acc:#d4a017; }
    * { box-sizing: border-box; }
    body { margin:0; font: 15px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
    a { color:#e8d48b; }
    .top { display:flex; gap:1rem; align-items:center; padding:.9rem 1.4rem; border-bottom:1px solid var(--line); }
    .brand { font-weight:700; color:var(--fg); text-decoration:none; letter-spacing:.02em; }
    .tag { color:var(--muted); font-size:.85rem; }
    .grow { flex:1; }
    main { padding:1.4rem 1.6rem 3rem; max-width:1100px; }
    h1 { margin:.2rem 0 .4rem; font-size:1.6rem; }
    .lede, .muted, .crumb { color:var(--muted); }
    table { width:100%; border-collapse:collapse; background:var(--card); }
    th, td { text-align:left; padding:.65rem .75rem; border-bottom:1px solid var(--line); vertical-align:top; }
    th { font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size:.86em; }
    .state { display:inline-block; padding:.1rem .45rem; border-radius:999px; font-size:.78rem; background:#2a2e3b; }
    .state-completed { background:#1e3a2f; color:#b7f0cc; }
    .state-failed { background:#3a1e1e; color:#f0b7b7; }
    .state-stale, .state-cancelled { background:#3a3620; color:#e6d9a2; }
    .state-reviewing, .state-aggregating, .state-publishing, .state-running { background:#1e2c3a; color:#b7d4f0; }
    .state-queued, .state-preparing, .state-done { background:#2a2e3b; }
    .meta { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap:.6rem 1rem; margin:1rem 0; }
    .meta div { background:var(--card); padding:.7rem .8rem; border:1px solid var(--line); }
    .meta span:first-child { display:block; color:var(--muted); font-size:.78rem; text-transform:uppercase; }
    .cards { display:grid; gap: .8rem; }
    .card { background:var(--card); border:1px solid var(--line); padding:.8rem 1rem; }
    .card header { display:flex; justify-content:space-between; gap:1rem; align-items:center; }
    pre { white-space:pre-wrap; word-break:break-word; background:#0c0e14; padding:.8rem; border:1px solid var(--line); overflow:auto; max-height:320px; }
    .logs { padding-left:1.1rem; }
    .error { color:#f0b7b7; }
    details { margin:.4rem 0; }
    .login { max-width: 22rem; display:grid; gap:.8rem; background:var(--card); padding:1rem; border:1px solid var(--line); }
    .login input { width:100%; margin-top:.3rem; padding:.45rem .5rem; background:#0c0e14; color:var(--fg); border:1px solid var(--line); }
    .login button, .logout button, .trigger button { background:var(--acc); color:#111; border:0; padding:.45rem .8rem; font-weight:600; cursor:pointer; }
    .logout { margin:0; }
    .notice { color:#b7f0cc; }
    .trigger { display:flex; gap:.6rem; align-items:end; flex-wrap:wrap; margin:1rem 0 1.2rem; background:var(--card); border:1px solid var(--line); padding:.8rem 1rem; }
    .trigger label { flex:1; min-width:16rem; color:var(--muted); font-size:.85rem; }
    .trigger input { width:100%; margin-top:.3rem; padding:.45rem .5rem; background:#0c0e14; color:var(--fg); border:1px solid var(--line); }
  `;
}
