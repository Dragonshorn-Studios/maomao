import type { CancelReason, JobState, ReviewerState } from "../config.js";
import type { Severity } from "../schema.js";

export const PRODUCT_TAGLINE = "PR examination console";
export const PRODUCT_DESCRIPTION = "Self-hosted multi-agent pull request review powered by OpenCode.";

export interface LabeledState {
  text: string;
  hint: string;
  mark: string;
}

const JOB_STATES: Record<JobState, LabeledState> = {
  queued: { text: "Queued", hint: "Waiting to examine this pull request", mark: "○" },
  preparing: { text: "Preparing", hint: "Checking out the reviewed head SHA", mark: "◌" },
  routing: { text: "Routing", hint: "Selecting a review profile and specialists", mark: "◎" },
  reconciling: { text: "Reconciling", hint: "Checking prior findings against this SHA", mark: "◍" },
  reviewing: { text: "Reviewing", hint: "Examining this pull request", mark: "◉" },
  aggregating: { text: "Aggregating", hint: "Aggregation in progress", mark: "◎" },
  sniffing: { text: "Sniffing", hint: "Laboratory re-check of the aggregated findings", mark: "◔" },
  publishing: { text: "Publishing", hint: "Posting the GitHub COMMENT review", mark: "▣" },
  completed: { text: "Completed", hint: "Examination finished for this SHA", mark: "●" },
  failed: { text: "Failed", hint: "Examination stopped on an error", mark: "!" },
  stale: { text: "Stale", hint: "A newer commit exists for this pull request", mark: "△" },
  cancelled: { text: "Cancelled", hint: "Job cancelled", mark: "–" },
};

const RUN_STATES: Record<ReviewerState, LabeledState> = {
  queued: { text: "Queued", hint: "Not started", mark: "○" },
  running: { text: "Running", hint: "Collecting observations", mark: "◉" },
  done: { text: "Done", hint: "Reviewer finished", mark: "●" },
  failed: { text: "Failed", hint: "Reviewer did not finish", mark: "!" },
};

const SEVERITY: Record<Severity, { text: string; mark: string }> = {
  blocker: { text: "BLOCKER", mark: "■" },
  high: { text: "HIGH", mark: "▲" },
  medium: { text: "MEDIUM", mark: "◆" },
  low: { text: "LOW", mark: "●" },
  info: { text: "INFO", mark: "·" },
};

export function jobStateLabel(state: string): LabeledState {
  return JOB_STATES[state as JobState] ?? { text: state, hint: state, mark: "•" };
}

export function runStateLabel(state: string): LabeledState {
  return RUN_STATES[state as ReviewerState] ?? { text: state, hint: state, mark: "•" };
}

export function severityLabel(severity: string): { text: string; mark: string } {
  return SEVERITY[severity as Severity] ?? { text: severity.toUpperCase(), mark: "•" };
}

export function emptyQueueCopy(): { title: string; body: string } {
  return {
    title: "Nothing is under examination.",
    body: "Waiting for a GitHub pull_request webhook, or paste a pull request URL above.",
  };
}

export function observationsCopy(count: number, unconfirmed = false): string {
  if (count === 0) return "No suspicious findings";
  if (unconfirmed) {
    if (count === 1) return "1 unconfirmed observation";
    return `${count} unconfirmed observations`;
  }
  if (count === 1) return "1 observation collected";
  return `${count} observations collected`;
}

export function unconfirmedFindingsBanner(): string {
  return "Unconfirmed specialist observations. The aggregator has not validated these yet.";
}

export function usageIncompleteCopy(): string {
  return "Usage incomplete: OpenCode did not emit a final step_finish. Figures are the minimum observed, not a complete total.";
}

export function usageReportedCopy(): string {
  return "Token and cost figures are OpenCode/provider-reported usage, not an independently calculated invoice.";
}

export function staleBanner(): string {
  return "This job reviewed an older commit. A newer head SHA exists for this pull request; do not treat this result as current.";
}

/**
 * Reason-aware copy for the terminal `cancelled` state. Deliberately not
 * failure-flavoured: cancellation is an outcome, not an error. Claims stay
 * honest: a cancel lands at the next checkpoint, so a review POST already in
 * flight can still complete (the pipeline logs "cancelled after a review was
 * posted") — never promise "nothing was published".
 */
export function cancelledBannerCopy(job: {
  cancelled_reason: CancelReason | null;
  cancelled_by: string | null;
  pr_html_url: string;
  job_type: string;
  github_review_id: string | null;
  github_review_url: string | null;
}): { text: string; link?: { href: string; label: string } } {
  if (job.cancelled_reason === "manual_dequeue") {
    const who = job.cancelled_by ?? "an operator";
    return {
      text: `Dequeued by ${who}. Removed from the queue before work started; history and logs are preserved.`,
    };
  }
  if (job.cancelled_reason === "pr_merged") {
    if (job.github_review_id) {
      // The review POST was already in flight when the merge landed.
      return {
        text: "Cancelled — PR merged after the review was posted; the posted review may be stale.",
        link: job.github_review_url
          ? { href: job.github_review_url, label: "View the posted review" }
          : undefined,
      };
    }
    return {
      text: "Cancelled — PR merged. The merge superseded this job before it could finish.",
      link: job.pr_html_url ? { href: job.pr_html_url, label: "View the merged pull request" } : undefined,
    };
  }
  if (job.cancelled_reason === "manual_cancel") {
    if (job.github_review_id) {
      return {
        text: "Review cancelled after the review was posted; the posted review may be stale and no longer reflects this job.",
        link: job.github_review_url
          ? { href: job.github_review_url, label: "View the posted review" }
          : undefined,
      };
    }
    const who = job.cancelled_by ?? "an operator";
    return {
      text: `Review cancelled by ${who}. Work stopped at the next checkpoint; the review was not completed.`,
    };
  }
  if (job.cancelled_reason === "repo_paused") {
    const who = job.cancelled_by ?? "an operator";
    return { text: `Cancelled — ${who} paused automatic reviews for this repository.` };
  }
  if (job.job_type === "health_scan") {
    return { text: "Scan cancelled. Findings already saved, if any, remain listed on this page." };
  }
  if (job.job_type === "repo_brief") {
    return { text: "Repo brief cancelled. A stored brief, if one was written, remains listed on this page." };
  }
  return { text: "Cancelled." };
}

export type UiFlavor = "apothecary" | "plain";

export function flavorForJob(state: string, prNumber: number, flavor: UiFlavor = "apothecary"): string | undefined {
  if (flavor === "plain") {
    if (state === "sniffing") return "Laboratory re-check in progress";
    return undefined;
  }
  // pr_number 0 jobs (scans, repo briefs) are not pull requests.
  if (state === "reviewing" || state === "preparing") return prNumber === 0 ? "Reading the checkout…" : `Examining PR #${prNumber}…`;
  if (state === "routing") return `Choosing specialists for PR #${prNumber}…`;
  if (state === "reconciling") return `Reconciling prior findings for PR #${prNumber}`;
  if (state === "aggregating") return "Aggregation in progress";
  if (state === "sniffing") return `Laboratory re-check for PR #${prNumber}`;
  if (state === "queued") return prNumber === 0 ? "Job is queued for examination" : `PR #${prNumber} is queued for examination`;
  return undefined;
}

/** Cat-hunt secondary copy for a specialist reviewer card; technical labels stay intact. */
export function reviewerFlavor(
  state: string,
  findingCount: number,
  flavor: UiFlavor = "apothecary",
): string | undefined {
  if (flavor === "plain") return undefined;
  if (state === "running" || state === "queued") return "Hunting through the diff…";
  if (state === "done") {
    return findingCount > 0 ? `Returned with ${findingCount} finding(s)` : "Returned without a catch";
  }
  return undefined;
}

/** One-line summary for a completed job in cat-hunt flavor. */
export function huntersReturnedCopy(reviewers: number, findings: number, flavor: UiFlavor = "apothecary"): string {
  if (flavor === "plain") return `${reviewers} reviewers returned from the diff · ${findings} findings`;
  return `${reviewers} cats returned from the diff · ${findings} findings`;
}

/** Tooltip copy for specialist roles with hunting lore; undefined keeps the plain title. */
export function roleFlavorHint(roleId: string, flavor: UiFlavor = "apothecary"): string | undefined {
  if (flavor === "plain") return undefined;
  if (roleId === "correctness") return "Catches bugs attempting to reach production.";
  return undefined;
}

export function routingProfileLabel(profile: string | null | undefined): string {
  if (profile === "observation") return "observation";
  if (profile === "diagnosis") return "diagnosis";
  if (profile === "poison-alert") return "poison-alert";
  if (profile === "fixed") return "fixed";
  return profile || "pending";
}

/** Badge for the internal (laboratory re-check) escalation channel; same visual language as run states. */
export function internalEscalationBadge(state: string | null | undefined): LabeledState & { stateClass: string } {
  switch (state) {
    case "running":
      return { stateClass: "running", text: "Running", hint: "Laboratory model in flight", mark: "◉" };
    case "done":
      return { stateClass: "done", text: "Done", hint: "Laboratory re-check finished", mark: "●" };
    case "failed":
      return { stateClass: "failed", text: "Failed", hint: "Laboratory re-check failed", mark: "!" };
    case "skipped":
      return { stateClass: "cancelled", text: "Skipped", hint: "No laboratory model configured", mark: "–" };
    default:
      return {
        stateClass: "queued",
        text: "Queued",
        hint: "Waiting on specialists and the aggregator",
        mark: "○",
      };
  }
}

/** Badge for the external (fire-and-forget) dispatch channel; same visual language as run states.
 * `decided` marks that the pipeline already decided not to dispatch (status not_requested + reason),
 * as opposed to the enqueue-time default where dispatch simply has not been reached yet. */
export function externalDispatchBadge(
  status: string | null | undefined,
  decided = false,
): LabeledState & { stateClass: string } {
  switch (status) {
    case "dispatching":
      return { stateClass: "running", text: "Dispatching", hint: "Sending the external notification", mark: "◉" };
    case "dispatched":
      return {
        stateClass: "done",
        text: "Dispatched",
        hint: "External notification accepted (delivery is fire-and-forget)",
        mark: "●",
      };
    case "dispatch_failed":
      return { stateClass: "failed", text: "Failed", hint: "External notification was not delivered", mark: "!" };
    case "not_requested":
      return decided
        ? { stateClass: "cancelled", text: "Held", hint: "External dispatch was not requested for this SHA", mark: "–" }
        : { stateClass: "queued", text: "Queued", hint: "Dispatches after the GitHub review is posted", mark: "○" };
    default:
      return { stateClass: "queued", text: "Queued", hint: "Dispatches after the GitHub review is posted", mark: "○" };
  }
}

export function findingStatusLabel(status: string): { text: string; hint: string } {
  switch (status) {
    case "resolved":
      return { text: "Resolved", hint: "The problem is gone, or GitHub already closed this conversation" };
    case "dismissed":
      return { text: "Dismissed", hint: "Acknowledged and intentionally ignored" };
    case "still_valid":
      return { text: "Still valid", hint: "The finding still applies on the current SHA" };
    case "moved":
      return { text: "Moved", hint: "Same finding at a new location" };
    case "uncertain":
      return { text: "Uncertain", hint: "Not enough evidence to close safely" };
    default:
      return { text: "Open", hint: "Outstanding finding" };
  }
}

export function findingCommandLabel(command: string | null | undefined): string {
  if (!command) return "";
  if (command === "seedling") return "🌱";
  if (command === "ignore" || command === "bury" || command === "reopen") return `@maomao ${command}`;
  return command;
}

export function findingOverrideNote(finding: {
  status: string;
  dismissed_by?: string | null;
  dismiss_command?: string | null;
  reopened_by?: string | null;
  reconciliation_reason?: string | null;
}): string | undefined {
  if (finding.status === "dismissed") {
    const who = finding.dismissed_by ? ` by ${finding.dismissed_by}` : "";
    const via = findingCommandLabel(finding.dismiss_command);
    return `Buried${who}${via ? ` via ${via}` : ""}. Intentionally ignored, not marked fixed.`;
  }
  const reason = finding.reconciliation_reason?.trim();
  if (finding.status === "resolved") {
    return reason || "Verifier confirmed the problem is gone.";
  }
  if (finding.status === "uncertain" || finding.status === "still_valid" || finding.status === "moved") {
    if (reason) return reason;
  }
  if (finding.reopened_by) {
    return `Reopened by ${finding.reopened_by}.`;
  }
  return undefined;
}

export function settledFindingsCopy(buried: number, resolved: number): string {
  const parts: string[] = [];
  if (buried) parts.push(buried === 1 ? "1 buried" : `${buried} buried`);
  if (resolved) parts.push(resolved === 1 ? "1 resolved" : `${resolved} resolved`);
  if (parts.length === 0) return "Settled findings";
  return `${parts.join(", ")} — expand a row for details`;
}

export function diffUnavailableCopy(note: string | null | undefined): string | undefined {
  switch (note) {
    case "file_unchanged":
      return "No diff preview: the file is not part of the reviewed diff.";
    case "binary":
      return "No diff preview: binary file.";
    case "outside_hunk":
      return "No diff preview: the reported line is outside the reviewed diff hunks.";
    case "no_hunks":
      return "No diff preview: the change contains no diff hunks (rename or mode change only).";
    case "missing_location":
      return "No diff preview: no file location was recorded for this finding.";
    case "no_line":
      return "No line was recorded for this finding; showing the file's first hunk.";
    case "truncated":
      return "Diff preview clipped to the lines around the reported line.";
    default:
      return undefined;
  }
}
