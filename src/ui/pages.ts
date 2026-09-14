import type { JobRow, JobStore, ReviewerRunRow } from "../jobs/store.js";
import { elapsedMs, escapeHtml, formatDuration, shortSha } from "../util.js";
import {
  emptyQueueCopy,
  flavorForJob,
  jobStateLabel,
  observationsCopy,
  runStateLabel,
  severityLabel,
  staleBanner,
} from "./copy.js";
import { roleGlyph } from "./glyphs.js";
import { layout, type PageOptions } from "./layout.js";
import {
  findingLocation,
  formatCost,
  formatTokens,
  jobMetrics,
  jobMetricsFromRuns,
  parseReviewerResult,
  type JobMetrics,
  type SeverityCounts,
} from "./metrics.js";

export type { PageOptions };

export function renderLogin(error: boolean, nextPath: string): string {
  const body = `
    <h1>Sign in</h1>
    <p class="lede">Enter the monitoring password to view jobs, logs, and APIs.</p>
    ${error ? `<p class="error" role="alert">Invalid password.</p>` : ""}
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
  const empty = emptyQueueCopy();
  const cards = jobs
    .map((job) => renderQueueCard(job, jobMetrics(job, store)))
    .join("");

  const body = `
    <h1>Review jobs</h1>
    <p class="lede">Recent pull request reviews. Each job is anchored to an exact head SHA.</p>
    ${options.notice ? `<p class="notice" role="status">${escapeHtml(options.notice)}</p>` : ""}
    ${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ""}
    <form class="trigger" method="post" action="/reviews">
      <label>
        Queue a GitHub pull request
        <input type="url" name="url" placeholder="https://github.com/owner/repo/pull/123" value="${escapeHtml(options.reviewUrl ?? "")}" required/>
      </label>
      <button type="submit">Queue review</button>
    </form>
    ${
      cards
        ? `<ol class="queue">${cards}</ol>`
        : `<div class="empty" role="status">
            <p><strong>${escapeHtml(empty.title)}</strong></p>
            <p class="muted">${escapeHtml(empty.body)}</p>
          </div>`
    }`;
  return layout("Maomao", body, options);
}

export function renderJob(
  job: JobRow,
  runs: ReviewerRunRow[],
  logs: { created_at: string; level: string; message: string }[],
  options: PageOptions = {},
): string {
  const metrics = jobMetricsFromRuns(job, runs);
  const state = jobStateLabel(job.state);
  const flavor = flavorForJob(job.state, job.pr_number);
  const elapsed = formatDuration(elapsedMs(job.started_at, job.finished_at) ?? elapsedMs(job.created_at));
  const stale = job.state === "stale";
  const findingsHtml = renderFindings(metrics);
  const failedToRetry = retryableFailedCount(job, runs);
  const body = `
    <p class="crumb"><a href="/">Jobs</a> / job ${job.id}</p>
    ${options.notice ? `<p class="notice" role="status">${escapeHtml(options.notice)}</p>` : ""}
    ${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ""}
    ${stale ? `<p class="warn" role="status">${escapeHtml(staleBanner())}</p>` : ""}
    <h1>${escapeHtml(job.repo_full_name)}#${job.pr_number}</h1>
    <p class="lede">${escapeHtml(job.pr_title || "")}${flavor ? ` · ${escapeHtml(flavor)}` : ""}</p>
    <dl class="meta-grid">
      <div class="sha-block">
        <dt>Reviewed head SHA</dt>
        <dd><code class="sha">${escapeHtml(job.head_sha)}</code></dd>
      </div>
      <div>
        <dt>State</dt>
        <dd>${renderState(job.state, state.text, state.hint, state.mark)}</dd>
      </div>
      <div>
        <dt>Base SHA</dt>
        <dd><code class="sha">${escapeHtml(job.base_sha)}</code></dd>
      </div>
      <div>
        <dt>Refs</dt>
        <dd><code>${escapeHtml(job.base_ref || "—")}</code> → <code>${escapeHtml(job.head_ref || "—")}</code></dd>
      </div>
      <div>
        <dt>Elapsed</dt>
        <dd class="metric">${escapeHtml(elapsed)}</dd>
      </div>
      <div>
        <dt>Aggregator</dt>
        <dd>${renderState(job.aggregator_state, runStateLabel(job.aggregator_state).text, runStateLabel(job.aggregator_state).hint, runStateLabel(job.aggregator_state).mark)}
          ${job.aggregator_model ? `<code class="metric">${escapeHtml(job.aggregator_model)}</code>` : ""}
          ${job.aggregator_provider ? `<span class="muted"> · <code class="metric">${escapeHtml(job.aggregator_provider)}</code></span>` : ""}
        </dd>
      </div>
      <div>
        <dt>Tokens / cost</dt>
        <dd class="metric">${escapeHtml(formatTokens(metrics.tokens))} · ${escapeHtml(formatCost(metrics.cost))}</dd>
      </div>
      <div>
        <dt>GitHub review</dt>
        <dd>${
          job.github_review_url
            ? `<a href="${escapeHtml(job.github_review_url)}">${escapeHtml(job.github_review_id || "view COMMENT review")}</a>`
            : job.state === "completed"
              ? "not published"
              : "—"
        }</dd>
      </div>
    </dl>
    ${job.failure_reason ? `<p class="error" role="alert"><strong>Failure:</strong> ${escapeHtml(job.failure_reason)}</p>` : ""}
    <h2>Reviewers</h2>
    <p class="muted">${escapeHtml(progressCopy(metrics))}</p>
    ${failedToRetry > 0 ? renderJobRetry(job.id, failedToRetry) : ""}
    <div class="cards">
      ${runs.map((run) => renderRun(run, canRetryRun(job, run))).join("")}
    </div>
    <h2>Aggregator</h2>
    ${renderAggregator(job, metrics)}
    <h2 id="findings">Findings</h2>
    ${findingsHtml}
    <h2>Logs</h2>
    <ol class="logs" aria-label="Job logs">
      ${
        logs
          .map(
            (log) =>
              `<li><span class="muted">${escapeHtml(log.created_at)}</span> <strong class="lvl">${escapeHtml(log.level)}</strong> ${escapeHtml(log.message)}</li>`,
          )
          .join("") || "<li class='muted'>No logs</li>"
      }
    </ol>
  `;
  return layout(`${job.repo_full_name}#${job.pr_number}`, body, options);
}

function renderQueueCard(job: JobRow, metrics: JobMetrics): string {
  const state = jobStateLabel(job.state);
  const elapsed = formatDuration(elapsedMs(job.started_at, job.finished_at) ?? elapsedMs(job.created_at));
  const live = ["preparing", "reviewing", "aggregating", "publishing"].includes(job.state);
  const flavor = flavorForJob(job.state, job.pr_number);
  return `<li>
    <article class="specimen${live ? " is-live" : ""}">
      <div class="specimen-head">
        <span class="specimen-id">Specimen · job ${job.id}</span>
        ${renderState(job.state, state.text, state.hint, state.mark)}
      </div>
      <p class="specimen-title"><a href="/jobs/${job.id}">${escapeHtml(job.repo_full_name)}#${job.pr_number} · ${escapeHtml(job.pr_title || "(no title)")}</a></p>
      ${flavor ? `<p class="muted">${escapeHtml(flavor)}</p>` : ""}
      <div class="meta-row">
        <span class="pair">SHA <strong><code class="sha">${escapeHtml(shortSha(job.head_sha, 10))}</code></strong></span>
        <span class="pair">Elapsed <strong class="metric">${escapeHtml(elapsed)}</strong></span>
        <span class="pair">Model <strong><code class="metric">${escapeHtml(metrics.model || "—")}</code></strong></span>
        ${metrics.provider ? `<span class="pair">Provider <strong><code class="metric">${escapeHtml(metrics.provider)}</code></strong></span>` : ""}
        <span class="pair">Tokens <strong class="metric">${escapeHtml(formatTokens(metrics.tokens))}</strong></span>
        <span class="pair">Cost <strong class="metric">${escapeHtml(formatCost(metrics.cost))}</strong></span>
      </div>
      ${renderDiagnosis(metrics, job.aggregator_state)}
      ${renderSeverityChips(metrics.findings)}
    </article>
  </li>`;
}

function renderDiagnosis(metrics: JobMetrics, aggregatorState: string): string {
  const ticks = metrics.reviewerStates
    .map((state) => {
      const label = runStateLabel(state);
      return `<span class="tick ${escapeHtml(state)}" title="${escapeHtml(label.text)}"></span>`;
    })
    .join("");
  const agg = runStateLabel(aggregatorState);
  return `<div class="diagnosis" aria-label="${escapeHtml(progressCopy(metrics))}; aggregator ${agg.text}">
    <span class="ticks" aria-hidden="true">${ticks}</span>
    <span>Reviewers <strong>${metrics.reviewersDone} / ${metrics.reviewersTotal}</strong></span>
    <span class="join" aria-hidden="true">→</span>
    <span>Aggregator ${renderState(aggregatorState, agg.text, agg.hint, agg.mark)}</span>
    <span class="muted">${escapeHtml(observationsCopy(metrics.findings.total))}</span>
  </div>`;
}

function renderSeverityChips(counts: SeverityCounts): string {
  if (counts.total === 0) return `<div class="meta-row"><span class="muted">No suspicious findings</span></div>`;
  const keys = ["blocker", "high", "medium", "low", "info"] as const;
  const chips = keys
    .filter((key) => counts[key] > 0)
    .map((key) => {
      const label = severityLabel(key);
      return `<span class="sev sev-${key}"><span class="mark" aria-hidden="true">${label.mark}</span> ${label.text} ${counts[key]}</span>`;
    })
    .join(" ");
  return `<div class="meta-row" aria-label="Findings by severity">${chips}</div>`;
}

function renderState(stateClass: string, text: string, hint: string, mark: string): string {
  return `<span class="state state-${escapeHtml(stateClass)}" title="${escapeHtml(hint)}"><span class="mark" aria-hidden="true">${escapeHtml(mark)}</span> ${escapeHtml(text)}</span>`;
}

function progressCopy(metrics: JobMetrics): string {
  const failed = metrics.reviewersFailed ? `, ${metrics.reviewersFailed} failed` : "";
  return `${metrics.reviewersDone} / ${metrics.reviewersTotal} reviewers done${failed}`;
}

function retryableFailedCount(job: JobRow, runs: ReviewerRunRow[]): number {
  if (!["failed", "completed"].includes(job.state)) return 0;
  return runs.filter((run) => run.state === "failed").length;
}

function canRetryRun(job: JobRow, run: ReviewerRunRow): boolean {
  return ["failed", "completed"].includes(job.state) && run.state === "failed";
}

function renderJobRetry(jobId: number, count: number): string {
  const label = count === 1 ? "Retry failed reviewer" : `Retry ${count} failed reviewers`;
  return `<form class="retry-job" method="post" action="/jobs/${jobId}/retry">
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function renderRun(run: ReviewerRunRow, showRetry = false): string {
  const parsed = parseReviewerResult(run.normalized_json);
  const findingCount = parsed?.findings.length ?? 0;
  const state = runStateLabel(run.state);
  const tokens =
    (run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0) > 0
      ? `${formatTokens((run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0))} tokens`
      : null;
  return `<article class="card">
    <header>
      <span class="role">${roleGlyph(run.role)} <strong>${escapeHtml(run.title || run.role)}</strong> <span class="muted">(${escapeHtml(run.role)})</span></span>
      <span class="run-actions">
        ${renderState(run.state, state.text, state.hint, state.mark)}
        ${
          showRetry
            ? `<form class="retry" method="post" action="/jobs/${run.job_id}/reviewers/${run.id}/retry">
                 <button type="submit">Retry</button>
               </form>`
            : ""
        }
      </span>
    </header>
    <p class="muted">
      model <code class="metric">${escapeHtml(run.model || "default model")}</code>
      ${run.provider ? ` · provider <code class="metric">${escapeHtml(run.provider)}</code>` : ""}
      · attempt ${run.attempt}
      · <span class="metric">${escapeHtml(formatDuration(run.duration_ms))}</span>
      ${tokens ? ` · <span class="metric">${escapeHtml(tokens)}</span>` : ""}
      ${run.cost != null ? ` · <span class="metric">${escapeHtml(formatCost(run.cost))}</span>` : ""}
      · ${findingCount} finding(s)
    </p>
    ${run.validation_error ? `<p class="error" role="alert"><strong>Validation error:</strong> ${escapeHtml(run.validation_error)}</p>` : ""}
    ${parsed?.summary ? `<p>${escapeHtml(parsed.summary)}</p>` : ""}
    ${run.normalized_json ? `<details><summary>Normalized JSON</summary><pre class="log-panel">${escapeHtml(run.normalized_json)}</pre></details>` : ""}
    ${run.raw_output && run.raw_output !== run.normalized_json ? `<details><summary>Raw output</summary><pre class="log-panel">${escapeHtml(run.raw_output)}</pre></details>` : ""}
    ${run.stdout ? `<details><summary>stdout</summary><pre class="log-panel">${escapeHtml(run.stdout)}</pre></details>` : ""}
    ${run.stderr ? `<details><summary>stderr</summary><pre class="log-panel">${escapeHtml(run.stderr)}</pre></details>` : ""}
  </article>`;
}

function renderAggregator(job: JobRow, metrics: JobMetrics): string {
  const agg = metrics.aggregator;
  const state = runStateLabel(job.aggregator_state);
  const heading =
    agg?.verdict === "clean"
      ? "No suspicious findings"
      : agg?.findings?.length
        ? observationsCopy(agg.findings.length)
        : "Aggregator result";
  return `<article class="card">
    <header>
      <span class="role role-agg">${roleGlyph("aggregator")} <strong>Aggregator</strong></span>
      ${renderState(job.aggregator_state, state.text, state.hint, state.mark)}
    </header>
    <p class="muted">
      ${job.aggregator_model ? `model <code class="metric">${escapeHtml(job.aggregator_model)}</code>` : "model pending"}
      ${job.aggregator_provider ? ` · provider <code class="metric">${escapeHtml(job.aggregator_provider)}</code>` : ""}
      · <span class="metric">${escapeHtml(formatDuration(job.aggregator_duration_ms))}</span>
    </p>
    <p><strong>${escapeHtml(heading)}</strong></p>
    ${agg?.summary ? `<pre class="log-panel">${escapeHtml(agg.summary)}</pre>` : job.aggregator_normalized || job.aggregator_raw ? "" : `<p class="muted">(pending)</p>`}
    ${job.aggregator_normalized ? `<details><summary>Normalized JSON</summary><pre class="log-panel">${escapeHtml(job.aggregator_normalized)}</pre></details>` : ""}
    ${job.aggregator_raw ? `<details><summary>Raw output</summary><pre class="log-panel">${escapeHtml(job.aggregator_raw)}</pre></details>` : ""}
  </article>`;
}

function renderFindings(metrics: JobMetrics): string {
  const items = metrics.aggregator?.findings?.length
    ? metrics.aggregator.findings.map((finding) => ({ ...finding, role: finding.category, reason: finding.body ?? "" }))
    : metrics.specialistFindings.map((finding) => ({ ...finding, reason: finding.reason }));

  if (items.length === 0) {
    return `<p class="muted">${metrics.aggregator?.verdict === "clean" ? "No suspicious findings" : "No normalized findings yet."}</p>`;
  }

  return items
    .map((finding) => {
      const sev = severityLabel(finding.severity);
      const loc = findingLocation(finding);
      const attention = finding.severity === "blocker" || finding.severity === "high" ? "Finding requires attention" : "";
      const reason = "reason" in finding ? finding.reason : "";
      const suggested = "suggested_check" in finding ? finding.suggested_check : undefined;
      const agreed = "reviewers_agreed" in finding && Array.isArray(finding.reviewers_agreed) ? finding.reviewers_agreed : [];
      return `<article class="finding">
        <div class="finding-head">
          <span class="sev sev-${escapeHtml(finding.severity)}"><span class="mark" aria-hidden="true">${sev.mark}</span> ${sev.text}</span>
          <span>· ${escapeHtml(finding.category || finding.role)}</span>
          ${agreed.length ? `<span class="muted">reviewers: ${escapeHtml(agreed.join(", "))}</span>` : ""}
        </div>
        ${loc ? `<p class="loc">${escapeHtml(loc)}</p>` : ""}
        <h3>${escapeHtml(finding.summary)}</h3>
        ${attention ? `<p><strong>${attention}</strong></p>` : ""}
        ${reason ? `<p>${escapeHtml(reason)}</p>` : ""}
        ${suggested ? `<p class="muted">Suggested check: ${escapeHtml(suggested)}</p>` : ""}
      </article>`;
    })
    .join("");
}
