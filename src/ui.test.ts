import { describe, expect, it, vi } from "vitest";
import { openDb } from "./db.js";
import { seedDemoJobs } from "./demo/fixtures.js";
import { JobStore } from "./jobs/store.js";
import { THEME_CSS } from "./ui/theme.js";
import { TYPEAHEAD_JS } from "./ui/typeahead.js";
import { renderConfigAuditPage, renderConfigPage, renderDraftEditPage, renderHome, renderJob, renderLogin, renderProfilesPage, renderPromptConfigPage, renderScanConfirmPage, renderScanIssuePreviewPage, renderScanPage } from "./ui/pages.js";
import { layout } from "./ui/layout.js";
import { renderConnectionsPage } from "./ui/connections.js";
import { renderHealthPage } from "./ui/health.js";
import { renderChatPage } from "./ui/chat-page.js";
import { jobStateLabel, settledFindingsCopy, findingOverrideNote } from "./ui/copy.js";
import { formatCost, formatTokens, jobMetrics } from "./ui/metrics.js";

function seededStore() {
  const store = new JobStore(openDb(":memory:"));
  seedDemoJobs(store);
  return store;
}

describe("theme tokens", () => {
  it("defines palette, light/dark, reduced motion, and system fonts", () => {
    expect(THEME_CSS).toContain("--paper:");
    expect(THEME_CSS).toContain("--ink:");
    expect(THEME_CSS).toContain("--jade:");
    expect(THEME_CSS).toContain("--herb:");
    expect(THEME_CSS).toContain("--plum:");
    expect(THEME_CSS).toContain("--cinnabar:");
    expect(THEME_CSS).toContain("--amber:");
    expect(THEME_CSS).toContain("--working:");
    expect(THEME_CSS).toContain("--working: var(--plum)");
    expect(THEME_CSS).not.toContain("#6ecad6");
    expect(THEME_CSS).toContain(".finding.is-unconfirmed");
    expect(THEME_CSS).toContain("details.finding");
    expect(THEME_CSS).toContain(".settled-findings-label");
    expect(THEME_CSS).toContain(".diff-panel .diff-add");
    expect(THEME_CSS).toContain("--diffs-font-family");
    expect(THEME_CSS).toContain(".pierre-annotation");
    expect(THEME_CSS).toContain(".diff-layout-toggle");
    expect(THEME_CSS).toContain("details.finding-diff > summary");
    expect(THEME_CSS).toContain(".trigger .typeahead-wrap");
    expect(THEME_CSS).toContain(".pierre-diff diffs-container");
    expect(THEME_CSS).toContain("--diffs-bg: var(--code-bg)");
    expect(THEME_CSS).toContain("--diffs-fg: var(--ink)");
    expect(THEME_CSS).toContain("--diffs-addition-color-override: var(--jade)");
    expect(THEME_CSS).toContain("--diffs-deletion-color-override: var(--cinnabar)");
    expect(THEME_CSS).not.toContain("--diffs-foreground");
    expect(THEME_CSS).not.toContain("--diffs-background");
    expect(THEME_CSS).not.toContain(".diff-gutter");
    expect(THEME_CSS).not.toContain(".word-add");
    expect(THEME_CSS).toContain(".typeahead-listbox");
    expect(THEME_CSS).toContain(".typeahead-option");
    expect(THEME_CSS).toContain("@keyframes spin");
    // The Dequeue and Cancel review controls wear the same small-outline style as Retry.
    expect(THEME_CSS).toContain("form.retry, form.retry-job, form.dequeue {");
    expect(THEME_CSS).toContain(".retry button, .retry-job button, .dequeue button, a.cancel-review {");
    expect(THEME_CSS).toContain(".dequeue button:hover, a.cancel-review:hover");
    expect(THEME_CSS).toMatch(/a\.cancel-review \{[^}]*text-decoration: none/);
    expect(THEME_CSS).toContain(".section-head");
    expect(THEME_CSS).toMatch(/\.tick\.running[\s\S]*var\(--working\)/);
    expect(THEME_CSS).toMatch(/\.state-reviewing[\s\S]*var\(--working-soft\)/);
    expect(THEME_CSS).not.toMatch(/\.tick\.running \{ background: var\(--amber\)/);
    expect(THEME_CSS).toContain("--ash:");
    expect(THEME_CSS).toContain('html[data-theme="dark"]');
    expect(THEME_CSS).toContain("prefers-reduced-motion");
    expect(THEME_CSS).toContain("--font-mono:");
    expect(THEME_CSS).toContain(".account-menu");
    expect(THEME_CSS).toContain("body.operator main form:not(.chat-composer) button");
    expect(THEME_CSS).toContain(".connection-card");
    expect(THEME_CSS).toContain(".chat-reasoning");
    expect(THEME_CSS).toContain("textarea:not(.chat-composer-input)");
    expect(THEME_CSS).toContain(".forge-mark");
    expect(THEME_CSS).toContain(".brand-mark");
    expect(THEME_CSS).toContain(".chat-toolbar");
    expect(THEME_CSS).toContain(".chat-transcript[hidden]");
    expect(THEME_CSS).toContain(".prompt-role");
    expect(THEME_CSS).toContain(".prompt-role-list > li");
    expect(THEME_CSS).not.toContain("fonts.googleapis.com");
    expect(THEME_CSS).not.toContain("cdn.");
  });
});

describe("monitoring pages", () => {
  it("renders login with appearance controls and no live SSE", () => {
    const html = renderLogin({ nextPath: "/jobs/1", showPassword: true });
    expect(html).toContain("Sign in");
    expect(html).toContain('data-appearance="light"');
    expect(html).toContain('data-appearance="dark"');
    expect(html).toContain('data-appearance="system"');
    expect(html).toContain("/assets/maomao.css");
    expect(html).toContain('rel="icon" href="/assets/favicon.svg"');
    expect(html).toContain('rel="alternate icon" href="/assets/favicon.png"');
    expect(html).toContain('rel="apple-touch-icon" href="/assets/icon.png"');
    expect(html).toContain('class="brand-mark" src="/assets/favicon.svg"');
    expect(html).not.toContain("EventSource");
    expect(html).toContain("Skip to content");
    expect(html).toContain('<script src="/assets/vendor/pierre-diffs.js" defer></script>');
    expect(html).not.toContain('<details class="account-menu">');
    expect(html).not.toContain('href="/connections"');
  });

  it("renders the empty queue with restrained flavor", () => {
    const store = new JobStore(openDb(":memory:"));
    const html = renderHome([], store);
    expect(html).toContain("Nothing is under examination.");
    expect(html).toContain("Queue a GitHub pull request");
    expect(html).toContain("Review jobs");
  });

  it("renders scannable specimen cards with SHA, progress, and severity text", () => {
    const store = seededStore();
    const html = renderHome(store.listJobs(20), store);
    expect(html).toContain("acme/ledger #412");
    expect(html).toContain("forge-mark");
    expect(html).not.toContain("[GitHub]");
    expect(html).toContain("c0ffee1a2b");
    expect(html).toContain("HIGH");
    expect(html).toContain("MEDIUM");
    expect(html).toContain("Reviewers");
    expect(html).toContain("Aggregator");
    expect(html).toContain("anthropic/claude-sonnet-4-5");
    expect(html).toContain("class=\"sha\"");
    expect(html).toContain("class=\"metric\"");
    expect(html).toContain("Stale");
    expect(html).toContain("Failed");
    expect(html).toContain("Examining PR #418");
    expect(html).toContain("Choosing specialists for PR #422");
    expect(html).toContain("No suspicious findings");
    expect(html).toContain("Unconfirmed");
    expect(html).toContain("unconfirmed observation");
  });

  it("renders routing-in-progress and observation profiles on job detail", () => {
    const store = seededStore();
    const routing = store.listJobs(20).find((row) => row.pr_number === 422);
    const observation = store.listJobs(20).find((row) => row.pr_number === 401);
    expect(routing && observation).toBeTruthy();
    const routingHtml = renderJob(routing!, store.listReviewerRuns(routing!.id), store.listLogs(routing!.id));
    expect(routingHtml).toContain("Profile</strong> pending");
    expect(routingHtml).toContain("Scanner found auth and secrets");
    expect(routingHtml).toContain("reviewers pending");
    expect(routingHtml).toContain("anthropic/claude-haiku-4-5");
    const observationHtml = renderJob(
      observation!,
      store.listReviewerRuns(observation!.id),
      store.listLogs(observation!.id),
    );
    expect(observationHtml).toContain("Profile</strong> observation");
    expect(observationHtml).toContain("reviewers correctness");
    expect(observationHtml).not.toContain("Poison alert");
    store.patchJob(observation!.id, { poison_alert_policy: "internal_and_external" });
    const observationWithPolicy = renderJob(
      store.getJob(observation!.id)!,
      store.listReviewerRuns(observation!.id),
      store.listLogs(observation!.id),
    );
    // A policy without observed channels still renders the card, with both channels queued.
    expect(observationWithPolicy).toContain("Poison alert");
    expect(observationWithPolicy).toContain("laboratory re-check, then external dispatch");
    expect(observationWithPolicy).toContain("Waiting on specialists and the aggregator");
  });

  it("renders job detail with reviewer cards, findings, and a log panel", () => {
    const store = seededStore();
    const job = store.listJobs(20).find((row) => row.pr_number === 412);
    expect(job).toBeTruthy();
    const html = renderJob(job!, store.listReviewerRuns(job!.id), store.listLogs(job!.id));
    expect(html).toContain("c0ffee1a2b3c4d5e6f708192a3b4c5d6e7f8091a");
    expect(html).toContain("src/auth.ts:54");
    expect(html).toContain("Finding requires attention");
    expect(html).toContain("Correctness / regression hunter");
    expect(html).toContain("(correctness)");
    expect(html).toContain("Normalized JSON");
    expect(html).toContain("aria-label=\"Job logs\"");
    expect(html).toContain("class=\"logs\"");
    expect(html).toContain("provider");
    expect(html).toContain("main");
    expect(html).toContain("cookie-flags");
    expect(html).not.toContain("Unconfirmed");
    expect(html).toContain("10.3k tokens · $0.12");
    expect(html).toContain("independently calculated invoice");
    expect(html).toContain("reasoning");
    expect(html).toContain("cache r");
    expect(html).toContain("poison-alert");
    expect(html).toContain("<h2>Routing</h2>");
    expect(html).toMatch(/Reconciliation<\/dt>\s*<dd>—<\/dd>/);
    expect(html).toContain("internal_and_external");
    expect(html).toContain("anthropic/claude-opus-4-6");
    expect(html).toContain("Dispatched");
    expect(html).toContain("Fire-and-forget: Maomao records only the immediate notification outcome");
  });

  it("collapses buried and resolved findings under a compact summary", () => {
    const store = seededStore();
    const job = store.listJobs(20).find((row) => row.pr_number === 412);
    expect(job).toBeTruthy();
    const html = renderJob(job!, store.listReviewerRuns(job!.id), store.listLogs(job!.id), {
      prFindings: store.listFindings(job!.repo_full_name, job!.pr_number),
    });
    const findingsSection = html.slice(html.indexOf('id="findings"'));
    expect(findingsSection).toContain("Session cookie Secure flag can be dropped");
    expect(findingsSection).toContain("Finding requires attention");
    expect(findingsSection).toMatch(/<article class="finding(?![^"]*(?:is-buried|is-resolved))/);
    expect(findingsSection).toContain("<details class=\"finding is-buried");
    expect(findingsSection).toContain("<details class=\"finding is-resolved");
    expect(findingsSection).toContain("<summary>");
    expect(findingsSection).not.toMatch(/<details[^>]*\sopen[\s>]/);
    expect(findingsSection).toContain("Dismissed");
    expect(findingsSection).toContain("Production cookie note omits the forwarded-proto caveat");
    expect(findingsSection).toContain("Buried by octocat via @maomao bury");
    expect(findingsSection).toContain("Intentionally ignored, not marked fixed");
    expect(findingsSection).toContain("Resolved");
    expect(findingsSection).toContain("null deref after fix");
    expect(findingsSection).toContain("1 buried, 1 resolved");
    expect(findingsSection).toContain("expand a row for details");
    expect(html).not.toContain("Finding ledger");
  });

  it("summarizes collapsed buried and resolved rows", () => {
    expect(settledFindingsCopy(1, 1)).toBe("1 buried, 1 resolved — expand a row for details");
    expect(settledFindingsCopy(2, 0)).toBe("2 buried — expand a row for details");
    expect(settledFindingsCopy(0, 3)).toBe("3 resolved — expand a row for details");
  });

  it("surfaces the reconciliation reason when a finding is left open or caught as resolved", () => {
    expect(
      findingOverrideNote({
        status: "uncertain",
        reconciliation_reason: "low confidence (0.4); leaving open",
      }),
    ).toBe("low confidence (0.4); leaving open");
    expect(
      findingOverrideNote({
        status: "still_valid",
        reconciliation_reason: "the leak is still on the current SHA",
      }),
    ).toBe("the leak is still on the current SHA");
    expect(
      findingOverrideNote({
        status: "resolved",
        reconciliation_reason: "GitHub thread already resolved",
      }),
    ).toBe("GitHub thread already resolved");
  });

  it("marks specialist findings unconfirmed until the aggregator finishes", () => {
    const store = seededStore();
    const aggregating = store.listJobs(20).find((row) => row.state === "aggregating");
    expect(aggregating).toBeTruthy();
    const html = renderJob(aggregating!, store.listReviewerRuns(aggregating!.id), store.listLogs(aggregating!.id));
    expect(html).toContain("Unconfirmed specialist observations");
    expect(html).toContain("is-unconfirmed");
    expect(html).toContain("src/routes/v1.ts:12");
    expect(html).toContain("findings-provisional");
  });

  it("puts the technical failure first on a failed job and warns on stale SHAs", () => {
    const store = seededStore();
    const failed = store.listJobs(20).find((row) => row.state === "failed");
    const stale = store.listJobs(20).find((row) => row.state === "stale");
    expect(failed && stale).toBeTruthy();
    const failedHtml = renderJob(failed!, store.listReviewerRuns(failed!.id), store.listLogs(failed!.id));
    expect(failedHtml).toContain("OpenCode exited 1 after 2 attempts");
    expect(failedHtml.indexOf("OpenCode exited 1")).toBeLessThan(failedHtml.indexOf("Validation error:"));
    expect(failedHtml).toContain('class="section-head"');
    expect(failedHtml).toContain("Retry failed reviewer");
    expect(failedHtml).toContain(">Retry</button>");
    expect(failedHtml).toContain(`/jobs/${failed!.id}/retry`);
    expect(failedHtml.indexOf("Validation error:")).toBeLessThan(failedHtml.lastIndexOf(">Retry</button>"));
    const staleHtml = renderJob(stale!, store.listReviewerRuns(stale!.id), store.listLogs(stale!.id));
    expect(staleHtml).toContain("newer head SHA");
    expect(staleHtml).toContain("pull request");
    expect(staleHtml).toContain("6 / 6 reviewers done");
    expect(staleHtml).not.toContain(">Retry</button>");
  });

  it("embeds the CSRF token in every state-changing form when provided", () => {
    const store = seededStore();
    const failed = store.listJobs(20).find((row) => row.state === "failed")!;
    const token = "csrf-test-token";
    const html = renderJob(failed, store.listReviewerRuns(failed.id), store.listLogs(failed.id), {
      showLogout: true,
      csrfToken: token,
    });
    const inputs = html.match(/<input type="hidden" name="csrf_token" value="[^"]*"/g) ?? [];
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain(`name="csrf_token" value="${token}"/>`);
    const home = renderHome(store.listJobs(20), store, { showLogout: true, csrfToken: token });
    expect(home).toContain(`name="csrf_token" value="${token}"/>`);
    const bare = renderJob(failed, store.listReviewerRuns(failed.id), store.listLogs(failed.id));
    expect(bare).not.toContain('name="csrf_token"');
    expect(renderHome([], store)).not.toContain('name="csrf_token"');
  });
});

describe("job metrics", () => {
  it("sums tokens and groups findings by severity", () => {
    const store = seededStore();
    const job = store.listJobs(20).find((row) => row.pr_number === 412)!;
    const metrics = jobMetrics(job, store);
    expect(metrics.reviewersDone).toBe(6);
    expect(metrics.reviewersTotal).toBe(6);
    expect(metrics.findings.high).toBe(1);
    expect(metrics.findings.medium).toBe(1);
    expect(metrics.tokens).toBeGreaterThan(10_000);
    expect(metrics.cost).toBeGreaterThan(0.2);
    expect(metrics.usageComplete).toBe(true);
    expect(metrics.reasoningTokens).toBe(120);
    expect(metrics.cacheReadTokens).toBe(800);
    expect(formatTokens(12_400)).toMatch(/k$/);
    expect(formatCost(0.18)).toBe("$0.18");
  });

  it("treats specialist findings as unconfirmed until the aggregator is done", () => {
    const store = seededStore();
    const aggregating = store.listJobs(20).find((row) => row.state === "aggregating")!;
    const live = jobMetrics(aggregating, store);
    expect(live.findingsConfirmed).toBe(false);
    expect(live.findings.medium).toBe(1);
    const done = store.listJobs(20).find((row) => row.pr_number === 412)!;
    expect(jobMetrics(done, store).findingsConfirmed).toBe(true);
  });

  it("treats a run with usage_complete=0 as incomplete job usage", () => {
    const store = seededStore();
    const job = store.listJobs(20).find((row) => row.pr_number === 412)!;
    const run = store.listReviewerRuns(job.id)[0];
    store.patchReviewer(run.id, {
      usage_complete: 0,
      usage_warning: "Usage incomplete: stream ended without a matching step_finish",
    });
    const metrics = jobMetrics(job, store);
    expect(metrics.usageComplete).toBe(false);
    expect(metrics.usageWarning).toMatch(/incomplete/i);
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id));
    expect(html).toContain("incomplete");
    expect(html).toContain("step_finish");
  });
});

describe("poison alert card", () => {
  function jobByTitle(store: JobStore, title: string) {
    const job = store.listJobs(50).find((row) => row.pr_title === title);
    if (!job) throw new Error(`fixture job not found: ${title}`);
    return job;
  }

  it("hides the card entirely for ordinary (observation) jobs", () => {
    const store = seededStore();
    const job = jobByTitle(store, "Deprecate v1 list endpoint");
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id));
    expect(html).not.toContain("Poison alert");
  });

  it("renders only the internal channel for internal_only policies", () => {
    const store = seededStore();
    const job = jobByTitle(store, "Rotate billing webhook signing keys");
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id));
    const card = html.slice(html.indexOf("<h2>Poison alert</h2>"));
    expect(card).toContain("Poison alert");
    expect(card).toContain("laboratory re-check only");
    expect(card).toContain("Internal model");
    expect(card).toContain("Laboratory re-check finished");
    expect(card).not.toContain("External dispatch");
    expect(card).not.toContain("0 tokens");
  });

  it("renders both channels with badges when the policy requests them", () => {
    const store = seededStore();
    const job = store.listJobs(50).find((row) => row.poison_alert_policy === "internal_and_external");
    if (!job) throw new Error("fixture job not found: internal_and_external");
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id));
    const card = html.slice(html.indexOf("<h2>Poison alert</h2>"));
    expect(card).toContain("laboratory re-check, then external dispatch");
    expect(card).toContain("Internal model");
    expect(card).toContain("External dispatch");
    expect(card).toContain("Dispatched");
    expect(card).toContain("mention @repository-owner");
    // The routing reason belongs to the Routing card, not the escalation status.
    expect(card).not.toContain("Authentication flow changed");
  });

  it("renders external-only jobs without an internal block", () => {
    const store = seededStore();
    const job = jobByTitle(store, "Rotate billing webhook signing keys");
    store.patchJob(job.id, {
      poison_alert_policy: "external_only",
      internal_escalation_state: "not_requested",
      internal_escalation_model: null,
      internal_escalation_reason: null,
      external_dispatch_status: "dispatched",
      external_dispatch_targets: JSON.stringify([{ type: "command", recipient: "@oncall", command: "review" }]),
    });
    const updated = store.getJob(job.id)!;
    const html = renderJob(updated, store.listReviewerRuns(job.id), store.listLogs(job.id));
    expect(html).toContain("external dispatch only");
    expect(html).toContain("External dispatch");
    expect(html).toContain("Dispatched");
    expect(html).toContain("command @oncall review");
    expect(html).not.toContain("Internal model");
  });

  it("shows queued channels while an in-progress job has not reached them", () => {
    const store = seededStore();
    const job = jobByTitle(store, "Deprecate v1 list endpoint");
    store.patchJob(job.id, {
      poison_alert_policy: "internal_and_external",
      routing_profile: "poison-alert",
      internal_escalation_state: "not_requested",
      external_dispatch_status: "not_requested",
    });
    const updated = store.getJob(job.id)!;
    const html = renderJob(updated, store.listReviewerRuns(job.id), store.listLogs(job.id));
    expect(html).toContain("laboratory re-check, then external dispatch");
    expect(html).toContain("Waiting on specialists and the aggregator");
    expect(html).toContain("Dispatches after the GitHub review is posted");
  });

  it("gives sniffing jobs their own state, flavor, and running lab badge", () => {
    const store = seededStore();
    const job = jobByTitle(store, "Add deferred payment capture endpoint");
    expect(job.state).toBe("sniffing");
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id));
    expect(html).toContain("Sniffing");
    expect(html).toContain("Laboratory re-check for PR #96");
    expect(html).toContain("Laboratory model in flight");
    expect(html).toContain("Internal model");
    expect(html).toContain("External dispatch");
    expect(html).toContain("Dispatches after the GitHub review is posted");
    expect(html).not.toContain("Aggregating");
  });

  it("keeps aggregating flavor distinct from sniffing", () => {
    const store = seededStore();
    const aggregating = jobByTitle(store, "Deprecate v1 list endpoint");
    const html = renderJob(aggregating, store.listReviewerRuns(aggregating.id), store.listLogs(aggregating.id));
    expect(html).toContain("Aggregation in progress");
    expect(html).not.toContain("Laboratory re-check of the aggregated findings");
    expect(html).not.toContain("Laboratory re-check for PR #88");
  });

  it("renders manual-policy jobs as waiting, or both channels once escalate is requested", () => {
    const store = seededStore();
    const job = jobByTitle(store, "Rotate billing webhook signing keys");
    store.patchJob(job.id, {
      poison_alert_policy: "manual",
      internal_escalation_state: "not_requested",
      manual_escalate_requested: 0,
    });
    const waiting = renderJob(store.getJob(job.id)!, store.listReviewerRuns(job.id), store.listLogs(job.id));
    const waitingCard = waiting.slice(waiting.indexOf("<h2>Poison alert</h2>"));
    expect(waitingCard).toContain("waiting for a manual @maomao escalate");
    expect(waitingCard).not.toContain("Internal model");
    expect(waitingCard).not.toContain("External dispatch");

    store.patchJob(job.id, { manual_escalate_requested: 1 });
    const requested = renderJob(store.getJob(job.id)!, store.listReviewerRuns(job.id), store.listLogs(job.id));
    const requestedCard = requested.slice(requested.indexOf("<h2>Poison alert</h2>"));
    // Manual escalate triggers the external dispatch; the internal pass is policy-gated elsewhere.
    expect(requestedCard).toContain("manual escalate requested");
    expect(requestedCard).toContain("external dispatch only");
    expect(requestedCard).toContain("External dispatch");
    expect(requestedCard).not.toContain("Internal model");
  });

  it("renders a pending policy for a poison-alert profile before the pipeline records one", () => {
    const store = seededStore();
    const job = jobByTitle(store, "Deprecate v1 list endpoint");
    store.patchJob(job.id, { routing_profile: "poison-alert", poison_alert_policy: null });
    const html = renderJob(store.getJob(job.id)!, store.listReviewerRuns(job.id), store.listLogs(job.id));
    expect(html).toContain("Poison alert");
    expect(html).not.toContain("Policy</strong> manual");
    expect(html).toContain("Policy</strong> pending");
  });
});

describe("finding mini diffs", () => {
  const hunk = "@@ -50,6 +50,7 @@\n   const prior = 1;\n+  console.log(\"leak\", secret);\n   return token();";

  it("renders the stored hunk, permalink, and stale marking on finding cards", () => {
    const store = seededStore();
    const job = store.listJobs(50).find((row) => row.state === "completed")!;
    store.upsertFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      fingerprint: "fp-hunk-test",
      status: "open",
      reviewedSha: job.head_sha,
      currentSha: job.head_sha,
      originalPath: "src/auth.ts",
      originalLine: 51,
      currentPath: "src/auth.ts",
      currentLine: 51,
      summary: "secret leaks into the log",
      severity: "high",
    });
    store.upsertFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      fingerprint: "fp-hunk-test",
      status: "open",
      reviewedSha: job.head_sha,
      summary: "secret leaks into the log",
      diffHunk: hunk,
    });
    const row = store.listFindings(job.repo_full_name, job.pr_number).find((f) => f.fingerprint === "fp-hunk-test")!;

    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), {
      prFindings: [row],
      prHeadSha: job.head_sha,
    });
    expect(html).toContain("Show diff");
    expect(html).toContain("diff-panel");
    // Vendor container: the @pierre/diffs bundle upgrades this in the browser.
    expect(html).toContain('data-pierre-diff');
    expect(html).toContain('data-path="src/auth.ts"');
    expect(html).toContain('data-severity="high"');
    expect(html).toContain('<script type="text/plain" class="diff-raw">');
    expect(html).toContain("+  console.log(&quot;leak&quot;, secret);");
    expect(html).toContain('class="diff-add"');
    expect(html).toContain('class="diff-ctx"');
    expect(html).toContain(`blob/${job.head_sha}/src/auth.ts#L51`);
    expect(html).toContain("view at this SHA");
    expect(html).not.toContain("Older SHA");

    const staleHtml = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), {
      prFindings: [row],
      prHeadSha: "0000000newersha",
    });
    expect(staleHtml).toContain("Older SHA");
    expect(staleHtml).toContain("is-stale-sha");
  });

  it("escapes diff content so findings cannot inject HTML", () => {
    const store = seededStore();
    const job = store.listJobs(50).find((row) => row.state === "completed")!;
    store.upsertFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      fingerprint: "fp-xss-test",
      status: "open",
      reviewedSha: job.head_sha,
      summary: "script injection attempt",
      diffHunk: '@@ -1 +1 @@\n+<script>alert(1)</script><img src=x onerror=alert(2)>',
    });
    const row = store.listFindings(job.repo_full_name, job.pr_number).find((f) => f.fingerprint === "fp-xss-test")!;
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), {
      prFindings: [row],
      prHeadSha: job.head_sha,
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("explains when no diff preview is possible instead of guessing", () => {
    const store = seededStore();
    const job = store.listJobs(50).find((row) => row.state === "completed")!;
    store.upsertFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      fingerprint: "fp-no-hunk",
      status: "open",
      reviewedSha: job.head_sha,
      currentPath: "assets/logo.png",
      summary: "binary asset finding",
    });
    store.upsertFinding({
      repoFullName: job.repo_full_name,
      prNumber: job.pr_number,
      fingerprint: "fp-no-hunk",
      status: "open",
      reviewedSha: job.head_sha,
      summary: "binary asset finding",
      diffNote: "binary",
    });
    const row = store.listFindings(job.repo_full_name, job.pr_number).find((f) => f.fingerprint === "fp-no-hunk")!;
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), {
      prFindings: [row],
      prHeadSha: job.head_sha,
    });
    expect(html).toContain("No diff preview: binary file.");
    expect(html).not.toContain("Show diff");
  });
});

describe("config pages", () => {
  const revision = {
    id: 3,
    name: "default",
    status: "draft",
    definition: { name: "default", reviewers: [{ role: "correctness" }], minPublishableSeverity: "info" },
    note: null,
    created_by: "octocat",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    activated_at: "2026-01-01T00:00:00Z",
    editSeq: 2,
  };

  it("renders revisions, write controls only for operators, and escapes definitions", () => {
    const data = {
      revisions: [revision],
      audit: [],
      csrfToken: "tok",
      canWrite: true,
      profileEditor: { knownRoles: [], modelCatalog: [] },
    };
    const html = renderProfilesPage(data);
    expect(html).toContain("Review profiles");
    expect(html).toContain('href="/config/prompts"');
    expect(html).toContain("Specialist prompts");
    // The definition JSON is rendered escaped inside the summary <pre>.
    expect(html).toContain("&quot;reviewers&quot;");
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain("Activate");
    // Drafts link out to the dedicated edit page rather than editing inline.
    expect(html).toContain('href="/config/profiles/drafts/3/edit"');

    const readonly = renderProfilesPage({ ...data, canWrite: false, csrfToken: undefined });
    expect(readonly).not.toContain("Activate");
    expect(readonly).not.toContain('name="csrf_token"');
    expect(readonly).toContain("requires an operator OAuth identity");
  });

  it("renders the draft editor on its own page with the definition decoded", () => {
    const html = renderDraftEditPage({
      revision,
      csrfToken: "tok",
      canWrite: true,
      profileEditor: { knownRoles: [], modelCatalog: [] },
    });
    expect(html).toContain('action="/config/drafts/3"');
    expect(html).toContain('name="expected_edit_seq" value="2"');
    expect(html).toContain('href="/config/profiles"');
  });

  it("renders the audit trail on its own page", () => {
    const html = renderConfigAuditPage({
      revisions: [],
      audit: [{ id: 1, action: "draft_created", actor: "octocat", revision_id: 3, detail: "draft of default", created_at: "2026-01-01T00:00:00Z" }],
      canWrite: true,
    });
    expect(html).toContain("Configuration audit");
    expect(html).toContain("draft_created");
    expect(html).toContain("octocat");
  });

  it("renders the landing page without any write forms", () => {
    const html = renderConfigPage({
      revisions: [],
      audit: [],
      canWrite: true,
      effectiveConfig: [
        { group: "g", label: "Reviewer model", value: "openai/gpt-4o", source: "environment", envKey: "OPENCODE_REVIEWER_MODEL" },
        { group: "g", label: "Reviewer count", value: "4", source: "default" },
      ],
    });
    expect(html).toContain("Review configuration");
    expect(html).toContain('href="/config/profiles"');
    expect(html).toContain('href="/health"');
    expect(html).not.toContain('name="csrf_token"');
    // Each row carries a "how to change this" pointer to where it lives.
    expect(html).toContain("OPENCODE_REVIEWER_MODEL");
    expect(html).toContain("config-hint");
  });
});

describe("cat-hunt flavor", () => {
  it("adds the hunt summary and per-reviewer flavor without hiding technical data", () => {
    const store = seededStore();
    const job = store.listJobs(50).find((row) => row.pr_number === 412)!;
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), { uiFlavor: "apothecary" });
    // Technical names and metrics stay first.
    expect(html).toContain("acme/ledger #412");
    expect(html).toContain("forge-mark");
    expect(html).not.toContain("[GitHub]");
    expect(html).toContain("Correctness / regression hunter");
    expect(html).toContain("6 cats returned from the diff · 3 findings");
    // Per-reviewer flavor: done with findings vs done clean.
    expect(html).toContain("Returned with 1 finding(s)");
    expect(html).toContain("Returned without a catch");
    // Hunter tooltip on the correctness role.
    expect(html).toContain("Catches bugs attempting to reach production.");
  });

  it("keeps running reviewers hunting and plain mode flavor-free", () => {
    const store = seededStore();
    const running = store.listJobs(50).find((row) => row.state === "reviewing")!;
    const hunting = renderJob(running, store.listReviewerRuns(running.id), store.listLogs(running.id), {
      uiFlavor: "apothecary",
    });
    expect(hunting).toContain("Hunting through the diff…");
    const plain = renderJob(running, store.listReviewerRuns(running.id), store.listLogs(running.id), {
      uiFlavor: "plain",
    });
    expect(plain).not.toContain("Hunting through the diff…");
    expect(plain).not.toContain("cats returned");
    expect(plain).toContain("Reviewers");
  });

  it("keeps failed runs technical with no hunt copy", () => {
    const store = seededStore();
    const job = store.listJobs(50).find((row) => row.pr_number === 412)!;
    const run = store.listReviewerRuns(job.id)[0];
    store.patchReviewer(run.id, { state: "failed", validation_error: "runner crashed" });
    const updated = store.getJob(job.id)!;
    const failedHtml = renderJob(updated, store.listReviewerRuns(job.id), store.listLogs(job.id), {
      uiFlavor: "apothecary",
    });
    expect(failedHtml).toContain("runner crashed");
    expect(failedHtml).not.toContain("Hunting through the diff…");
  });

  it("keeps queue card flavor and job-state labels technical", () => {
    const store = seededStore();
    const html = renderHome(store.listJobs(50), store, { uiFlavor: "apothecary" });
    expect(html).toContain("Examining PR #");
    const state = jobStateLabel("reviewing");
    expect(state.text).toBe("Reviewing");
  });
});

describe("pancake easter egg", () => {
  const HEAD = "head222head222head222head222head22222";

  function enqueue(store: JobStore, prNumber: number) {
    return store.enqueue({
      repoFullName: "acme/pancakes",
      repoOwner: "acme",
      repoName: "pancakes",
      installationId: 42,
      prNumber,
      prTitle: `PR ${prNumber}`,
      prBody: "",
      prHtmlUrl: "https://github.com/acme/pancakes",
      prAuthor: "octocat",
      baseSha: HEAD,
      headSha: HEAD,
      baseRef: "main",
      headRef: `pr-${prNumber}`,
      reviewers: [],
    });
  }

  it("counts one pancake per completed job, derived from the store", () => {
    const store = new JobStore(openDb(":memory:"));
    expect(store.pancakeStats()).toEqual({ count: 0, latestId: 0 });
    const first = enqueue(store, 1);
    store.setJobState(first.job.id, "completed", { finished_at: new Date().toISOString() });
    const second = enqueue(store, 2);
    expect(store.pancakeStats()).toEqual({ count: 1, latestId: first.job.id });
    store.setJobState(second.job.id, "completed", { finished_at: new Date().toISOString() });
    expect(store.pancakeStats()).toEqual({ count: 2, latestId: second.job.id });
    // Terminal but not success: cancelled and failed jobs earn no pancake.
    const third = enqueue(store, 3);
    store.setJobState(third.job.id, "failed", { failure_reason: "boom", finished_at: new Date().toISOString() });
    expect(store.pancakeStats()).toEqual({ count: 2, latestId: second.job.id });
  });

  it("renders an apothecary chip with the count and trigger attributes", () => {
    const store = seededStore();
    const html = renderHome(store.listJobs(50), store);
    expect(html).toContain("pancake-chip");
    expect(html).toContain("pancakes earned");
    expect(html).toMatch(/data-pancake-latest="\d+"/);
    expect(html).toContain('data-pancake-latest="' + store.pancakeStats().latestId + '"');
  });

  it("stays hidden at zero completions and in plain flavor", () => {
    const store = new JobStore(openDb(":memory:"));
    expect(renderHome([], store)).not.toContain("pancakes earned");
    const earned = enqueue(store, 1).job.id;
    store.setJobState(earned, "completed", { finished_at: new Date().toISOString() });
    expect(renderHome(store.listJobs(5), store, { uiFlavor: "plain" })).not.toContain("pancakes earned");
    const html = renderHome(store.listJobs(5), store, { uiFlavor: "apothecary" });
    expect(html).toContain("1 pancake earned");
  });
});

describe("repository health scan UI", () => {
  const HEAD = "head111head111head111head111head11111";

  function scanJobStore() {
    const store = new JobStore(openDb(":memory:"));
    const created = store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      prNumber: 0,
      prTitle: "Repository health scan (main)",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets",
      prAuthor: "octocat",
      baseSha: HEAD,
      headSha: HEAD,
      baseRef: "main",
      headRef: "main",
      jobType: "health_scan",
      scanBranch: "main",
      reviewers: [],
    });
    store.setJobState(created.job.id, "completed", { finished_at: new Date().toISOString() });
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 0,
      fingerprint: "fpscan0000000001",
      status: "open",
      reviewedSha: HEAD,
      currentPath: "src/a.ts",
      currentLine: 7,
      category: "correctness",
      summary: "Unhandled promise rejection",
      body: "rejects without a handler",
      severity: "high",
      confidence: 0.8,
      lastJobId: created.job.id,
    });
    return { store, job: store.getJob(created.job.id)! };
  }

  it("renders the confirmation page with branch, exact SHA, and effective limits", () => {
    const html = renderScanConfirmPage({
      identity: { login: "octocat", avatarUrl: null },
      csrfToken: "tok",
      repo: "acme/widgets",
      branch: "main",
      sha: HEAD,
      profileRevision: { id: 3, name: "baseline" },
      severityFloor: "medium",
      limits: { diffCapBytes: 1048576, reviewerTimeoutMs: 600_000, maxRetries: 1 },
    });
    expect(html).toContain("Confirm repository health scan");
    expect(html).toContain(HEAD);
    expect(html).toContain(`name="sha" value="${HEAD}"`);
    expect(html).toContain('name="branch" value="main"');
    expect(html).toContain('name="revision_id" value="3"');
    expect(html).toContain('aria-label="Run repository health scan"');
    expect(html).toContain("Sniff sniff");
    expect(html).toContain("1.0 MiB");
    expect(html).toContain("Severity floor");
    expect(html).toContain("medium");
    expect(html).toContain('href="/scan"');
    expect(html).toContain("account-menu");
    expect(html).toContain("octocat");
  });

  it("warns and re-confirms when the confirmed SHA is no longer the branch head", () => {
    const html = renderScanConfirmPage({
      csrfToken: "tok",
      repo: "acme/widgets",
      branch: "main",
      sha: HEAD,
      profileRevision: null,
      severityFloor: "info",
      limits: { diffCapBytes: null, reviewerTimeoutMs: 60_000, maxRetries: 0 },
      notice: { kind: "sha", fromSha: "oldsha" },
    });
    expect(html).toContain("moved since you confirmed");
    expect(html).toContain("oldsha");
    expect(html).toContain(HEAD);
    expect(html).toContain("no cap");
    expect(html).toContain('name="revision_id" value=""');
  });

  it("warns when the confirmed branch name is stale", () => {
    const html = renderScanConfirmPage({
      csrfToken: "tok",
      repo: "acme/widgets",
      branch: "main",
      sha: HEAD,
      profileRevision: null,
      severityFloor: "info",
      limits: { diffCapBytes: 4096, reviewerTimeoutMs: 60_000, maxRetries: 0 },
      notice: { kind: "branch", fromBranch: "develop" },
    });
    expect(html).toContain("you confirmed (develop)");
    expect(html).not.toContain("The scan reviews this exact revision");
  });

  it("renders the scan page with identity, nav link, and the branded scan action", () => {
    const html = renderScanPage({
      canScan: true,
      identity: { login: "octocat", avatarUrl: null },
      csrfToken: "tok",
      issueCreationEnabled: false,
      profileRevision: null,
      recentScans: [],
    });
    expect(html).toContain('aria-label="Run repository health scan"');
    expect(html).toContain("Sniff sniff");
    expect(html).toContain("account-menu");
    expect(html).toContain("octocat");
    expect(html).toContain('href="/scan"');
    expect(html).toContain("GITHUB_ISSUE_CREATION_ENABLED=false");
  });

  it("titles scan jobs by revision instead of pull number and shows finding confidence", () => {
    const { store, job } = scanJobStore();
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), {
      prFindings: store.listFindings("acme/widgets", 0),
    });
    expect(html).toContain("Health scan · acme/widgets @ head111head1");
    expect(html).not.toContain("acme/widgets#0</h1>");
    expect(html).toContain("Aggregator confidence: 80%");
  });

  it("offers issue creation only for findings above the publication bar", () => {
    const { store, job } = scanJobStore();
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), {
      prFindings: store.listFindings("acme/widgets", 0),
      csrfToken: "tok",
      scanIssueCreation: {
        enabled: true,
        jobId: 9,
        findings: [
          {
            fingerprint: "fpworthy00000001",
            summary: "Unhandled promise rejection",
            severity: "high",
            confidence: 0.9,
            agreed: ["correctness", "security"],
            worthy: true,
          },
          {
            fingerprint: "fpspec0000000001",
            summary: "Might be a race",
            severity: "low",
            confidence: 0.4,
            agreed: ["correctness"],
            worthy: false,
            unworthyReason: "confidence 40% is below the 70% publication bar",
          },
        ],
      },
    });
    expect(html).toContain("Create GitHub issues");
    expect(html).toContain('type="checkbox" name="fp[]" value="fpworthy00000001" checked');
    expect(html).toContain('value="fpspec0000000001" disabled');
    expect(html).toContain("Not offered: confidence 40% is below the 70% publication bar");
    expect(html).toContain('action="/scan/issues/preview"');
    expect(html).toContain('name="job_id" value="9"');
  });

  it("hides hidden markers on finding cards and shows a provenance note instead", () => {
    const { store, job } = scanJobStore();
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 0,
      fingerprint: "fpmarker000000001",
      status: "open",
      reviewedSha: HEAD,
      currentPath: "src/dirty.ts",
      currentLine: 9,
      summary: `<!-- maomao-finding id=fpmarker000000001 sha=${HEAD} -->\n**info**: dirty summary`,
      body: "dirty body <!-- maomao-finding id=x sha=y -->",
      severity: "low",
      confidence: 0.5,
      lastJobId: job.id,
    });
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), {
      prFindings: store.listFindings("acme/widgets", 0),
    });
    expect(html).not.toContain("<!-- maomao-finding");
    expect(html).not.toContain("**info**:");
    expect(html).toContain("dirty summary");
    expect(html).toContain("dirty body");
    // The marker's info becomes a small note at the bottom of the card.
    expect(html).toContain("Maomao finding");
    expect(html).toContain("fpmarker000000001");
    expect(html).toContain("reported at");
    expect(html).toContain("head111head1");
  });

  it("renders the issue preview with the proposed body, skips, and confirm action", () => {
    const html = renderScanIssuePreviewPage({
      identity: { login: "octocat", avatarUrl: null },
      csrfToken: "tok",
      job: { id: 9, repoFullName: "acme/widgets", headSha: HEAD },
      items: [
        {
          fingerprint: "fpworthy00000001",
          severity: "high",
          title: "[maomao] HIGH: Unhandled promise rejection",
          body: `<!-- maomao-scan-issue fpworthy00000001 @ ${HEAD} -->\n\n**HIGH** — rejects without a handler`,
          agreed: ["correctness", "security"],
          duplicates: [{ title: "promise rejects unhandled", url: "https://github.com/acme/widgets/issues/7" }],
        },
        {
          fingerprint: "fpdedup000000001",
          severity: "medium",
          title: "[maomao] MEDIUM: Already tracked",
          body: `<!-- maomao-scan-issue fpdedup000000001 @ ${HEAD} -->`,
          agreed: [],
          skip: {
            reason: "a Maomao issue already tracks this finding",
            url: "https://github.com/acme/widgets/issues/42",
          },
          duplicates: [],
        },
      ],
      rejected: ["Might be a race: confidence 40% is below the 70% publication bar"],
    });
    expect(html).toContain("[maomao] HIGH: Unhandled promise rejection");
    expect(html).toContain("Issues: write");
    expect(html).toContain("a Maomao issue already tracks this finding");
    expect(html).toContain("https://github.com/acme/widgets/issues/42");
    expect(html).toContain("promise rejects unhandled");
    expect(html).toContain("Might be a race: confidence 40% is below the 70% publication bar");
    expect(html).toContain('aria-label="Create GitHub issues for selected findings"');
    expect(html).toContain('name="fp[]" value="fpworthy00000001"');
    expect(html).not.toContain('name="fp[]" value="fpdedup000000001"');
    expect(html).toContain("Create 1 issue</button>");
  });
});


describe("scan repository typeahead", () => {
  const api = new Function(
    `${TYPEAHEAD_JS}\n;return globalThis.__maomaoTypeahead;`,
  )() as {
    filterRepos: (repos: Array<{ fullName: string }>, query: string) => Array<{ fullName: string }>;
  };
  const REPOS = [
    { fullName: "acme/widgets" },
    { fullName: "acme/wrenches" },
    { fullName: "beta/tools" },
    ...Array.from({ length: 14 }, (_, i) => ({ fullName: `gamma/repo${i}` })),
  ];

  it("ranks prefix matches before substring matches and caps the list", () => {
    const matches = api.filterRepos(REPOS, "a");
    // Full names starting with the query beat substring-only matches.
    expect(matches[0]?.fullName).toBe("acme/widgets");
    expect(matches[1]?.fullName).toBe("acme/wrenches");
    expect(matches[2]?.fullName).toBe("beta/tools");
    expect(matches).toHaveLength(12); // capped for the dropdown
  });

  it("matches substrings and returns everything for an empty query", () => {
    expect(api.filterRepos(REPOS, "beta")).toEqual([{ fullName: "beta/tools" }]);
    expect(api.filterRepos(REPOS, "").length).toBe(12);
    expect(api.filterRepos(REPOS, "nomatch-xyz")).toEqual([]);
  });

  it("serves a script with a debug hook and DOM-safe rendering", () => {
    expect(TYPEAHEAD_JS).toContain("__maomaoTypeahead");
    expect(TYPEAHEAD_JS).toContain('credentials: "same-origin"');
    expect(TYPEAHEAD_JS).not.toContain("innerHTML");
    expect(TYPEAHEAD_JS).not.toMatch(/https?:\/\//);
  });

  it("renders the scan form as a themed combobox loading the typeahead", () => {
    const html = renderScanPage({
      canScan: true,
      identity: { login: "octocat", avatarUrl: null },
      csrfToken: "tok",
      issueCreationEnabled: false,
      profileRevision: null,
      recentScans: [],
    });
    expect(html).toContain('data-repo-typeahead');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="repo-listbox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('<script src="/assets/typeahead.js" defer></script>');
    expect(html).toContain('aria-label="Run repository health scan"');
    // The wrap lives inside the label so `.trigger label { flex: 1 }` gives the
    // combobox (and its absolutely positioned listbox) the full field width.
    const labelAt = html.indexOf('for="scan-repo-input"');
    const wrapAt = html.indexOf("typeahead-wrap");
    const labelEnd = html.indexOf("</label>", labelAt);
    expect(labelAt).toBeGreaterThan(-1);
    expect(wrapAt).toBeGreaterThan(labelAt);
    expect(wrapAt).toBeLessThan(labelEnd);
  });
});

describe("scan typeahead combobox (fake DOM)", () => {
  // Minimal DOM covering everything TYPEAHEAD_JS touches — no jsdom dependency.
  function fakeElement(tag: string): any {
    const classes = new Set<string>();
    const attrs = new Map<string, string>();
    const listeners = new Map<string, Array<(event?: unknown) => void>>();
    const element: any = {
      tag,
      id: "",
      value: "",
      hidden: false,
      children: [],
      className: "",
      parentNode: undefined as any,
      scrollIntoView: undefined as unknown as () => void,
      classList: {
        toggle(name: string, force?: boolean) {
          const next = force ?? !classes.has(name);
          if (next) classes.add(name);
          else classes.delete(name);
          return next;
        },
        contains: (name: string) => classes.has(name),
      },
      appendChild(child: any) {
        element.children.push(child);
        child.parentNode = element;
        return child;
      },
      contains(node: any) {
        if (node === element) return true;
        return element.children.some((child: any) => child === node || child.contains?.(node));
      },
      addEventListener(type: string, fn: (event?: unknown) => void) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      fire(type: string, event: any = {}) {
        event.target ??= element;
        event.preventDefault ??= vi.fn();
        for (const fn of listeners.get(type) ?? []) fn(event);
      },
      listenerNames: () => [...listeners.keys()],
      getAttribute: (name: string) => attrs.get(name),
      setAttribute: (name: string, value: string) => void attrs.set(name, String(value)),
      removeAttribute: (name: string) => void attrs.delete(name),
      focus: vi.fn(),
    };
    Object.defineProperty(element, "textContent", {
      get: () => element._text ?? "",
      set: (value: string) => {
        element._text = value;
        element.children = [];
      },
    });
    return element;
  }

  const REPOS = [{ fullName: "acme/widgets" }, { fullName: "acme/zebra" }, { fullName: "beta/tools" }];

  async function boot(repos: Array<{ fullName: string }> | null, fetchOk = true) {
    const input = fakeElement("input");
    input.id = "scan-repo-input";
    input.setAttribute("aria-controls", "repo-listbox");
    const listbox = fakeElement("ul");
    listbox.id = "repo-listbox";
    listbox.hidden = true; // the server-rendered listbox ships with the hidden attribute
    const docListeners = new Map<string, Array<(event?: unknown) => void>>();
    const doc: any = {
      readyState: "complete",
      querySelector: (selector: string) => (selector === "[data-repo-typeahead]" ? input : null),
      getElementById: (id: string) => (id === "repo-listbox" ? listbox : null),
      createElement: (tag: string) => fakeElement(tag),
      addEventListener: (type: string, fn: (event?: unknown) => void) => {
        const list = docListeners.get(type) ?? [];
        list.push(fn);
        docListeners.set(type, list);
      },
    };
    const payload: any = fetchOk && repos ? { ok: true, json: async () => ({ repositories: repos }) } : { ok: false, json: async () => ({}) };
    const fetchFn = vi.fn(async () => payload as Response);
    new Function("globalThis", "document", "fetch", `${TYPEAHEAD_JS}\n;return globalThis.__maomaoTypeahead;`)(
      globalThis,
      doc,
      fetchFn,
    );
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the fetch chain settle
    const docFire = (type: string, event?: any) => {
      for (const fn of docListeners.get(type) ?? []) fn(event);
    };
    return { input, listbox, docFire };
  }

  it("opens on focus, renders options, and auto-activates nothing", async () => {
    const { input, listbox } = await boot(REPOS);
    input.fire("focus");
    expect(listbox.hidden).toBe(false);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(listbox.children).toHaveLength(3);
    // No auto-activation: typing + Enter must submit the typed value (review finding).
    expect(input.getAttribute("aria-activedescendant")).toBeUndefined();
    expect(listbox.children.some((child: any) => child.classList.contains("is-active"))).toBe(false);
  });

  it("does not intercept Enter before the operator navigated with arrows", async () => {
    const { input, listbox } = await boot(REPOS);
    input.fire("focus");
    input.value = "acme/zebra";
    input.fire("input");
    const preventDefault = vi.fn();
    input.fire("keydown", { key: "Enter", preventDefault });
    // The typed value stands; the form submits naturally.
    expect(preventDefault).not.toHaveBeenCalled();
    expect(input.value).toBe("acme/zebra");
    expect(listbox.hidden).toBe(false);
  });

  it("navigates with arrows and selects with Enter without submitting", async () => {
    const { input, listbox } = await boot(REPOS);
    input.fire("focus");
    input.fire("keydown", { key: "ArrowDown", preventDefault: vi.fn() });
    expect(input.getAttribute("aria-activedescendant")).toContain("scan-repo-input-opt-");
    expect(listbox.children[0]?.classList.contains("is-active")).toBe(true);
    input.fire("keydown", { key: "ArrowDown", preventDefault: vi.fn() });
    input.fire("keydown", { key: "Enter", preventDefault: vi.fn() });
    expect(input.value).toBe("acme/zebra");
    expect(listbox.hidden).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.focus).toHaveBeenCalled();
  });

  it("closes on Escape and on click-away", async () => {
    const { input, listbox, docFire } = await boot(REPOS);
    input.fire("focus");
    input.fire("keydown", { key: "Escape" });
    expect(listbox.hidden).toBe(true);
    input.fire("focus");
    expect(listbox.hidden).toBe(false);
    docFire("click", { target: { tag: "other" } });
    expect(listbox.hidden).toBe(true);
  });

  it("leaves the input free-form when the endpoint fails or returns nothing", async () => {
    const failed = await boot(null, false);
    failed.input.fire("focus");
    expect(failed.listbox.hidden).toBe(true); // no listeners wired, nothing opens
    expect(failed.input.listenerNames()).toEqual([]);

    const empty = await boot([]);
    empty.input.fire("focus");
    expect(empty.listbox.hidden).toBe(true);
    expect(empty.input.listenerNames()).toEqual([]);
  });
});

describe("dequeue and cancel controls", () => {
  function jobStore() {
    return new JobStore(openDb(":memory:"));
  }

  function seed(jobStore: JobStore, prNumber: number, headSha: string) {
    return jobStore.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber,
      prTitle: "Add a feature",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets/pull/9",
      prAuthor: "dev",
      baseSha: "b",
      headSha,
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    }).job.id;
  }

  it("shows Dequeue on queued cards, Cancel review on live cards, nothing on terminal cards", () => {
    const store = jobStore();
    const queued = seed(store, 1, "q");
    const reviewing = seed(store, 2, "r");
    store.setJobState(reviewing, "reviewing");
    const completed = seed(store, 3, "c");
    store.setJobState(completed, "completed");
    const html = renderHome(store.listJobs(20), store, { csrfToken: "tok-123" });

    expect(html).toContain(`<form class="dequeue" method="post" action="/jobs/${queued}/dequeue">`);
    expect(html).toContain('class="cancel-review"');
    expect(html).toContain(`/jobs/${queued}/dequeue`);
    expect(html).toContain(`/jobs/${reviewing}/cancel`);
    // Terminal jobs must not expose an active control.
    expect(html).not.toContain(`/jobs/${completed}/dequeue`);
    expect(html).not.toContain(`/jobs/${completed}/cancel`);
    expect(html).toContain('value="tok-123"');
  });

  it("shows job-level actions on the job page for queued and live jobs only", () => {
    const store = jobStore();
    const queued = seed(store, 1, "q");
    const html = renderJob(store.getJob(queued)!, store.listReviewerRuns(queued), store.listLogs(queued), {
      csrfToken: "tok-123",
    });
    expect(html).toContain(`<form class="dequeue" method="post" action="/jobs/${queued}/dequeue">`);
    expect(html).toContain(`/jobs/${queued}/dequeue`);
    expect(html).toContain("Removes this review from the queue");

    const reviewing = seed(store, 2, "r");
    store.setJobState(reviewing, "reviewing");
    const liveHtml = renderJob(store.getJob(reviewing)!, store.listReviewerRuns(reviewing), store.listLogs(reviewing), {});
    expect(liveHtml).toContain('class="cancel-review"');
    expect(liveHtml).toContain(`/jobs/${reviewing}/cancel`);
    expect(liveHtml).toContain("Cancel review");
  });

  it("renders a reason-aware cancelled banner that never reads as a failure", () => {
    const store = jobStore();
    const merged = seed(store, 1, "m");
    store.cancelJobs({ jobId: merged }, "pr_merged", null);
    const html = renderJob(store.getJob(merged)!, store.listReviewerRuns(merged), store.listLogs(merged), {});
    expect(html).toContain("Cancelled — PR merged");
    expect(html).toContain("View the merged pull request");
    expect(html).not.toContain("role=\"alert\"");
    expect(html).not.toContain("/dequeue");
    expect(html).not.toContain("/cancel");

    const dequeued = seed(store, 2, "d");
    store.cancelJobs({ jobId: dequeued }, "manual_dequeue", "octocat");
    const dequeuedHtml = renderJob(store.getJob(dequeued)!, store.listReviewerRuns(dequeued), store.listLogs(dequeued), {});
    expect(dequeuedHtml).toContain("Dequeued by octocat");
  });
});

describe("cancelled banner honesty", () => {
  function jobStore() {
    return new JobStore(openDb(":memory:"));
  }

  function seed(jobStore: JobStore, prNumber: number, headSha: string) {
    return jobStore.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 1,
      prNumber,
      prTitle: "Add a feature",
      prBody: "",
      prHtmlUrl: "https://github.com/acme/widgets/pull/9",
      prAuthor: "dev",
      baseSha: "b",
      headSha,
      baseRef: "main",
      headRef: "f",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    }).job.id;
  }

  it("does not claim nothing was published when a review was already posted", () => {
    const store = jobStore();
    const id = seed(store, 4, "p");
    store.setJobState(id, "publishing");
    store.patchJob(id, { github_review_id: "123", github_review_url: "https://github.com/acme/widgets/pull/9#review-123" });
    store.cancelJobs({ jobId: id }, "manual_cancel", "octocat");
    const html = renderJob(store.getJob(id)!, store.listReviewerRuns(id), store.listLogs(id), {});
    expect(html).toContain("the posted review may be stale");
    expect(html).toContain("View the posted review");
    expect(html).not.toContain("nothing was published");
  });

  it("renders manual_cancel copy with the actor, and an honest fallback without one", () => {
    const store = jobStore();
    const cancelled = seed(store, 5, "m5");
    store.setJobState(cancelled, "reviewing");
    store.cancelJobs({ jobId: cancelled }, "manual_cancel", "octocat");
    const html = renderJob(store.getJob(cancelled)!, store.listReviewerRuns(cancelled), store.listLogs(cancelled), {});
    expect(html).toContain("Review cancelled by octocat");
    expect(html).toContain("the review was not completed");

    const anonymous = seed(store, 6, "m6");
    store.setJobState(anonymous, "reviewing");
    store.cancelJobs({ jobId: anonymous }, "manual_cancel", null);
    const anonHtml = renderJob(store.getJob(anonymous)!, store.listReviewerRuns(anonymous), store.listLogs(anonymous), {});
    expect(anonHtml).toContain("Review cancelled by an operator");
  });
});

describe("cancelled demo fixtures", () => {
  it("seeds one pr_merged and one manual_dequeue cancelled job without disturbing other fixtures", () => {
    const store = seededStore();

    const merged = store.listJobs(20).find((row) => row.repo_full_name === "acme/ledger" && row.pr_number === 77)!;
    expect(merged.state).toBe("cancelled");
    expect(merged.cancelled_reason).toBe("pr_merged");
    expect(merged.cancelled_by).toBeNull();
    const mergedHtml = renderJob(merged, store.listReviewerRuns(merged.id), store.listLogs(merged.id), {});
    expect(mergedHtml).toContain("Cancelled — PR merged");
    expect(mergedHtml).toContain("View the merged pull request");
    expect(mergedHtml).toContain("webhook delivery demo-fixture");
    expect(mergedHtml).not.toContain(`/jobs/${merged.id}/dequeue`);
    expect(mergedHtml).not.toContain(`/jobs/${merged.id}/cancel`);
    expect(store.hasMergedPull("acme/ledger", 77)).toBe(true);

    const dequeued = store.listJobs(20).find((row) => row.repo_full_name === "novacorp/api" && row.pr_number === 92)!;
    expect(dequeued.state).toBe("cancelled");
    expect(dequeued.cancelled_reason).toBe("manual_dequeue");
    expect(dequeued.cancelled_by).toBe("hubot");
    const dequeuedHtml = renderJob(dequeued, store.listReviewerRuns(dequeued.id), store.listLogs(dequeued.id), {});
    expect(dequeuedHtml).toContain("Dequeued by hubot");
    expect(dequeuedHtml).not.toContain(`/jobs/${dequeued.id}/dequeue`);
    expect(dequeuedHtml).not.toContain(`/jobs/${dequeued.id}/cancel`);
    expect(store.hasMergedPull("novacorp/api", 92)).toBe(false);

    // Seed-order / stale-sweep collision guard (the pr-91 class): pin neighbours.
    expect(store.listJobs(20).find((row) => row.pr_number === 91)?.state).toBe("failed");
    expect(store.listJobs(20).find((row) => row.pr_number === 90)?.state).toBe("queued");
    expect(store.listJobs(20).find((row) => row.pr_number === 418 && row.state === "stale")).toBeTruthy();
    // Headroom: every seeded fixture fits the listJobs(20) window the pages use.
    expect(store.listJobs(20)).toHaveLength(store.listJobs(100).length);
  });
});

describe("mixed-forge dashboard (issue #18)", () => {
  const store = new JobStore(openDb(":memory:"));

  function enqueue(overrides: Record<string, unknown> = {}) {
    return store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      prNumber: 7,
      prTitle: "Same name, different forge",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "octocat",
      baseSha: "b",
      headSha: "h",
      baseRef: "main",
      headRef: "feature",
      reviewers: [],
      ...overrides,
    }).job;
  }

  it("distinguishes duplicate project names hosted on different instances", () => {
    const githubJob = enqueue({ id: 2, prNumber: 8 });
    const selfManaged = enqueue({ provider: "gitlab", providerInstance: "gitlab.corp.internal" });
    const gitlabCom = enqueue({ provider: "gitlab", providerInstance: "gitlab.com" });
    const html = renderHome([githubJob, selfManaged, gitlabCom], store, {});
    // Identifier semantics: # for GitHub pulls, ! for GitLab MRs; self-managed
    // instances carry their hostname.
    expect(html).toContain("acme/widgets #8");
    expect(html).toContain("acme/widgets !7");
    expect(html).toContain("gitlab.corp.internal");
    expect(html).toContain('aria-label="GitHub"');
    expect(html).toContain('aria-label="GitLab"');
    expect(html).toContain('aria-label="GitLab · gitlab.corp.internal"');
    expect(html).not.toContain("[GitHub]");
    expect(html).not.toContain("[GitLab]");
    expect((html.match(/aria-label="GitLab/g) ?? []).length).toBe(2);
  });

  it("keeps the forge filter across pagination links", () => {
    enqueue({ provider: "gitlab", providerInstance: "gitlab.com", prNumber: 10 });
    const jobs = store.listJobsPage({ forge: { provider: "gitlab", instance: "gitlab.com" } });
    const html = renderHome(jobs.jobs, store, {
      pagination: { hasOlder: true, hasNewer: false },
      forgeScopes: [
        { provider: "github", instance: "github.com" },
        { provider: "gitlab", instance: "gitlab.com" },
      ],
      activeForge: "gitlab:gitlab.com",
    });
    expect(html).toContain('/?before=');
    expect(html).toContain(`forge=${encodeURIComponent("gitlab:gitlab.com")}`);
    expect(html).toContain("All forges");
  });

  it("carries the forge identity into the job page heading", () => {
    const job = enqueue({ provider: "gitlab", providerInstance: "gitlab.corp.internal", prNumber: 9 });
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), {});
    expect(html).toContain("acme/widgets !9");
    expect(html).toContain("gitlab.corp.internal");
    expect(html).toContain("forge-mark");
    expect(html).not.toContain("[GitLab");
  });
});

describe("operator chrome (issue #86)", () => {
  it("puts connections, configuration, and health behind a header dropdown", () => {
    const html = layout("Maomao", "<p>body</p>", {
      showLogout: true,
      csrfToken: "tok",
      identity: { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
    });
    expect(html).toContain("account-menu");
    expect(html).toContain('aria-label="Signed in as octocat"');
    expect(html).toContain('href="/connections"');
    expect(html).toContain('href="/config#effective"');
    expect(html).toContain('href="/health"');
    expect(html).toContain('href="/scan"');
    expect(html).toContain("octocat");
    expect(html).toContain("account-who");
    expect(html).toContain('class="who-avatar"');
    expect(html).toContain('action="/logout"');
    expect(html).not.toContain("signed in as");
  });

  it("labels a password session as Operator instead of a generic Menu", () => {
    const html = layout("Maomao", "<p>body</p>", { showLogout: true, csrfToken: "tok" });
    expect(html).toContain("account-menu");
    expect(html).toContain("Operator");
    expect(html).toContain('aria-label="Signed in as Operator"');
    expect(html).toContain("who-glyph");
    expect(html).toContain("account-who");
    expect(html).toContain('href="/connections"');
    expect(html).not.toContain(">Menu<");
  });

  it("keeps a Menu label when the UI is ungated", () => {
    const html = layout("Maomao", "<p>body</p>", {});
    expect(html).toContain("account-menu");
    expect(html).toContain("Menu");
    expect(html).toContain('aria-label="Operator menu"');
    expect(html).not.toContain("account-who");
    expect(html).not.toContain('action="/logout"');
  });

  it("does not restyle the dashboard surface", () => {
    const store = new JobStore(openDb(":memory:"));
    const html = renderHome([], store);
    expect(html).not.toContain('class="operator"');
    expect(html).toContain("account-menu");
  });

  it("does not restyle the job overview", () => {
    const store = seededStore();
    const job = store.listJobs(1)[0]!;
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id));
    expect(html).not.toContain('class="operator"');
    expect(html).toContain("account-menu");
  });
});

describe("connections operator page", () => {
  it("renders an empty state without secret fields", () => {
    const html = renderConnectionsPage({
      connections: [],
      csrfToken: "tok",
      options: { error: "instance URL rejected: must use https" },
    });
    expect(html).toContain("No forge connections yet.");
    expect(html).toContain('class="empty"');
    expect(html).toContain('class="operator"');
    expect(html).toContain("Add a GitLab connection");
    expect(html).toContain("Create connection");
    expect(html).toContain('class="error"');
    expect(html).not.toContain("glpat-");
    expect(html).not.toContain('name="token_sealed"');
  });
});

describe("health HTML page", () => {
  it("shows status chips and a JSON escape hatch", () => {
    const html = renderHealthPage({ ok: true, uptimeSec: 12, service: "maomao" });
    expect(html).toContain("Health");
    expect(html).toContain("state-completed");
    expect(html).toContain("/health?json=1");
    expect(html).toContain('class="operator"');
    expect(html).not.toContain("EventSource");
  });
});

describe("specialist prompt catalog", () => {
  it("shows built-in role instructions and an override form without a free-text role id", () => {
    const html = renderPromptConfigPage({
      revisions: [
        {
          id: 4,
          role_id: "correctness",
          status: "draft",
          body: "Focus: leaked secrets.",
          note: null,
          created_by: "octocat",
          editSeq: 1,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          activated_at: null,
        },
      ],
      fixtures: [],
      evaluations: [],
      canWrite: true,
      csrfToken: "tok",
    });
    expect(html).toContain("Specialist prompts");
    expect(html).toContain('data-role="correctness"');
    expect(html).toContain('data-role="security"');
    expect(html).toContain("Built-in");
    expect(html).toContain("Override this built-in");
    expect(html).toContain("Correctness / regression hunter");
    expect(html).toContain('name="role_id" value="security"');
    expect(html).not.toContain('<input name="role_id"');
    expect(html).toContain("Focus: leaked secrets.");
    expect(html).toContain("Activate override");
    expect(html).toContain("Built-in instructions");
    expect(html).toContain('class="operator"');
    expect(html).toContain('href="/config"');
  });
});

describe("Ask Maomao page contracts", () => {
  it("seeds the island with suggestions and transcript messages, and keeps the no-JS form", () => {
    const html = renderChatPage({
      job: { id: 9, repo_full_name: "acme/widgets", head_sha: "abc123def456", pr_number: 4 },
      conversation: undefined,
      messages: [{ id: 1, conversation_id: 1, role: "user", content: "What changed?", cost: null, total_tokens: null, duration_ms: null, created_at: "t" }],
      findings: [{ severity: "high", summary: "cookie flag" }],
      enabled: true,
      maxMessages: 8,
      usedCost: 0,
      maxCostUsd: 1,
      model: "test/model",
      options: { csrfToken: "tok" },
    });
    expect(html).toContain('id="maomao-chat-root"');
    expect(html).toContain('id="maomao-chat-config"');
    expect(html).toContain("/jobs/9/chat/stream");
    expect(html).toContain("What changed?");
    expect(html).toContain("Explain the high finding: cookie flag");
    expect(html).toContain('id="maomao-chat-form"');
    expect(html).toContain('class="operator"');
    expect(html).toContain('class="chat-toolbar"');
    expect(html).toContain("New conversation");
    expect(html).toContain('action="/jobs/9/chat/reset"');
    expect(html).not.toContain("Start a new conversation");
    const configMatch = html.match(/<script id="maomao-chat-config" type="application\/json">([\s\S]*?)<\/script>/);
    const config = JSON.parse(configMatch![1]) as { messages: Array<{ role: string }>; suggestions: string[] };
    expect(config.messages[0]?.role).toBe("user");
    expect(config.suggestions[0]).toContain("What does this change do");
  });
});

