import type { JobState, ReviewerState } from "../config.js";
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
  reconciling: { text: "Reconciling", hint: "Checking prior findings against this SHA", mark: "◍" },
  reviewing: { text: "Reviewing", hint: "Examining this pull request", mark: "◉" },
  aggregating: { text: "Aggregating", hint: "Aggregation in progress", mark: "◎" },
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

export function flavorForJob(state: string, prNumber: number): string | undefined {
  if (state === "reviewing" || state === "preparing") return `Examining PR #${prNumber}…`;
  if (state === "reconciling") return `Reconciling prior findings for PR #${prNumber}`;
  if (state === "aggregating") return "Aggregation in progress";
  if (state === "queued") return `PR #${prNumber} is queued for examination`;
  return undefined;
}

export function findingStatusLabel(status: string): { text: string; hint: string } {
  switch (status) {
    case "resolved":
      return { text: "Resolved", hint: "Verifier confirmed the problem is gone" };
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
}): string | undefined {
  if (finding.status === "dismissed") {
    const who = finding.dismissed_by ? ` by ${finding.dismissed_by}` : "";
    const via = findingCommandLabel(finding.dismiss_command);
    return `Buried${who}${via ? ` via ${via}` : ""}. Intentionally ignored, not marked fixed.`;
  }
  if (finding.status === "resolved") {
    return "Verifier confirmed the problem is gone.";
  }
  if (finding.reopened_by) {
    return `Reopened by ${finding.reopened_by}.`;
  }
  return undefined;
}
