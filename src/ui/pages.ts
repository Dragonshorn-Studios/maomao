import type { JobRow, JobStore, ReviewerRunRow } from "../jobs/store.js";
import type { FindingRow } from "../findings/types.js";
import { fingerprintFinding } from "../findings/identity.js";
import { POLICIES_WITH_EXTERNAL, POLICIES_WITH_INTERNAL } from "../routing/types.js";
import type { JobState } from "../config.js";
import { elapsedMs, escapeHtml, formatDuration, shortSha } from "../util.js";
import {
  diffUnavailableCopy,
  emptyQueueCopy,
  externalDispatchBadge,
  findingOverrideNote,
  findingStatusLabel,
  flavorForJob,
  internalEscalationBadge,
  jobStateLabel,
  observationsCopy,
  routingProfileLabel,
  runStateLabel,
  severityLabel,
  settledFindingsCopy,
  staleBanner,
  unconfirmedFindingsBanner,
  usageIncompleteCopy,
  usageReportedCopy,
} from "./copy.js";
import { roleGlyph } from "./glyphs.js";
import { csrfInput, layout, type PageOptions } from "./layout.js";
import {
  findingLocation,
  formatCost,
  formatTokens,
  formatUsageBreakdown,
  githubFileLink,
  jobMetrics,
  jobMetricsFromRuns,
  parseReviewerResult,
  type JobMetrics,
  type SeverityCounts,
} from "./metrics.js";

export type { PageOptions };

export type LoginError = "invalid" | "csrf" | "oauth-state" | "oauth-denied" | "oauth-failed" | "oauth-cancelled";

const LOGIN_ERRORS: Record<LoginError, string> = {
  invalid: "Invalid password.",
  csrf: "This form's security token was missing or expired. Go back and try again.",
  "oauth-state": "Sign-in could not be verified (the state was missing, expired, or replayed). Start again.",
  "oauth-denied":
    "Your GitHub account is not authorized to operate this Maomao instance. Ask an operator to add your GitHub user id, or sign out of GitHub and retry with a different account.",
  "oauth-failed": "GitHub sign-in failed. Try again shortly.",
  "oauth-cancelled": "GitHub sign-in was cancelled. You can try again.",
};

export interface LoginOptions {
  error?: LoginError;
  nextPath?: string;
  csrfToken?: string;
  showGithub?: boolean;
  showPassword?: boolean;
}

export function renderLogin(options: LoginOptions = {}): string {
  const { error, nextPath = "/", csrfToken, showGithub = false, showPassword = false } = options;
  const errorCopy = error ? LOGIN_ERRORS[error] : "";
  const githubButton = showGithub
    ? `<a class="button github-login" href="/login/github${
        nextPath !== "/" ? `?next=${encodeURIComponent(nextPath)}` : ""
      }">Sign in with GitHub</a>`
    : "";
  const passwordForm = showPassword
    ? `<form class="login" method="post" action="/login">
      ${csrfInput(csrfToken)}
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}"/>
      <label>
        Password
        <input type="password" name="password" autocomplete="current-password" autofocus required/>
      </label>
      <button type="submit">Sign in</button>
    </form>`
    : "";
  const body = `
    <h1>Sign in</h1>
    <p class="lede">Sign in to view jobs, logs, and APIs.</p>
    ${errorCopy ? `<p class="error" role="alert">${escapeHtml(errorCopy)}</p>` : ""}
    ${githubButton}
    ${githubButton && passwordForm ? `<p class="muted">or</p>` : ""}
    ${passwordForm}`;
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
      ${csrfInput(options.csrfToken)}
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
          ${job.aggregator_model ? `<div><code class="metric">${escapeHtml(job.aggregator_model)}</code>${job.aggregator_provider ? `<span class="muted"> · <code class="metric">${escapeHtml(job.aggregator_provider)}</code></span>` : ""}</div>` : ""}
          <div class="metric">${escapeHtml(aggregatorUsageCopy(job))}</div>
        </dd>
      </div>
      <div>
        <dt>Reconciliation</dt>
        <dd>${escapeHtml(reconciliationSummary(job))}</dd>
      </div>
      <div>
        <dt>Tokens / cost</dt>
        <dd class="metric">${escapeHtml(formatTokens(metrics.tokens))} · ${escapeHtml(formatCost(metrics.cost))}${
          metrics.usageComplete ? "" : " · incomplete"
        }
          ${usageBreakdownHtml(metrics)}
          ${metrics.usageComplete ? "" : `<div class="usage-incomplete">${escapeHtml(metrics.usageWarning || usageIncompleteCopy())}</div>`}
          <div class="muted usage-note">${escapeHtml(usageReportedCopy())}</div>
        </dd>
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
    ${renderRouting(job)}
    ${renderEscalation(job)}
    ${job.failure_reason ? `<p class="error" role="alert"><strong>Failure:</strong> ${escapeHtml(job.failure_reason)}</p>` : ""}
    <div class="section-head">
      <h2>Reviewers</h2>
      ${failedToRetry > 0 ? renderJobRetry(job.id, failedToRetry, options.csrfToken) : ""}
    </div>
    <p class="muted">${escapeHtml(progressCopy(metrics))}</p>
    <div class="cards">
      ${runs.map((run) => renderRun(run, canRetryRun(job, run), options.csrfToken)).join("")}
    </div>
    <h2>Aggregator</h2>
    ${renderAggregator(job, metrics)}
    <h2 id="findings">Findings</h2>
    ${renderFindings(metrics, options.prFindings ?? [], {
      prHeadSha: options.prHeadSha,
      prHtmlUrl: job.pr_html_url,
    })}
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
  const live: readonly JobState[] = [
    "preparing",
    "reconciling",
    "routing",
    "reviewing",
    "aggregating",
    "sniffing",
    "publishing",
  ];
  const isLive = live.includes(job.state);
  const flavor = flavorForJob(job.state, job.pr_number);
  return `<li>
    <article class="specimen${isLive ? " is-live" : ""}">
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
        <span class="pair">Tokens <strong class="metric">${escapeHtml(formatTokens(metrics.tokens))}${metrics.usageComplete ? "" : "+"}</strong></span>
        <span class="pair">Cost <strong class="metric">${escapeHtml(formatCost(metrics.cost))}</strong></span>
      </div>
      ${renderDiagnosis(metrics, job.aggregator_state)}
      ${renderSeverityChips(metrics.findings, !metrics.findingsConfirmed)}
    </article>
  </li>`;
}

function renderRouting(job: JobRow): string {
  if (!job.routing_profile && job.routing_state !== "running") return "";
  const signals = safeParseSignals(job.routing_signals);
  const reviewers = safeParseStringArray(job.routing_reviewers);
  const families = signals?.hardRiskFamilies?.length
    ? signals.hardRiskFamilies.join(", ")
    : signals?.families?.length
      ? signals.families.join(", ")
      : "none";
  return `<h2>Routing</h2>
    <article class="card">
      <header>
        <span class="role"><strong>Profile</strong> ${escapeHtml(routingProfileLabel(job.routing_profile))}</span>
        ${job.routing_source ? `<span class="muted">source ${escapeHtml(job.routing_source)}</span>` : ""}
      </header>
      <p>${escapeHtml(job.routing_reason || "Selecting specialists for this SHA.")}</p>
      <p class="muted">
        confidence ${job.routing_confidence != null ? escapeHtml(String(job.routing_confidence)) : "—"}
        · reviewers ${escapeHtml(reviewers.join(", ") || "pending")}
        · signals ${escapeHtml(families)}
        ${job.routing_model ? ` · router <code class="metric">${escapeHtml(job.routing_model)}</code>` : ""}
        ${job.routing_cost != null ? ` · router cost ${escapeHtml(formatCost(job.routing_cost))}` : ""}
        ${job.routing_total_tokens != null ? ` · router tokens ${escapeHtml(formatTokens(job.routing_total_tokens))}` : ""}
      </p>
    </article>`;
}

function renderEscalation(job: JobRow): string {
  // The pipeline persists poison_alert_policy only once work starts, so an absent policy is
  // rendered as "pending" (a live poison-alert job has not reached its escalation plan yet).
  const policy = job.poison_alert_policy || "";
  const manual = Boolean(job.manual_escalate_requested);
  const internalState = job.internal_escalation_state;
  const externalStatus = job.external_dispatch_status;
  const internalObserved = Boolean(internalState && internalState !== "not_requested");
  const externalObserved = Boolean(externalStatus && externalStatus !== "not_requested");
  const show =
    Boolean(policy) || job.routing_profile === "poison-alert" || manual || internalObserved || externalObserved;
  if (!show) return "";

  const internalRequested =
    (POLICIES_WITH_INTERNAL as readonly string[]).includes(policy) || internalObserved;
  const externalRequested =
    (POLICIES_WITH_EXTERNAL as readonly string[]).includes(policy) ||
    (policy === "manual" && manual) ||
    (!policy && manual) ||
    externalObserved;

  const plan = internalRequested && externalRequested
    ? "laboratory re-check, then external dispatch"
    : internalRequested
      ? "laboratory re-check only"
      : externalRequested
        ? "external dispatch only"
        : policy === "manual" || (!policy && !internalObserved && !externalObserved)
          ? "waiting for a manual @maomao escalate"
          : "escalation pending";

  const channels: string[] = [];
  if (internalRequested) {
    const badge = internalEscalationBadge(internalState);
    const ran = internalState === "done" || internalState === "failed";
    channels.push(`<h3>Internal model</h3>
      <p>${renderState(badge.stateClass, badge.text, badge.hint, badge.mark)}
        ${job.internal_escalation_model ? ` <code class="metric">${escapeHtml(job.internal_escalation_model)}</code>` : ""}
        ${job.internal_escalation_provider ? `<span class="muted"> · <code class="metric">${escapeHtml(job.internal_escalation_provider)}</code></span>` : ""}
      </p>
      ${
        ran
          ? `<p class="muted">${escapeHtml(formatTokens(job.internal_escalation_total_tokens))} tokens · ${escapeHtml(formatCost(job.internal_escalation_cost))}</p>`
          : ""
      }
      ${job.internal_escalation_reason ? `<p>${escapeHtml(job.internal_escalation_reason)}</p>` : ""}`);
  }
  if (externalRequested) {
    const decided = Boolean(job.external_dispatch_reason);
    const badge = externalDispatchBadge(externalStatus, decided);
    const targets = safeParseTargets(job.external_dispatch_targets);
    const targetText = targets
      .map((target) => {
        if (target.type === "mention") return `mention ${target.recipient}`;
        if (target.type === "command") return `command ${target.recipient} ${target.command}`;
        return `webhook ${target.urlSecretRef}`;
      })
      .join("; ");
    channels.push(`<h3>External dispatch</h3>
      <p>${renderState(badge.stateClass, badge.text, badge.hint, badge.mark)}
        ${externalObserved ? `<span class="muted">${targetText ? ` · ${escapeHtml(targetText)}` : ""}</span>` : ""}
      </p>
      ${job.external_dispatch_reason ? `<p>${escapeHtml(job.external_dispatch_reason)}</p>` : ""}
      ${job.external_dispatch_error ? `<p class="error">${escapeHtml(job.external_dispatch_error)}</p>` : ""}
      <p class="muted">Fire-and-forget: Maomao records only the immediate notification outcome, not whether an external reviewer finished.</p>`);
  }

  const policyLabel = policy || "pending";
  return `<h2>Poison alert</h2>
    <article class="card">
      <p><strong>Policy</strong> ${escapeHtml(policyLabel)} — ${escapeHtml(plan)}${manual ? " · <strong>manual escalate requested</strong>" : ""}</p>
      ${channels.join("\n")}
    </article>`;
}

function safeParseSignals(raw: string | null): { families?: string[]; hardRiskFamilies?: string[] } | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as { families?: string[]; hardRiskFamilies?: string[] };
  } catch {
    return undefined;
  }
}

function reconciliationSummary(job: JobRow): string {
  if (job.state === "reconciling") return "Checking prior findings against this SHA";
  if (!job.reconciliation_json) return "—";
  try {
    const snapshot = JSON.parse(job.reconciliation_json) as { items?: Array<{ status?: string }> };
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    if (items.length === 0) return "No prior findings";
    const buried = items.filter((item) => item.status === "dismissed").length;
    const resolved = items.filter((item) => item.status === "resolved").length;
    const remaining = items.length - buried - resolved;
    const parts = [`${items.length} prior`];
    if (resolved) parts.push(`${resolved} resolved`);
    if (buried) parts.push(`${buried} buried`);
    if (remaining) parts.push(`${remaining} still current`);
    return parts.join(" · ");
  } catch {
    return "—";
  }
}

function safeParseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function safeParseTargets(raw: string | null): Array<{
  type: string;
  recipient?: string;
  command?: string;
  urlSecretRef?: string;
}> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<{ type: string; recipient?: string; command?: string; urlSecretRef?: string }>) : [];
  } catch {
    return [];
  }
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
    <span class="muted">${escapeHtml(observationsCopy(metrics.findings.total, !metrics.findingsConfirmed))}</span>
  </div>`;
}

function renderSeverityChips(counts: SeverityCounts, unconfirmed = false): string {
  if (counts.total === 0) return `<div class="meta-row"><span class="muted">No suspicious findings</span></div>`;
  const keys = ["blocker", "high", "medium", "low", "info"] as const;
  const chips = keys
    .filter((key) => counts[key] > 0)
    .map((key) => {
      const label = severityLabel(key);
      return `<span class="sev sev-${key}"><span class="mark" aria-hidden="true">${label.mark}</span> ${label.text} ${counts[key]}</span>`;
    })
    .join(" ");
  const mark = unconfirmed
    ? `<span class="unconfirmed" title="Specialist observations not yet validated by the aggregator">Unconfirmed</span> `
    : "";
  return `<div class="meta-row${unconfirmed ? " is-unconfirmed" : ""}" aria-label="${unconfirmed ? "Unconfirmed findings by severity" : "Findings by severity"}">${mark}${chips}</div>`;
}

function renderState(stateClass: string, text: string, hint: string, mark: string): string {
  return `<span class="state state-${escapeHtml(stateClass)}" title="${escapeHtml(hint)}"><span class="mark" aria-hidden="true">${escapeHtml(mark)}</span> ${escapeHtml(text)}</span>`;
}

function aggregatorUsageCopy(job: JobRow): string {
  const tokens = tokenTotalFromAggregator(job);
  const incomplete = job.aggregator_usage_complete === 0 ? " · incomplete" : "";
  return `${formatTokens(tokens)} tokens · ${formatCost(job.aggregator_cost)}${incomplete}`;
}

function tokenTotalFromAggregator(job: JobRow): number {
  if (job.aggregator_total_tokens != null) return job.aggregator_total_tokens;
  return (job.aggregator_prompt_tokens ?? 0) + (job.aggregator_completion_tokens ?? 0);
}

function usageBreakdownHtml(metrics: JobMetrics): string {
  const breakdown = formatUsageBreakdown(metrics);
  return breakdown ? `<div class="usage-breakdown">${escapeHtml(breakdown)}</div>` : "";
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

function renderJobRetry(jobId: number, count: number, csrfToken?: string): string {
  const label = count === 1 ? "Retry failed reviewer" : `Retry ${count} failed reviewers`;
  return `<form class="retry-job" method="post" action="/jobs/${jobId}/retry">
    ${csrfInput(csrfToken)}
    <button type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function renderRun(run: ReviewerRunRow, showRetry = false, csrfToken?: string): string {
  const parsed = parseReviewerResult(run.normalized_json);
  const findingCount = parsed?.findings.length ?? 0;
  const state = runStateLabel(run.state);
  const tokenCount =
    run.total_tokens ??
    (run.prompt_tokens ?? 0) +
      (run.completion_tokens ?? 0) +
      (run.reasoning_tokens ?? 0) +
      (run.cache_read_tokens ?? 0) +
      (run.cache_write_tokens ?? 0);
  const tokens = tokenCount > 0 ? `${formatTokens(tokenCount)} tokens${run.usage_complete === 0 ? "+" : ""}` : null;
  const breakdown = formatUsageBreakdown({
    promptTokens: run.prompt_tokens ?? 0,
    completionTokens: run.completion_tokens ?? 0,
    reasoningTokens: run.reasoning_tokens ?? 0,
    cacheReadTokens: run.cache_read_tokens ?? 0,
    cacheWriteTokens: run.cache_write_tokens ?? 0,
  });
  return `<article class="card">
    <header>
      <span class="role">${roleGlyph(run.role)} <strong>${escapeHtml(run.title || run.role)}</strong> <span class="muted">(${escapeHtml(run.role)})</span></span>
      ${renderState(run.state, state.text, state.hint, state.mark)}
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
    ${breakdown ? `<p class="muted usage-breakdown">${escapeHtml(breakdown)}</p>` : ""}
    ${run.usage_complete === 0 ? `<p class="usage-incomplete">${escapeHtml(run.usage_warning || usageIncompleteCopy())}</p>` : ""}
    ${run.validation_error ? `<p class="error" role="alert"><strong>Validation error:</strong> ${escapeHtml(run.validation_error)}</p>` : ""}
    ${
      showRetry
        ? `<form class="retry" method="post" action="/jobs/${run.job_id}/reviewers/${run.id}/retry">
             ${csrfInput(csrfToken)}
             <button type="submit">Retry</button>
           </form>`
        : ""
    }
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
      · <span class="metric">${escapeHtml(aggregatorUsageCopy(job))}</span>
    </p>
    <p><strong>${escapeHtml(heading)}</strong></p>
    ${agg?.summary ? `<pre class="log-panel">${escapeHtml(agg.summary)}</pre>` : job.aggregator_normalized || job.aggregator_raw ? "" : `<p class="muted">(pending)</p>`}
    ${job.aggregator_normalized ? `<details><summary>Normalized JSON</summary><pre class="log-panel">${escapeHtml(job.aggregator_normalized)}</pre></details>` : ""}
    ${job.aggregator_raw ? `<details><summary>Raw output</summary><pre class="log-panel">${escapeHtml(job.aggregator_raw)}</pre></details>` : ""}
  </article>`;
}

function renderFindings(
  metrics: JobMetrics,
  persisted: FindingRow[] = [],
  context: { prHeadSha?: string; prHtmlUrl?: string } = {},
): string {
  const unconfirmed = !metrics.findingsConfirmed;
  const items = metrics.findingsConfirmed
    ? (metrics.aggregator?.findings ?? []).map((finding) => ({
        ...finding,
        role: finding.category,
        reason: finding.body ?? "",
      }))
    : metrics.specialistFindings.map((finding) => ({ ...finding, reason: finding.reason }));

  const byFingerprint = new Map(persisted.map((row) => [row.fingerprint, row]));
  const seen = new Set<string>();
  const active: string[] = [];
  const settled: string[] = [];

  const pushCard = (
    cardInput: Parameters<typeof renderFindingCard>[0],
  ) => {
    const settledRow = cardInput.record?.status === "dismissed" || cardInput.record?.status === "resolved";
    (settledRow ? settled : active).push(renderFindingCard(cardInput, context, settledRow));
  };

  for (const finding of items) {
    const fingerprint = fingerprintFinding(finding);
    const record = byFingerprint.get(fingerprint);
    if (record) seen.add(fingerprint);
    pushCard({
      severity: finding.severity,
      category: finding.category || finding.role,
      file: finding.file,
      line: finding.line,
      summary: finding.summary,
      reason: "reason" in finding ? finding.reason : "",
      suggested: "suggested_check" in finding ? finding.suggested_check : undefined,
      agreed:
        "reviewers_agreed" in finding && Array.isArray(finding.reviewers_agreed) ? finding.reviewers_agreed : [],
      unconfirmed,
      record,
    });
  }

  for (const row of persisted) {
    if (seen.has(row.fingerprint)) continue;
    pushCard({
      severity: row.severity || "info",
      category: row.category || "",
      file: row.current_path ?? row.original_path ?? undefined,
      line: row.current_line ?? row.original_line ?? undefined,
      summary: row.summary || row.fingerprint,
      reason: row.body ?? "",
      unconfirmed: false,
      record: row,
    });
  }

  if (active.length === 0 && settled.length === 0) {
    return `<p class="muted">${metrics.aggregator?.verdict === "clean" ? "No suspicious findings" : "No normalized findings yet."}</p>`;
  }

  const banner = unconfirmed
    ? `<p class="findings-provisional" role="status">${escapeHtml(unconfirmedFindingsBanner())}</p>`
    : "";
  const buriedCount = persisted.filter((row) => row.status === "dismissed").length;
  const resolvedCount = persisted.filter((row) => row.status === "resolved").length;
  const settledBlock =
    settled.length === 0
      ? ""
      : `<p class="muted settled-findings-label">${escapeHtml(settledFindingsCopy(buriedCount, resolvedCount))}</p>${settled.join("")}`;
  return banner + active.join("") + settledBlock;
}

function renderFindingCard(
  input: {
    severity: string;
    category: string;
    file?: string;
    line?: number | null;
    summary: string;
    reason: string;
    suggested?: string;
    agreed?: string[];
    unconfirmed: boolean;
    record?: FindingRow;
  },
  context: { prHeadSha?: string; prHtmlUrl?: string } = {},
  collapsed = false,
): string {
  const sev = severityLabel(input.severity);
  const loc = findingLocation({ file: input.file, line: input.line ?? undefined });
  const record = input.record;
  const status = record && record.status !== "open" ? findingStatusLabel(record.status) : undefined;
  const override = record ? findingOverrideNote(record) : undefined;
  const buried = record?.status === "dismissed";
  const resolved = record?.status === "resolved";
  const stale = Boolean(
    record?.reviewed_sha && context.prHeadSha && record.reviewed_sha !== context.prHeadSha,
  );
  const permalink = githubFileLink(
    context.prHtmlUrl,
    record?.reviewed_sha,
    input.file ?? "",
    input.line ?? null,
  );
  const attention =
    !buried && !resolved && (input.severity === "blocker" || input.severity === "high")
      ? "Finding requires attention"
      : "";
  const classes = [
    "finding",
    input.unconfirmed ? "is-unconfirmed" : "",
    buried ? "is-buried" : "",
    resolved ? "is-resolved" : "",
    collapsed ? "is-collapsed" : "",
    stale ? "is-stale-sha" : "",
    record && record.status !== "open" ? `finding-status-${escapeHtml(record.status)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const statusBadge = status
    ? `<span class="finding-status finding-status-${escapeHtml(record!.status)}" title="${escapeHtml(status.hint)}">${escapeHtml(status.text)}</span>`
    : "";
  const staleBadge = stale
    ? `<span class="stale-sha" title="Reviewed at ${escapeHtml(record!.reviewed_sha)}; a newer head SHA exists for this pull request.">Older SHA</span>`
    : "";
  const locLink = permalink
    ? ` <a class="loc-link" href="${escapeHtml(permalink)}" title="Open this file at the exact reviewed revision on GitHub">view at this SHA</a>`
    : "";
  const diffBlock = renderFindingDiff(record);
  const body = `
        ${override ? `<p class="finding-override" role="status"><strong>${escapeHtml(override)}</strong></p>` : ""}
        ${attention ? `<p><strong>${attention}</strong></p>` : ""}
        ${input.reason ? `<p>${escapeHtml(input.reason)}</p>` : ""}
        ${input.suggested ? `<p class="muted">Suggested check: ${escapeHtml(input.suggested)}</p>` : ""}
        ${input.agreed?.length ? `<p class="muted">reviewers: ${escapeHtml(input.agreed.join(", "))}</p>` : ""}
        ${diffBlock}`;
  if (collapsed) {
    return `<details class="${classes}">
        <summary>
          ${statusBadge}
          ${staleBadge}
          <span class="sev sev-${escapeHtml(input.severity)}"><span class="mark" aria-hidden="true">${sev.mark}</span> ${sev.text}</span>
          ${loc ? `<span class="loc">${escapeHtml(loc)}</span>` : ""}
          <span class="finding-title">${escapeHtml(input.summary)}</span>
        </summary>
        ${input.category ? `<p class="muted">${escapeHtml(input.category)}</p>` : ""}
        ${body}
      </details>`;
  }
  return `<article class="${classes}">
        <div class="finding-head">
          <span class="sev sev-${escapeHtml(input.severity)}"><span class="mark" aria-hidden="true">${sev.mark}</span> ${sev.text}</span>
          ${statusBadge}
          ${staleBadge}
          ${input.unconfirmed ? `<span class="unconfirmed">Unconfirmed</span>` : ""}
          ${input.category ? `<span>· ${escapeHtml(input.category)}</span>` : ""}
          ${input.agreed?.length ? `<span class="muted">reviewers: ${escapeHtml(input.agreed.join(", "))}</span>` : ""}
        </div>
        ${loc ? `<p class="loc">${escapeHtml(loc)}${locLink}</p>` : ""}
        <h3>${escapeHtml(input.summary)}</h3>
        ${body}
      </article>`;
}

function renderFindingDiff(record?: FindingRow): string {
  if (!record) return "";
  const note = diffUnavailableCopy(record.diff_note);
  if (!record.diff_hunk) {
    return note ? `<p class="muted diff-note">${escapeHtml(note)}</p>` : "";
  }
  const lines = record.diff_hunk
    .split("\n")
    .map((line) => {
      const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
      return `<span class="diff-${cls}">${escapeHtml(line)}</span>`;
    })
    .join("\n");
  return `<details class="finding-diff">
      <summary>Show diff</summary>
      <pre class="diff-panel" aria-label="Diff hunk from the reviewed revision">${lines}</pre>
      ${note ? `<p class="muted diff-note">${escapeHtml(note)}</p>` : ""}
    </details>`;
}
