import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { seedDemoJobs } from "./demo/fixtures.js";
import { JobStore } from "./jobs/store.js";
import { THEME_CSS } from "./ui/theme.js";
import { renderHome, renderJob, renderLogin } from "./ui/pages.js";
import { settledFindingsCopy } from "./ui/copy.js";
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
    const html = renderLogin(false, "/jobs/1");
    expect(html).toContain("Sign in");
    expect(html).toContain('data-appearance="light"');
    expect(html).toContain('data-appearance="dark"');
    expect(html).toContain('data-appearance="system"');
    expect(html).toContain("/assets/maomao.css");
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
    expect(html).toContain("dispatched (notification accepted)");
    expect(html).toContain("does not track whether an external reviewer finished");
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
