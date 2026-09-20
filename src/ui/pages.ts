import type { JobRow, JobStore, ReviewerRunRow } from "../jobs/store.js";
import { forgeBadgeTitle, forgeBadgeTitleHtml, forgeChipLabel } from "./forge-badge.js";
import type { FindingRow } from "../findings/types.js";
import { fingerprintFinding, stripHtmlComments } from "../findings/identity.js";
import { POLICIES_WITH_EXTERNAL, POLICIES_WITH_INTERNAL } from "../routing/types.js";
import { LIVE_JOB_STATES } from "../config.js";
import type { ProfileFieldErrors, ProfileFormValues } from "../config-form.js";
import { initialProfileFormValues, profileFormValuesFromDefinition } from "../config-form.js";
import type { EffectiveConfigEntry } from "../config-effective.js";
import type { Severity } from "../schema.js";
import { elapsedMs, escapeHtml, formatDuration, shortSha } from "../util.js";
import {
  cancelledBannerCopy,
  diffUnavailableCopy,
  emptyQueueCopy,
  huntersReturnedCopy,
  type UiFlavor,
  externalDispatchBadge,
  findingOverrideNote,
  findingStatusLabel,
  flavorForJob,
  internalEscalationBadge,
  jobStateLabel,
  observationsCopy,
  reviewerFlavor,
  roleFlavorHint,
  routingProfileLabel,
  runStateLabel,
  severityLabel,
  settledFindingsCopy,
  staleBanner,
  unconfirmedFindingsBanner,
  usageIncompleteCopy,
  usageReportedCopy,
} from "./copy.js";
import { pancakeMark, roleGlyph } from "./glyphs.js";
import { TYPEAHEAD_HREF } from "./typeahead.js";
import { csrfInput, layout, type PageOptions, type UiIdentity } from "./layout.js";
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
    .map((job) => renderQueueCard(job, jobMetrics(job, store), options.uiFlavor, options.csrfToken))
    .join("");
  const paginationNav = renderJobsPagination(jobs, options.pagination, options.activeForge);
  const pancakeChip = pancakeChipFor(store, options.uiFlavor);
  // data-forge is scaffolding for future client-side filtering; nothing
  // consumes it yet. An explicit All chip clears the active filter.
  const allChip = options.activeForge
    ? `<a class="top-link" href="/">All forges</a>`
    : "";
  const forgeChips = (options.forgeScopes ?? [])
    .map((scope) => {
      const key = `${scope.provider}:${scope.instance}`;
      const active = options.activeForge === key;
      return `<a class="top-link" data-forge="${escapeHtml(key)}" href="/?forge=${encodeURIComponent(key)}" ${active ? 'aria-current="true"' : ""}>${escapeHtml(forgeChipLabel({ provider: scope.provider, provider_instance: scope.instance }))}</a>`;
    })
    .join("\n      ");
  const forgeNav = options.forgeScopes && options.forgeScopes.length > 1 ? `${allChip}${forgeChips}` : "";

  const body = `
    <h1>Review jobs</h1>
    <p class="lede">Recent pull request reviews. Each job is anchored to an exact head SHA.${pancakeChip ? ` ${pancakeChip}` : ""}</p>
    ${forgeNav ? `<div class="meta-row" role="navigation" aria-label="Filter by forge">${forgeNav}</div>` : ""}
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
    }
    ${paginationNav}`;
  return layout("Maomao", body, options);
}

/**
 * Pancake easter egg chip for the home page: one pancake per completed
 * review job, apothecary flavor only. Empty at zero completions so the
 * page stays quiet until maomao has actually earned a treat. The chip
 * carries `data-pancake-latest` for the client-side animation trigger.
 */
function pancakeChipFor(store: JobStore, flavor?: UiFlavor): string {
  if ((flavor ?? "apothecary") !== "apothecary") return "";
  const { count, latestId } = store.pancakeStats();
  if (count === 0) return "";
  const label = count === 1 ? "1 pancake earned" : `${count} pancakes earned`;
  return `<span class="pancake-chip" data-pancake-latest="${latestId}" title="Maomao earns a pancake for every completed review">${pancakeMark()} ${label}</span>`;
}

/**
 * Keyset navigation over the home queue. Cursors come from the page's
 * boundary job ids, so links stay stable while new jobs are queued.
 * rel=next/prev follow reading order down the newest-first list, so "next"
 * is older. Renders nothing when the caller did not opt into pagination.
 */
function renderJobsPagination(
  jobs: JobRow[],
  pagination?: { hasOlder: boolean; hasNewer: boolean },
  forgeKey?: string,
): string {
  const forgeParam = forgeKey ? `&forge=${encodeURIComponent(forgeKey)}` : "";
  if (!pagination) return "";
  const oldest = jobs[jobs.length - 1];
  const newest = jobs[0];
  const nextLink =
    pagination.hasOlder && oldest
      ? `<a rel="next" href="/?before=${oldest.id}${forgeParam}">Older jobs</a>`
      : `<span class="muted" aria-disabled="true">Older jobs</span>`;
  const prevLink =
    pagination.hasNewer && newest
      ? `<a rel="prev" href="/?after=${newest.id}${forgeParam}">Newer jobs</a>`
      : `<span class="muted" aria-disabled="true">Newer jobs</span>`;
  const olderNote = pagination.hasNewer
    ? `<p class="jobs-pagination-note" role="status">Viewing older jobs — <a href="${forgeKey ? `/?forge=${encodeURIComponent(forgeKey)}` : "/"}">newest reviews are on the first page</a>.</p>`
    : "";
  return `<nav class="jobs-pagination" aria-label="Review jobs pages">
      ${olderNote}
      ${prevLink}
      ${nextLink}
    </nav>`;
}

export type JobPageOptions = PageOptions & {
  scanIssueCreation?: ScanIssueCreationData;
  /** Provenance rows for a health-scan job (fingerprints → GitHub issues). */
  scanIssues?: Array<{ fingerprint: string; issue_number: number; issue_url: string; title: string }>;
};

function renderScanIssuesAudit(rows: NonNullable<JobPageOptions["scanIssues"]>): string {
  const items = rows
    .map(
      (row) => `<li>${
        row.issue_number === 0
          ? `<span class="muted">pending claim</span>`
          : `<a href="${escapeHtml(row.issue_url)}">#${row.issue_number}</a>`
      } — <code>${escapeHtml(row.fingerprint)}</code> ${escapeHtml(row.title)}</li>`,
    )
    .join("");
  return `<h2>GitHub issues from this scan</h2>
    <ul class="logs" aria-label="GitHub issues created from this scan">${items}</ul>
    <p class="muted">Fingerprints are stable per finding, so rescans and retries reuse these links instead of creating duplicates.</p>`;
}

export function renderJob(
  job: JobRow,
  runs: ReviewerRunRow[],
  logs: { created_at: string; level: string; message: string }[],
  options: JobPageOptions = {},
): string {
  const metrics = jobMetricsFromRuns(job, runs);
  const state = jobStateLabel(job.state);
  const flavor = flavorForJob(job.state, job.pr_number, options.uiFlavor);
  const elapsed = formatDuration(elapsedMs(job.started_at, job.finished_at) ?? elapsedMs(job.created_at));
  const stale = job.state === "stale";
  const failedToRetry = retryableFailedCount(job, runs);
  const isScan = job.job_type === "health_scan";
  const heading = isScan
    ? `Health scan · ${escapeHtml(job.repo_full_name)} @ ${escapeHtml(shortSha(job.head_sha, 12))}`
    : `${forgeBadgeTitleHtml(job, job.repo_full_name, job.pr_number)}`;
  const cancelledBanner =
    job.state === "cancelled"
      ? renderCancelledBanner(job)
      : "";
  const jobActions = renderJobActions(job, options.csrfToken);
  const body = `
    <p class="crumb"><a href="/">Jobs</a> / job ${job.id}</p>
    ${options.notice ? `<p class="notice" role="status">${escapeHtml(options.notice)}</p>` : ""}
    ${options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : ""}
    ${cancelledBanner}
    ${stale ? `<p class="warn" role="status">${escapeHtml(staleBanner())}</p>` : ""}
    <h1>${heading}</h1>
    <p class="lede">${escapeHtml(job.pr_title || "")}${flavor ? ` · ${escapeHtml(flavor)}` : ""}</p>
    ${jobActions}
    ${
      job.state === "completed"
        ? `<p class="muted">${escapeHtml(huntersReturnedCopy(metrics.reviewersDone, metrics.findings.total, options.uiFlavor))}</p>`
        : ""
    }
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
          ${job.budget_exceeded_warning ? `<div class="usage-incomplete" role="alert">Profile budget exceeded — ${escapeHtml(job.budget_exceeded_warning)}</div>` : ""}
          <div class="muted usage-note">${escapeHtml(usageReportedCopy())}</div>
        </dd>
      </div>
      <div>
        <dt>GitHub review</dt>
        <dd>${
          job.github_review_url
            ? `<a href="${escapeHtml(job.github_review_url)}">${escapeHtml(job.github_review_id || "view review")}</a>`
            : job.state === "completed"
              ? "not published"
              : "—"
        }
          ${
            job.review_event
              ? `<div class="muted" title="${escapeHtml(job.review_event_reason || "")}">Event: <code class="metric">${escapeHtml(job.review_event)}</code>${job.review_event_reason ? ` — ${escapeHtml(job.review_event_reason)}` : ""}</div>`
              : ""
          }
        </dd>
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
      ${runs.map((run) => renderRun(run, canRetryRun(job, run), options.csrfToken, options.uiFlavor)).join("")}
    </div>
    <h2>Aggregator</h2>
    ${renderAggregator(job, metrics)}
    <h2 id="findings">Findings</h2>
    ${renderFindings(metrics, options.prFindings ?? [], {
      prHeadSha: options.prHeadSha,
      prHtmlUrl: job.pr_html_url,
    })}
    ${options.scanIssueCreation ? renderScanIssueCreation(options.scanIssueCreation, options.csrfToken) : ""}
    ${options.scanIssues?.length ? renderScanIssuesAudit(options.scanIssues) : ""}
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
  return layout(
    isScan ? `Health scan · ${job.repo_full_name}` : forgeBadgeTitle(job, job.repo_full_name, job.pr_number),
    body,
    options,
  );
}

function renderCancelledBanner(job: JobRow): string {
  const banner = cancelledBannerCopy(job);
  const link = banner.link
    ? ` <a href="${escapeHtml(banner.link.href)}">${escapeHtml(banner.link.label)}</a>`
    : "";
  return `<p class="warn" role="status">${escapeHtml(banner.text)}${link}</p>`;
}

/** Single home for the dequeue form markup (job page + queue card).
 * The `dequeue` class carries the small-outline button styling (theme.ts). */
function dequeueForm(jobId: number, csrfToken?: string, hint?: string): string {
  return `<form class="dequeue" method="post" action="/jobs/${jobId}/dequeue">
      ${csrfInput(csrfToken)}
      <button type="submit">Dequeue</button>
      ${hint ? `<span class="muted">${escapeHtml(hint)}</span>` : ""}
    </form>`;
}

/** Single home for the cancel entry point. Deliberately an anchor, not a
 * form: it leads to the confirmation page, so the destructive POST stays
 * gated behind it. The `cancel-review` class carries the button styling. */
function cancelReviewLink(jobId: number): string {
  return `<a class="cancel-review" href="/jobs/${jobId}/cancel">Cancel review</a>`;
}

function renderJobActions(job: JobRow, csrfToken?: string): string {
  if (job.state === "queued") {
    // Health scans are started from /scan, not the queue form; the generic dequeue still applies.
    const hint =
      job.job_type === "pr_review"
        ? "Removes this review from the queue. History is kept; nothing is posted to GitHub."
        : undefined;
    return dequeueForm(job.id, csrfToken, hint);
  }
  if (LIVE_JOB_STATES.includes(job.state)) {
    return `<p>${cancelReviewLink(job.id)} <span class="muted">Opens a confirmation; confirming stops this review — it will not be completed. Logs and partial output stay on the job page.</span></p>`;
  }
  return "";
}

function renderQueueCard(job: JobRow, metrics: JobMetrics, uiFlavor?: UiFlavor, csrfToken?: string): string {
  const state = jobStateLabel(job.state);
  const elapsed = formatDuration(elapsedMs(job.started_at, job.finished_at) ?? elapsedMs(job.created_at));
  const isLive = LIVE_JOB_STATES.includes(job.state);
  const flavor = flavorForJob(job.state, job.pr_number, uiFlavor);
  let cardAction = "";
  if (job.state === "queued") {
    cardAction = dequeueForm(job.id, csrfToken);
  } else if (isLive) {
    cardAction = cancelReviewLink(job.id);
  }
  return `<li>
    <article class="specimen${isLive ? " is-live" : ""}">
      <div class="specimen-head">
        <span class="specimen-id">Specimen · job ${job.id}</span>
        ${renderState(job.state, state.text, state.hint, state.mark)}
      </div>
      <p class="specimen-title"><a href="/jobs/${job.id}">${forgeBadgeTitleHtml(job, job.repo_full_name, job.pr_number)} · ${escapeHtml(job.pr_title || "(no title)")}</a></p>
      ${flavor ? `<p class="muted">${escapeHtml(flavor)}</p>` : ""}
      <div class="meta-row">
        <span class="pair">SHA <strong><code class="sha">${escapeHtml(shortSha(job.head_sha, 10))}</code></strong></span>
        <span class="pair">Elapsed <strong class="metric">${escapeHtml(elapsed)}</strong></span>
        <span class="pair">Model <strong><code class="metric">${escapeHtml(metrics.model || "—")}</code></strong></span>
        ${metrics.provider ? `<span class="pair">Provider <strong><code class="metric">${escapeHtml(metrics.provider)}</code></strong></span>` : ""}
        <span class="pair">Tokens <strong class="metric">${escapeHtml(formatTokens(metrics.tokens))}${metrics.usageComplete ? "" : "+"}</strong></span>
        <span class="pair">Cost <strong class="metric">${escapeHtml(formatCost(metrics.cost))}</strong></span>
        ${cardAction}
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

function renderRun(
  run: ReviewerRunRow,
  showRetry = false,
  csrfToken?: string,
  uiFlavor?: UiFlavor,
): string {
  const parsed = parseReviewerResult(run.normalized_json);
  const findingCount = parsed?.findings.length ?? 0;
  const state = runStateLabel(run.state);
  const hunt = reviewerFlavor(run.state, findingCount, uiFlavor);
  const hint = roleFlavorHint(run.role, uiFlavor);
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
      <span class="role"${hint ? ` title="${escapeHtml(hint)}"` : ""}>${roleGlyph(run.role)} <strong>${escapeHtml(run.title || run.role)}</strong> <span class="muted">(${escapeHtml(run.role)})</span></span>
      ${renderState(run.state, state.text, state.hint, state.mark)}
    </header>
    ${hunt ? `<p class="muted">${escapeHtml(hunt)}</p>` : ""}
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
  // Hidden `<!-- maomao-finding … -->` markers (and any other HTML comments) are
  // provenance, never content — strip them (plus the `**sev**:` prefix that old
  // thread-derived summaries carried) and surface the marker info as a small
  // note at the bottom of the card instead.
  const displaySummary =
    stripHtmlComments(input.summary)
      .replace(/\*\*[^*]+\*\*:\s*/g, "")
      .trim() ||
    input.summary.trim() ||
    "Prior finding";
  const displayReason = input.reason ? stripHtmlComments(input.reason) : "";
  const markerNote = record
    ? `<p class="muted finding-marker">Maomao finding <code>${escapeHtml(record.fingerprint)}</code> · reported at <code>${escapeHtml(shortSha(record.reviewed_sha, 12))}</code></p>`
    : "";
  const body = `
        ${override ? `<p class="finding-override" role="status"><strong>${escapeHtml(override)}</strong></p>` : ""}
        ${attention ? `<p><strong>${attention}</strong></p>` : ""}
        ${displayReason ? `<p>${escapeHtml(displayReason)}</p>` : ""}
        ${input.suggested ? `<p class="muted">Suggested check: ${escapeHtml(input.suggested)}</p>` : ""}
        ${input.agreed?.length ? `<p class="muted">reviewers: ${escapeHtml(input.agreed.join(", "))}</p>` : ""}
        ${record?.confidence != null ? `<p class="muted">Aggregator confidence: ${Math.round(record.confidence * 100)}%</p>` : ""}
        ${diffBlock}
        ${markerNote}`;
  if (collapsed) {
    return `<details class="${classes}">
        <summary>
          ${statusBadge}
          ${staleBadge}
          <span class="sev sev-${escapeHtml(input.severity)}"><span class="mark" aria-hidden="true">${sev.mark}</span> ${sev.text}</span>
          ${loc ? `<span class="loc">${escapeHtml(loc)}</span>` : ""}
          <span class="finding-title">${escapeHtml(displaySummary)}</span>
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
        <h3>${escapeHtml(displaySummary)}</h3>
        ${body}
      </article>`;
}

function renderFindingDiff(record?: FindingRow): string {
  if (!record) return "";
  const note = diffUnavailableCopy(record.diff_note);
  if (!record.diff_hunk) {
    return note ? `<p class="muted diff-note">${escapeHtml(note)}</p>` : "";
  }
  // Two layers: the server-rendered spans are the no-JS fallback;
  // /assets/vendor/pierre-diffs.js upgrades the container to a @pierre/diffs
  // viewer (syntax highlighting, unified/split toggle, line annotation) using
  // the raw hunk embedded in the non-executing script tag below.
  const lines = record.diff_hunk
    .split("\n")
    .map((line) => {
      const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
      return `<span class="diff-${cls}">${escapeHtml(line)}</span>`;
    })
    .join("\n");
  // Only new-file numbering can anchor a line annotation; original_line is
  // old-file numbering and would mark an unrelated row.
  const line = record.current_line;
  return `<details class="finding-diff">
      <summary>Show diff</summary>
      <div class="pierre-diff" data-pierre-diff data-path="${escapeHtml(record.current_path ?? record.original_path ?? "")}" data-line="${line ?? ""}" data-severity="${escapeHtml(record.severity ?? "info")}" data-summary="${escapeHtml((record.summary ?? "").slice(0, 160))}">
        <pre class="diff-panel" aria-label="Diff hunk from the reviewed revision">${lines}</pre>
        <script type="text/plain" class="diff-raw">${escapeHtml(record.diff_hunk)}</script>
      </div>
      ${note ? `<p class="muted diff-note">${escapeHtml(note)}</p>` : ""}
    </details>`;
}

export interface ConfigRevisionView {
  id: number;
  name: string;
  status: string;
  definition: unknown;
  note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  editSeq: number;
}

export interface ConfigPageData {
  revisions: ConfigRevisionView[];
  audit: Array<{ id: number; action: string; actor: string; revision_id: number | null; detail: string | null; created_at: string }>;
  csrfToken?: string;
  canWrite: boolean;
  notice?: string;
  error?: string;
  effectiveConfig?: EffectiveConfigEntry[];
  /** Structured-editor inputs; required for the create/edit forms when canWrite. */
  profileEditor?: {
    knownRoles: Array<{ id: string; title: string }>;
    modelCatalog: string[];
    /** A failed save re-renders submitted values with field errors in place. */
    form?: { values: ProfileFormValues; errors?: ProfileFieldErrors; revision?: { id: number; editSeq: number } };
  };
}

/** Env-derived values are operator-controlled but unbounded: clamp length and
 * strip control characters so a giant or binary-laden variable cannot bloat or
 * visually spoof the page. */
function clampConfigValue(value: string): string {
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, " ");
  return clean.length > 300 ? `${clean.slice(0, 300)}… (+${clean.length - 300} chars)` : clean;
}

/** Renders the /config "Effective configuration" section: entries grouped by
 * `group`, each with a source badge. Escapes and clamps all entry text.
 * Returns "" when entries is empty. */
function renderEffectiveConfigSection(entries: EffectiveConfigEntry[]): string {
  if (entries.length === 0) return "";
  const groups = new Map<string, EffectiveConfigEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.group) ?? [];
    list.push(entry);
    groups.set(entry.group, list);
  }
  const sourceBadge = (entry: EffectiveConfigEntry): string => {
    const detail = entry.sourceDetail ? ` ${escapeHtml(entry.sourceDetail)}` : "";
    if (entry.source === "profile") return `<span class="config-source config-source-profile">Profile ${detail}</span>`;
    if (entry.source === "environment") return `<span class="config-source">Environment</span>`;
    return `<span class="config-source">Default</span>`;
  };
  const sections = [...groups.entries()]
    .map(([group, groupEntries]) => {
      const rows = groupEntries
        .map(
          (entry) => `<div>
            <dt>${escapeHtml(entry.label)} ${sourceBadge(entry)}${entry.notEnforced ? ` <span class="config-source" title="Stored in the profile schema but not yet consumed by the pipeline">not enforced at runtime</span>` : ""}</dt>
            <dd><code class="metric">${escapeHtml(clampConfigValue(entry.value))}</code></dd>
          </div>`,
        )
        .join("");
      return `<h3>${escapeHtml(group)}</h3><dl class="meta-grid config-effective">${rows}</dl>`;
    })
    .join("");
  return `<h2 id="effective">Effective configuration</h2>
    <p class="lede">What this process is actually running, with the source of every value. Credential values are never shown — only whether they are configured.</p>
    ${sections}`;
}

function revisionCard(revision: ConfigRevisionView, data: ConfigPageData): string {
  const csrf = csrfInput(data.csrfToken);
  const actions: string[] = [];
  if (data.canWrite && revision.status === "draft") {
    actions.push(`<form method="post" action="/config/revisions/${revision.id}/activate" class="inline-form">
      ${csrf}
      <button type="submit">Activate</button>
    </form>`);
  }
  if (data.canWrite && revision.status === "retired") {
    actions.push(`<form method="post" action="/config/revisions/${revision.id}/rollback" class="inline-form">
      ${csrf}
      <button type="submit">Roll back to this revision</button>
    </form>`);
  }
  const definitionJson = JSON.stringify(revision.definition, null, 2);
  return `<article class="card config-revision">
    <header>
      <span class="role"><strong>#${revision.id}</strong> ${escapeHtml(revision.name)} · ${escapeHtml(revision.status)}</span>
      <span class="muted">by ${escapeHtml(revision.created_by)} · updated ${escapeHtml(revision.updated_at)}</span>
    </header>
    ${revision.note ? `<p class="muted">${escapeHtml(revision.note)}</p>` : ""}
    <details>
      <summary>Definition</summary>
      <pre class="log-panel">${escapeHtml(definitionJson)}</pre>
    </details>
    ${revision.status === "draft" && data.canWrite ? `<details>
      <summary>Edit draft</summary>
      <form method="post" action="/config/drafts/${revision.id}">
        ${csrf}
        <input type="hidden" name="expected_edit_seq" value="${revision.editSeq}"/>
        <textarea name="definition" rows="12" cols="72">${escapeHtml(definitionJson)}</textarea>
        <button type="submit">Save draft</button>
      </form>
    </details>` : ""}
    <div class="config-actions">${actions.join("")}</div>
  </article>`;
}

export interface ProfileFormOptions {
  csrfToken: string;
  /** Present when editing an existing draft; absent when creating. */
  revision?: { id: number; editSeq: number };
  knownRoles: Array<{ id: string; title: string }>;
  modelCatalog: string[];
}

const SEVERITIES: readonly Severity[] = ["blocker", "high", "medium", "low", "info"];

function fieldError(errors: ProfileFieldErrors | undefined, key: string): string {
  const message = errors?.[key];
  if (!message) return "";
  return `<p class="error" role="alert" aria-live="polite" id="${escapeHtml(key)}-error">${escapeHtml(message)}</p>`;
}

/**
 * The structured profile editor: labeled controls for the full versioned
 * profile schema, replacing raw JSON as the primary create/edit path. Fully
 * server-rendered — add/remove/reorder are submit buttons the route applies
 * and re-renders, so nothing requires JavaScript. Invalid zod fields are
 * shown next to their control with the submitted values retained.
 */
export function renderProfileForm(
  values: ProfileFormValues,
  errors: ProfileFieldErrors | undefined,
  options: ProfileFormOptions,
): string {
  const err = (key: string) => fieldError(errors, key);
  const invalidAttr = (key: string) => (errors?.[key] ? 'aria-invalid="true"' : "");
  const describedBy = (key: string) => (errors?.[key] ? `aria-describedby="${key}-error"` : "");

  const roleOptions = (selected: string) =>
    [`<option value="">— pick a role —</option>`]
      .concat(
        options.knownRoles.map(
          (role) =>
            `<option value="${escapeHtml(role.id)}"${role.id === selected ? " selected" : ""}>${escapeHtml(role.title || role.id)}</option>`,
        ),
      )
      .join("");

  const reviewerRows = values.reviewers
    .map((row, index) => {
      const key = (leaf: string) => `reviewer_${leaf}_${index}`;
      const roleError = errors?.[`reviewer_role_${index}`];
      const modelError = errors?.[`reviewer_model_${index}`];
      const timeoutError = errors?.[`reviewer_timeout_${index}`];
      // Every present row error renders; all three controls point their
      // aria-describedby at this one paragraph's id.
      const rowErrors = [roleError, modelError, timeoutError].filter(
        (message): message is string => Boolean(message),
      );
      // up:0 / down:last decode to noop actions; rendering them invites a
      // click that does nothing. Boundary rows simply have fewer buttons.
      const upButton =
        index > 0
          ? `<button type="submit" name="action" value="up:${index}" aria-label="Move reviewer ${index + 1} up">↑</button>`
          : "";
      const downButton =
        index < values.reviewers.length - 1
          ? `<button type="submit" name="action" value="down:${index}" aria-label="Move reviewer ${index + 1} down">↓</button>`
          : "";
      return `<fieldset class="profile-reviewer">
        <legend>Reviewer ${index + 1}</legend>
        ${rowErrors.length > 0 ? `<p class="error" role="alert" id="${escapeHtml(`reviewer_row_${index}`)}-error">${rowErrors.map((message) => escapeHtml(message)).join("<br/>")}</p>` : ""}
        <label>Role
          <select name="${key("role")}" ${roleError ? `aria-invalid="true" aria-describedby="reviewer_row_${index}-error"` : ""}>${roleOptions(row.role)}</select>
        </label>
        <label>Model override (optional; provider/model)
          <input list="profile-model-catalog" name="${key("model")}" value="${escapeHtml(row.model)}" placeholder="provider/model"
            ${modelError ? `aria-invalid="true" aria-describedby="reviewer_row_${index}-error"` : ""}/>
        </label>
        <label>Timeout in seconds (optional, decimals allowed — caps this reviewer's run time; falls back to OPENCODE_TIMEOUT_MS)
          <input type="number" step="any" min="0" name="${key("timeout")}" value="${escapeHtml(row.timeoutSeconds)}"
            ${timeoutError ? `aria-invalid="true" aria-describedby="reviewer_row_${index}-error"` : ""}/>
        </label>
        <div class="config-actions">
          ${upButton}
          ${downButton}
          <button type="submit" name="action" value="remove:${index}" aria-label="Remove reviewer ${index + 1}">Remove</button>
        </div>
      </fieldset>`;
    })
    .join("");

  const modelDatalist =
    options.modelCatalog.length > 0
      ? `<datalist id="profile-model-catalog">${options.modelCatalog
          .map((model) => `<option value="${escapeHtml(model)}"></option>`)
          .join("")}</datalist>`
      : "";

  const target = options.revision
    ? `/config/drafts/${options.revision.id}`
    : "/config/drafts";
  const editSeq = options.revision
    ? `<input type="hidden" name="expected_edit_seq" value="${options.revision.editSeq}"/>`
    : "";

  return `<section class="profile-editor">
    <h3>${options.revision ? `Edit draft #${options.revision.id}` : "Create a draft"}</h3>
    ${errors?.form ? `<p class="error" role="alert">${escapeHtml(errors.form)}</p>` : ""}
    <form method="post" action="${target}">
      ${csrfInput(options.csrfToken)}
      ${editSeq}
      <input type="hidden" name="editor" value="structured"/>
      <input type="hidden" name="reviewer_count" value="${values.reviewers.length}"/>
      <fieldset>
        <legend>Profile</legend>
        <label>Name (lowercase letters, digits, dashes)
          <input name="name" value="${escapeHtml(values.name)}" pattern="[a-z0-9][a-z0-9-]{0,48}" required
            ${invalidAttr("name")} ${describedBy("name")}/>
        </label>
        ${err("name")}
        <label>Revision note (optional)
          <input name="note" value="${escapeHtml(values.note)}"/>
        </label>
      </fieldset>
      <fieldset>
        <legend>Reviewers (in order; roles not listed are disabled)</legend>
        ${reviewerRows}
        <button type="submit" name="action" value="add">Add reviewer</button>
        ${modelDatalist}
      </fieldset>
      <fieldset>
        <legend>Publishing</legend>
        <label>Minimum publishable severity
          <select name="min_severity">
            ${SEVERITIES.map((severity) => `<option value="${severity}"${severity === values.minSeverity ? " selected" : ""}>${severity}</option>`).join("")}
          </select>
        </label>
        <label>Router model override (optional; provider/model)
          <input name="router_model" value="${escapeHtml(values.routerModel)}" list="profile-model-catalog" ${invalidAttr("router_model")} ${describedBy("router_model")}/>
        </label>
        ${err("router_model")}
        <label>Total cost ceiling in USD (optional — enforced per job across reviewer, aggregation, and verification spend)
          <input type="number" step="0.01" min="0" name="max_cost_usd" value="${escapeHtml(values.maxCostUsd)}" ${invalidAttr("max_cost_usd")} ${describedBy("max_cost_usd")}/>
        </label>
        ${err("max_cost_usd")}
        <label>Total token ceiling (optional — enforced per job across reviewer, aggregation, and verification spend)
          <input type="number" min="0" name="max_tokens" value="${escapeHtml(values.maxTokens)}" ${invalidAttr("max_tokens")} ${describedBy("max_tokens")}/>
        </label>
        ${err("max_tokens")}
        <label>When a budget ceiling is hit
          <select name="budget_behavior">
            <option value="degrade"${values.budgetBehavior === "degrade" ? " selected" : ""}>Degrade — skip remaining paid stages, publish partial results</option>
            <option value="fail"${values.budgetBehavior === "fail" ? " selected" : ""}>Fail — abort the job</option>
          </select>
        </label>
      </fieldset>
      <button type="submit" name="action" value="save">Save draft</button>
      <a href="/config">Cancel</a>
    </form>
  </section>`;
}

export function renderConfigPage(data: ConfigPageData): string {
  const active = data.revisions.filter((revision) => revision.status === "active");
  const drafts = data.revisions.filter((revision) => revision.status === "draft");
  const retired = data.revisions.filter((revision) => revision.status === "retired");
  const csrf = csrfInput(data.csrfToken);
  const createForm =
    data.canWrite && data.profileEditor
      ? data.profileEditor.form && !data.profileEditor.form.revision
        ? // A failed create save re-renders the submitted values with errors.
          renderProfileForm(data.profileEditor.form.values, data.profileEditor.form.errors, {
            csrfToken: data.csrfToken ?? "",
            knownRoles: data.profileEditor.knownRoles,
            modelCatalog: data.profileEditor.modelCatalog,
          })
        : renderProfileForm(initialProfileFormValues(), undefined, {
            csrfToken: data.csrfToken ?? "",
            knownRoles: data.profileEditor.knownRoles,
            modelCatalog: data.profileEditor.modelCatalog,
          })
      : `<p class="muted">Writing configuration requires an operator OAuth identity.</p>`;
  const importForm = data.canWrite
    ? `<details class="config-import">
        <summary>Import exported configuration</summary>
        <form method="post" action="/config/import">
          ${csrf}
          <textarea name="payload" rows="8" cols="72"></textarea>
          <button type="submit">Import as drafts</button>
        </form>
      </details>`
    : "";
  const auditRows = data.audit
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.created_at)}</td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.actor)}</td><td>${entry.revision_id ?? "—"}</td><td>${escapeHtml(entry.detail ?? "")}</td></tr>`,
    )
    .join("");
  const body = `
    <h1>Review configuration</h1>
    <p class="lede">Versioned review profiles and specialist selection. Activation is explicit and audited; credentials are never part of this configuration.</p>
    ${data.notice ? `<p class="notice" role="status">${escapeHtml(data.notice)}</p>` : ""}
    ${data.error ? `<p class="error" role="alert">${escapeHtml(data.error)}</p>` : ""}
    ${data.effectiveConfig ? renderEffectiveConfigSection(data.effectiveConfig) : ""}
    <p><a href="/config/export">Export configuration (JSON)</a></p>
    <h2>Active</h2>
    ${active.map((revision) => revisionCard(revision, data)).join("") || `<p class="muted">No active revision — env configuration applies.</p>`}
    <h2>Drafts</h2>
    ${createForm}
    ${drafts
      .map((revision) => {
        const failingForm =
          data.profileEditor?.form?.revision?.id === revision.id ? data.profileEditor.form : undefined;
        const editor =
          data.canWrite && data.profileEditor
            ? renderProfileForm(
                failingForm
                  ? failingForm.values
                  : profileFormValuesFromDefinition(revision.definition, revision.note),
                failingForm?.errors,
                {
                  csrfToken: data.csrfToken ?? "",
                  revision: { id: revision.id, editSeq: revision.editSeq },
                  knownRoles: data.profileEditor.knownRoles,
                  modelCatalog: data.profileEditor.modelCatalog,
                },
              )
            : "";
        return `${editor}${revisionCard(revision, data)}`;
      })
      .join("") || `<p class="muted">No open drafts.</p>`}
    <h2>Retired</h2>
    ${retired.map((revision) => revisionCard(revision, data)).join("") || `<p class="muted">No retired revisions.</p>`}
    ${importForm}
    <h2>Audit history</h2>
    <table class="config-audit">
      <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Revision</th><th>Detail</th></tr></thead>
      <tbody>${auditRows || `<tr><td colspan="5">No entries</td></tr>`}</tbody>
    </table>`;
  return layout("Review configuration", body, {
    showLogout: data.canWrite || Boolean(data.csrfToken),
    csrfToken: data.csrfToken,
  });
}

export interface PromptRevisionView {
  id: number;
  role_id: string;
  status: string;
  body: string;
  note: string | null;
  created_by: string;
  editSeq: number;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
}

export interface PromptFixtureView {
  id: number;
  name: string;
  prMeta: Record<string, unknown>;
  diffChars: number;
  expectations: Array<{ severity: string; category?: string; pathContains?: string }>;
  saved_by: string;
  created_at: string;
}

export interface PromptEvaluationView {
  id: number;
  prompt_revision_id: number;
  fixture_id: number;
  model: string;
  status: string;
  findings: Array<{ severity?: string; category?: string; file?: string; summary?: string }>;
  usage: { cost?: number; totalTokens?: number } | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

export interface PromptConfigPageData {
  revisions: PromptRevisionView[];
  fixtures: PromptFixtureView[];
  evaluations: PromptEvaluationView[];
  canWrite: boolean;
  csrfToken?: string;
  notice?: string;
  error?: string;
}

function promptRevisionCard(revision: PromptRevisionView, data: PromptConfigPageData): string {
  const csrf = csrfInput(data.csrfToken);
  const actions: string[] = [];
  if (data.canWrite && revision.status === "draft") {
    actions.push(`<form method="post" action="/config/prompts/${revision.id}/activate" class="inline-form">
      ${csrf}
      <button type="submit">Activate</button>
    </form>`);
  }
  if (data.canWrite && revision.status === "retired") {
    actions.push(`<form method="post" action="/config/prompts/${revision.id}/rollback" class="inline-form">
      ${csrf}
      <button type="submit">Roll back to this revision</button>
    </form>`);
  }
  return `<article class="card config-revision">
    <header>
      <span class="role"><strong>#${revision.id}</strong> ${escapeHtml(revision.role_id)} · ${escapeHtml(revision.status)}</span>
      <span class="muted">by ${escapeHtml(revision.created_by)} · updated ${escapeHtml(revision.updated_at)}</span>
    </header>
    ${revision.note ? `<p class="muted">${escapeHtml(revision.note)}</p>` : ""}
    <details>
      <summary>Editable instructions (guardrails are composed at runtime and are not editable)</summary>
      <pre class="log-panel">${escapeHtml(revision.body)}</pre>
    </details>
    ${revision.status === "draft" && data.canWrite ? `<details>
      <summary>Edit draft</summary>
      <form method="post" action="/config/prompts/drafts/${revision.id}">
        ${csrf}
        <input type="hidden" name="expected_edit_seq" value="${revision.editSeq}"/>
        <textarea name="body" rows="10" cols="72">${escapeHtml(revision.body)}</textarea>
        <button type="submit">Save draft</button>
      </form>
    </details>` : ""}
    <div class="config-actions">${actions.join("")}</div>
  </article>`;
}

export function renderPromptConfigPage(data: PromptConfigPageData): string {
  const csrf = csrfInput(data.csrfToken);
  const createForm = data.canWrite
    ? `<details class="config-create">
        <summary>Create a prompt draft</summary>
        <form method="post" action="/config/prompts/drafts">
          ${csrf}
          <label>Role <input name="role_id" required/></label>
          <textarea name="body" rows="10" cols="72" placeholder="Editable instructions only — guardrails are composed at runtime"></textarea>
          <button type="submit">Create draft</button>
        </form>
      </details>`
    : `<p class="muted">Writing prompt configuration requires an operator OAuth identity.</p>`;
  const fixtureForm = data.canWrite
    ? `<details class="config-import">
        <summary>Save an evaluation fixture (explicit sanitize/provenance acknowledgement required)</summary>
        <form method="post" action="/config/prompts/fixtures">
          ${csrf}
          <label>Name <input name="name" required/></label>
          <label>PR metadata (JSON) <input name="pr_meta" value="{}"/></label>
          <textarea name="diff" rows="8" cols="72" placeholder="Sanitized unified diff"></textarea>
          <label><input type="checkbox" name="acknowledged"/> I confirm this fixture is sanitized and safe to store</label>
          <button type="submit">Save fixture</button>
        </form>
      </details>`
    : "";
  const evalForm = data.canWrite
    ? `<details class="config-import">
        <summary>Evaluate a draft prompt against a fixture (offline, never publishes)</summary>
        <form method="post" action="/config/prompts/evaluate">
          ${csrf}
          <label>Prompt revision <input name="prompt_revision_id" required/></label>
          <label>Fixture <input name="fixture_id" required/></label>
          <label>Model <input name="model"/></label>
          <label>Max cost (USD) <input name="max_cost_usd"/></label>
          <button type="submit">Evaluate</button>
        </form>
      </details>`
    : "";
  const revisionCards = data.revisions.map((revision) => promptRevisionCard(revision, data)).join("");
  const fixtureRows = data.fixtures
    .map(
      (fixture) =>
        `<tr><td>${fixture.id}</td><td>${escapeHtml(fixture.name)}</td><td>${fixture.diffChars}</td><td>${fixture.expectations.length}</td><td>${escapeHtml(fixture.saved_by)}</td></tr>`,
    )
    .join("");
  const evaluationRows = data.evaluations
    .map((evaluation) => {
      const detail = evaluation.status === "failed" ? escapeHtml(evaluation.error ?? "failed") : `${evaluation.findings.length} finding(s)`;
      return `<tr><td>${evaluation.id}</td><td>#${evaluation.prompt_revision_id}</td><td>#${evaluation.fixture_id}</td><td>${escapeHtml(evaluation.model)}</td><td>${escapeHtml(evaluation.status)}</td><td>${detail}</td></tr>`;
    })
    .join("");
  const body = `
    <h1>Specialist prompts</h1>
    <p class="lede">Versioned prompt revisions with offline fixture evaluation. Security guardrails are composed at runtime and are not editable. Evaluation never publishes to GitHub or activates a prompt.</p>
    <p><a href="/config">Back to review configuration</a></p>
    ${data.notice ? `<p class="notice" role="status">${escapeHtml(data.notice)}</p>` : ""}
    ${data.error ? `<p class="error" role="alert">${escapeHtml(data.error)}</p>` : ""}
    <h2>Revisions</h2>
    ${createForm}
    ${revisionCards || `<p class="muted">No prompt revisions — env-authored role prompts apply.</p>`}
    <h2>Evaluation fixtures</h2>
    ${fixtureForm}
    ${data.fixtures.length > 0 ? `<table class="config-audit"><thead><tr><th>ID</th><th>Name</th><th>Diff chars</th><th>Expectations</th><th>Saved by</th></tr></thead><tbody>${fixtureRows}</tbody></table>` : `<p class="muted">No fixtures saved.</p>`}
    <h2>Evaluations</h2>
    ${evalForm}
    ${data.evaluations.length > 0 ? `<table class="config-audit"><thead><tr><th>ID</th><th>Prompt</th><th>Fixture</th><th>Model</th><th>Status</th><th>Result</th></tr></thead><tbody>${evaluationRows}</tbody></table>` : `<p class="muted">No evaluations recorded.</p>`}`;
  return layout("Specialist prompts", body, {
    showLogout: data.canWrite || Boolean(data.csrfToken),
    csrfToken: data.csrfToken,
  });
}

export interface ScanPageData {
  canScan: boolean;
  identity?: UiIdentity;
  csrfToken?: string;
  issueCreationEnabled: boolean;
  profileRevision: { id: number; name: string } | null;
  recentScans: Array<{ id: number; repoFullName: string; headSha: string }>;
  error?: string;
}

/** Why a confirming POST was rejected; the page re-renders fresh values alongside it. */
export type ScanConfirmNotice =
  | { kind: "sha"; fromSha: string }
  | { kind: "branch"; fromBranch: string }
  | { kind: "revision" }
  | { kind: "incomplete" };

export interface ScanConfirmData {
  identity?: UiIdentity;
  csrfToken: string;
  repo: string;
  branch: string;
  sha: string;
  profileRevision: { id: number; name: string } | null;
  /** Minimum persisted severity from the active profile revision ("info" when no revision is active). */
  severityFloor: Severity;
  /** Max diff size in bytes; null when the cap is disabled (`MAX_DIFF_BYTES=0`). */
  limits: { diffCapBytes: number | null; reviewerTimeoutMs: number; maxRetries: number };
  notice?: ScanConfirmNotice;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

function scanConfirmNoticeText(notice: ScanConfirmNotice): string {
  switch (notice.kind) {
    case "sha":
      return `The default branch moved since you confirmed: ${notice.fromSha} is no longer the head. Review the new SHA and confirm again.`;
    case "branch":
      return `The default branch is different from the one you confirmed (${notice.fromBranch}). Review and confirm again.`;
    case "revision":
      return "The active profile revision changed since you confirmed. Review the revision below and confirm again.";
    case "incomplete":
      return "Confirmation incomplete — the revision shown here is the one that will be scanned. Confirm again.";
  }
}

export function renderScanConfirmPage(data: ScanConfirmData): string {
  const notice = data.notice
    ? `<p class="warn" role="alert">${escapeHtml(scanConfirmNoticeText(data.notice))}</p>`
    : "";
  const lede = data.notice
    ? ""
    : `<p class="lede">The scan reviews this exact revision, read-only. Nothing is created on GitHub by scanning.</p>`;
  const body = `
    <h1>Confirm repository health scan</h1>
    ${notice}
    ${lede}
    <dl class="meta-grid">
      <div>
        <dt>Repository</dt>
        <dd><code>${escapeHtml(data.repo)}</code></dd>
      </div>
      <div>
        <dt>Default branch</dt>
        <dd><code>${escapeHtml(data.branch)}</code></dd>
      </div>
      <div class="sha-block">
        <dt>Head SHA</dt>
        <dd><code class="sha">${escapeHtml(data.sha)}</code></dd>
      </div>
      <div>
        <dt>Profile revision</dt>
        <dd>${
          data.profileRevision
            ? `<code>#${data.profileRevision.id}</code> · ${escapeHtml(data.profileRevision.name)} (snapshotted onto the job)`
            : "No active revision — env configuration applies"
        }</dd>
      </div>
      <div>
        <dt>Severity floor</dt>
        <dd><code>${escapeHtml(data.severityFloor)}</code> — lower-severity findings are not persisted</dd>
      </div>
      <div>
        <dt>Limits</dt>
        <dd class="metric">diff cap ${escapeHtml(data.limits.diffCapBytes == null ? "no cap" : formatBytes(data.limits.diffCapBytes))} · reviewer timeout ${escapeHtml(formatDuration(data.limits.reviewerTimeoutMs))} · max retries ${data.limits.maxRetries}</dd>
      </div>
    </dl>
    <form class="trigger" method="post" action="/scan">
      ${csrfInput(data.csrfToken)}
      <input type="hidden" name="repo" value="${escapeHtml(data.repo)}"/>
      <input type="hidden" name="branch" value="${escapeHtml(data.branch)}"/>
      <input type="hidden" name="sha" value="${escapeHtml(data.sha)}"/>
      <input type="hidden" name="revision_id" value="${data.profileRevision ? String(data.profileRevision.id) : ""}"/>
      <button type="submit" aria-label="Run repository health scan">Sniff sniff</button>
      <a href="/scan">Cancel</a>
    </form>`;
  return layout("Confirm repository health scan", body, {
    showLogout: Boolean(data.csrfToken),
    csrfToken: data.csrfToken,
    identity: data.identity,
  });
}

export function renderScanPage(data: ScanPageData): string {
  const csrf = csrfInput(data.csrfToken);
  const recentScans = data.recentScans.length
    ? `<ul class="queue">${data.recentScans
        .map(
          (scan) =>
            `<li><article class="specimen"><p class="specimen-title"><a href="/jobs/${scan.id}">Job ${scan.id} · ${escapeHtml(scan.repoFullName)}</a></p><div class="meta-row"><span class="pair">SHA <strong><code class="sha">${escapeHtml(shortSha(scan.headSha, 12))}</code></strong></span></div></article></li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">No completed scans yet.</p>`;
  const body = `
    <h1>Repository health scan</h1>
    <p class="lede">Run a manual, read-only specialist scan of a repository's default branch. Issue creation is a separate, explicit step on a completed scan's job page. Nothing is created automatically.</p>
    ${data.error ? `<p class="error" role="alert">${escapeHtml(data.error)}</p>` : ""}
    ${data.canScan ? `
    <form class="trigger" method="post" action="/scan">
      ${csrf}
      <label for="scan-repo-input">Repository (owner/repo — must be an allowlisted installation)
        <span class="typeahead-wrap">
          <input id="scan-repo-input" name="repo" placeholder="owner/repo — start typing to search" required autocomplete="off"
            role="combobox" aria-expanded="false" aria-controls="repo-listbox" aria-autocomplete="list"
            data-repo-typeahead/>
          <ul id="repo-listbox" role="listbox" aria-label="Allowlisted repositories" class="typeahead-listbox" hidden></ul>
        </span>
      </label>
      <button type="submit" aria-label="Run repository health scan">Sniff sniff</button>
    </form>
    <p class="muted">${data.profileRevision ? `Active profile revision: #${data.profileRevision.id} (${escapeHtml(data.profileRevision.name)}) — snapshotted onto the scan job.` : "No active profile revision — env configuration applies."}</p>
    <h2>Recent completed scans</h2>
    ${recentScans}
    ${
      data.issueCreationEnabled
        ? `<p class="muted">Open a completed scan to select findings, preview the proposed issues, and publish them. Findings are deduplicated per repository + fingerprint; already-linked GitHub issues are skipped, and partial failures can be retried safely.</p>`
        : `<p class="muted">Issue creation is disabled (GITHUB_ISSUE_CREATION_ENABLED=false).</p>`
    }
    <script src="${TYPEAHEAD_HREF}" defer></script>`
    : `<p class="muted">Scanning requires an operator GitHub OAuth identity.</p>`}`;
  return layout("Repository health scan", body, {
    showLogout: data.canScan || Boolean(data.csrfToken),
    csrfToken: data.csrfToken,
    identity: data.identity,
  });
}

export interface ScanIssueCreationData {
  enabled: boolean;
  /** The completed health-scan job this form posts against. */
  jobId: number;
  findings: Array<{
    fingerprint: string;
    summary: string;
    severity: string;
    confidence: number | null;
    agreed: string[];
    worthy: boolean;
    unworthyReason?: string;
  }>;
}

function renderScanIssueCreation(data: ScanIssueCreationData, csrfToken: string | undefined): string {
  if (!data.enabled) {
    return `<h2>Create GitHub issues</h2><p class="muted">Issue creation is disabled (GITHUB_ISSUE_CREATION_ENABLED=false).</p>`;
  }
  if (data.findings.length === 0) {
    return `<h2>Create GitHub issues</h2><p class="muted">No open findings in this scan.</p>`;
  }
  const rows = data.findings
    .map((finding) => {
      const meta = [
        finding.severity.toUpperCase(),
        finding.confidence != null ? `${Math.round(finding.confidence * 100)}%` : null,
        finding.agreed.length ? `reviewers: ${finding.agreed.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const checkbox = finding.worthy
        ? `<input type="checkbox" name="fp[]" value="${escapeHtml(finding.fingerprint)}" checked/>`
        : `<input type="checkbox" name="fp[]" value="${escapeHtml(finding.fingerprint)}" disabled/>`;
      const note = finding.worthy
        ? ""
        : `<div class="muted">Not offered: ${escapeHtml(finding.unworthyReason ?? "speculative")}</div>`;
      return `<div class="finding">
        <label>${checkbox} <span class="sev sev-${escapeHtml(finding.severity)}">${escapeHtml(meta)}</span> ${escapeHtml(finding.summary)}</label>
        ${note}
      </div>`;
    })
    .join("");
  return `<h2>Create GitHub issues</h2>
    <p class="muted">Select concrete, validated findings to publish. Speculative observations (below the confidence and consensus bar) cannot be turned into issues.</p>
    <form class="trigger" method="post" action="/scan/issues/preview">
      ${csrfInput(csrfToken)}
      <input type="hidden" name="job_id" value="${data.jobId}"/>
      ${rows}
      <button type="submit">Preview issues for selected findings</button>
    </form>`;
}

export interface ScanIssuePreviewItem {
  fingerprint: string;
  severity: string;
  title: string;
  /** The exact Markdown body that will be published (marker included, secrets redacted). */
  body: string;
  agreed: string[];
  /** Present when publication will skip this finding, with the reason and existing issue link if known. */
  skip?: { reason: string; url?: string };
  /** Set when the remote dedup check could not run; the skip state is then unverified. */
  dedupCheckFailed?: boolean;
  /** Likely human-authored open issues about the same problem, for review only. */
  duplicates: Array<{ title: string; url: string }>;
}

export interface ScanIssuePreviewData {
  identity?: UiIdentity;
  csrfToken: string;
  job: { id: number; repoFullName: string; headSha: string };
  items: ScanIssuePreviewItem[];
  rejected: string[];
}

export function renderScanIssuePreviewPage(data: ScanIssuePreviewData): string {
  const creatable = data.items.filter((item) => !item.skip);
  const cards = data.items
    .map((item) => {
      const skip = item.skip
        ? `<p class="muted" role="status">Will be skipped: ${escapeHtml(item.skip.reason)}${
            item.skip.url ? ` (<a href="${escapeHtml(item.skip.url)}">#${escapeHtml(String(item.skip.url.split("/").pop() ?? ""))}</a>)` : ""
          }</p>`
        : "";
      const dedupCheck = item.dedupCheckFailed && !item.skip
        ? `<p class="warn" role="alert">Remote dedup check failed for this finding — it may already be tracked; publication may duplicate or fail.</p>`
        : "";
      const duplicates = item.duplicates.length
        ? `<p class="muted">Possibly related open issues (review before publishing; Maomao will not modify them):</p><ul>${item.duplicates
            .map((d) => `<li><a href="${escapeHtml(d.url)}">${escapeHtml(d.title)}</a></li>`)
            .join("")}</ul>`
        : "";
      return `<article class="finding">
        <div class="finding-head"><span class="sev sev-${escapeHtml(item.severity)}">${escapeHtml(item.severity.toUpperCase())}</span>${
          item.agreed.length ? `<span class="muted">reviewers: ${escapeHtml(item.agreed.join(", "))}</span>` : ""
        }</div>
        <h3>${escapeHtml(item.title)}</h3>
        <pre class="diff-panel" aria-label="Proposed issue body">${escapeHtml(item.body)}</pre>
        ${skip}
        ${dedupCheck}
        ${duplicates}
      </article>`;
    })
    .join("");
  const rejected = data.rejected.length
    ? `<p class="warn" role="alert">${data.rejected.length} selected finding(s) could not be published: ${escapeHtml(data.rejected.join("; "))}</p>`
    : "";
  const confirmForm =
    creatable.length === 0
      ? `<p class="muted">Nothing left to publish — every selected finding is already tracked. Retrying is safe.</p>`
      : `<form class="trigger" method="post" action="/scan/issues">
          ${csrfInput(data.csrfToken)}
          <input type="hidden" name="job_id" value="${data.job.id}"/>
          ${creatable.map((item) => `<input type="hidden" name="fp[]" value="${escapeHtml(item.fingerprint)}"/>`).join("")}
          <button type="submit" aria-label="Create GitHub issues for selected findings">Create ${creatable.length} issue${creatable.length === 1 ? "" : "s"}</button>
          <a href="/jobs/${data.job.id}">Cancel</a>
        </form>`;
  const body = `
    <p class="crumb"><a href="/jobs/${data.job.id}">Job ${data.job.id}</a> / preview issues</p>
    <h1>Preview GitHub issues</h1>
    <p class="lede">Target: <code>${escapeHtml(data.job.repoFullName)}</code> at <code class="sha">${escapeHtml(shortSha(data.job.headSha, 12))}</code>. Publication uses the GitHub App installation identity (never the operator's OAuth token) and requires the App permission <strong>Issues: write</strong>. Selected: ${data.items.length} finding(s), ${creatable.length} to be created.</p>
    ${rejected}
    ${cards}
    ${confirmForm}`;
  return layout("Preview GitHub issues", body, {
    showLogout: Boolean(data.csrfToken),
    csrfToken: data.csrfToken,
    identity: data.identity,
  });
}

export interface CancelConfirmData {
  identity?: UiIdentity;
  csrfToken?: string;
  showLogout?: boolean;
  job: { id: number; repoFullName: string; prNumber: number; prTitle: string; headSha: string; jobType: string };
}

/**
 * Confirmation gate for stopping live work: the POST is bound to this job id
 * and re-validated against the live states server-side, so a job that reached
 * a terminal state in the meantime is refused rather than cancelled.
 */
export function renderCancelConfirmPage(data: CancelConfirmData): string {
  const isScan = data.job.jobType === "health_scan";
  const heading = isScan ? "Cancel this scan?" : "Cancel this review?";
  const subject = isScan
    ? `the health scan of ${escapeHtml(data.job.repoFullName)}`
    : `${escapeHtml(data.job.repoFullName)}#${data.job.prNumber}${data.job.prTitle ? ` — ${escapeHtml(data.job.prTitle)}` : ""}`;
  const body = `
    <p class="crumb"><a href="/jobs/${data.job.id}">Job ${data.job.id}</a> / cancel</p>
    <h1>${heading}</h1>
    <p class="lede">You are about to stop the running review of ${subject} at <code class="sha">${escapeHtml(shortSha(data.job.headSha, 12))}</code>.</p>
    <p class="warn" role="alert">This review will not be completed, and its work cannot be resumed. This cannot be undone — queue the review again if you change your mind.</p>
    <form class="trigger" method="post" action="/jobs/${data.job.id}/cancel">
      ${csrfInput(data.csrfToken)}
      <button type="submit" aria-label="Confirm cancelling this review">Cancel review</button>
      <a href="/jobs/${data.job.id}">Keep it running</a>
    </form>`;
  return layout(heading, body, {
    showLogout: data.showLogout ?? false,
    csrfToken: data.csrfToken,
    identity: data.identity,
  });
}
