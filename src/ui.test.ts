import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { seedDemoJobs } from "./demo/fixtures.js";
import { JobStore } from "./jobs/store.js";
import { THEME_CSS } from "./ui/theme.js";
import { renderConfigPage, renderHome, renderJob, renderLogin, renderScanConfirmPage, renderScanIssuePreviewPage, renderScanPage } from "./ui/pages.js";
import { jobStateLabel, settledFindingsCopy } from "./ui/copy.js";
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
    expect(THEME_CSS).toContain("@keyframes spin");
    expect(THEME_CSS).toContain(".section-head");
    expect(THEME_CSS).toMatch(/\.tick\.running[\s\S]*var\(--working\)/);
    expect(THEME_CSS).toMatch(/\.state-reviewing[\s\S]*var\(--working-soft\)/);
    expect(THEME_CSS).not.toMatch(/\.tick\.running \{ background: var\(--amber\)/);
    expect(THEME_CSS).toContain("--ash:");
    expect(THEME_CSS).toContain('html[data-theme="dark"]');
    expect(THEME_CSS).toContain("prefers-reduced-motion");
    expect(THEME_CSS).toContain("--font-mono:");
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
    expect(html).not.toContain("EventSource");
    expect(html).toContain("Skip to content");
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
    expect(html).toContain("acme/ledger#412");
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

describe("config page", () => {
  it("renders revisions, write controls only for operators, and escapes definitions", () => {
    const data = {
      revisions: [
        {
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
        },
      ],
      audit: [{ id: 1, action: "draft_created", actor: "octocat", revision_id: 3, detail: "draft of default", created_at: "2026-01-01T00:00:00Z" }],
      csrfToken: "tok",
      canWrite: true,
    };
    const html = renderConfigPage(data);
    expect(html).toContain("Review configuration");
    // The definition JSON is rendered escaped inside the edit textarea.
    expect(html).toContain("&quot;reviewers&quot;");
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain("Activate");
    expect(html).toContain("expected_edit_seq");
    expect(html).toContain("Audit history");

    const readonly = renderConfigPage({ ...data, canWrite: false, csrfToken: undefined });
    expect(readonly).not.toContain("Activate");
    expect(readonly).not.toContain('name="csrf_token"');
    expect(readonly).toContain("requires an operator OAuth identity");
  });
});

describe("cat-hunt flavor", () => {
  it("adds the hunt summary and per-reviewer flavor without hiding technical data", () => {
    const store = seededStore();
    const job = store.listJobs(50).find((row) => row.pr_number === 412)!;
    const html = renderJob(job, store.listReviewerRuns(job.id), store.listLogs(job.id), { uiFlavor: "apothecary" });
    // Technical names and metrics stay first.
    expect(html).toContain("acme/ledger#412");
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
    expect(html).toContain("signed in as");
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
    expect(html).toContain("signed in as");
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
