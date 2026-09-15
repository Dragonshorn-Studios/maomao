import type { ReviewerRole } from "../prompts.js";
import { DEFAULT_REVIEWER_ROLES } from "../prompts.js";
import { fingerprintFinding } from "../findings/identity.js";
import type { JobStore, NewJobInput } from "../jobs/store.js";

const MODEL = "anthropic/claude-sonnet-4-5";
const AGG_MODEL = "anthropic/claude-opus-4-6";
const PROVIDER = "anthropic";

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function reviewers(roles: ReviewerRole[] = DEFAULT_REVIEWER_ROLES) {
  return roles.map((role) => ({ role: role.id, title: role.title, model: MODEL }));
}

function finding(partial: {
  reviewer: string;
  severity: "blocker" | "high" | "medium" | "low" | "info";
  category?: string;
  file?: string;
  line?: number;
  summary: string;
  reason: string;
  suggested_check?: string;
  confidence?: number;
}) {
  return JSON.stringify({
    schema_version: 1,
    reviewer: partial.reviewer,
    verdict: "findings",
    summary: partial.summary,
    findings: [
      {
        severity: partial.severity,
        confidence: partial.confidence ?? 0.86,
        category: partial.category ?? partial.reviewer,
        file: partial.file,
        line: partial.line,
        summary: partial.summary,
        reason: partial.reason,
        suggested_check: partial.suggested_check,
      },
    ],
  });
}

function clean(reviewer: string) {
  return JSON.stringify({
    schema_version: 1,
    reviewer,
    verdict: "clean",
    summary: "No issues in this specialty for the reviewed SHA.",
    findings: [],
  });
}

function baseJob(overrides: Partial<NewJobInput> & Pick<NewJobInput, "prNumber" | "prTitle" | "headSha">): NewJobInput {
  return {
    repoFullName: "acme/ledger",
    repoOwner: "acme",
    repoName: "ledger",
    installationId: 42,
    prBody: "Operator fixture used to exercise the monitoring UI.",
    prHtmlUrl: `https://github.com/acme/ledger/pull/${overrides.prNumber}`,
    prAuthor: "octocat",
    baseSha: "aa11bb22cc33dd44ee55ff6677889900aabbccdd",
    baseRef: "main",
    headRef: `pr-${overrides.prNumber}`,
    webhookEvent: "demo.fixture",
    reviewers: reviewers(),
    ...overrides,
  };
}

export function seedDemoJobs(store: JobStore): void {
  seedCompletedWithFindings(store);
  seedStalePredecessor(store);
  seedReviewing(store);
  seedAggregating(store);
  seedQueued(store);
  seedRouting(store);
  seedFailed(store);
  seedClean(store);
  seedPoisonInternalOnly(store);
  seedPoisonSniffing(store);
}

function seedCompletedWithFindings(store: JobStore): void {
  const { job } = store.enqueue(
    baseJob({
      prNumber: 412,
      prTitle: "Harden session cookie flags on /api",
      headSha: "c0ffee1a2b3c4d5e6f708192a3b4c5d6e7f8091a",
      headRef: "cookie-flags",
    }),
  );
  const runs = store.listReviewerRuns(job.id);
  const byRole = Object.fromEntries(runs.map((run) => [run.role, run.id]));
  const started = ago(18);
  const finished = ago(4);

  store.patchReviewer(byRole.correctness, {
    state: "done",
    attempt: 1,
    model: MODEL,
    provider: PROVIDER,
    started_at: started,
    finished_at: ago(12),
    duration_ms: 96_000,
    prompt_tokens: 4100,
    completion_tokens: 820,
    reasoning_tokens: 120,
    cache_read_tokens: 800,
    cache_write_tokens: 40,
    total_tokens: 5880,
    usage_complete: 1,
    cost: 0.041,
    normalized_json: finding({
      reviewer: "correctness",
      severity: "high",
      file: "src/auth.ts",
      line: 54,
      summary: "Cookie Secure flag is skipped on forwarded HTTP, allowing session theft on mis-set proxies",
      reason: "isPublicPath and cookieSecure disagree when X-Forwarded-Proto is a list. A stale inner hop can drop Secure.",
      suggested_check: "Send X-Forwarded-Proto: https, http and confirm Set-Cookie still includes Secure.",
    }),
    stdout: "opencode run --format json --model anthropic/claude-sonnet-4-5\nreviewer=correctness verdict=findings\n",
  });
  store.patchReviewer(byRole.security, {
    state: "done",
    attempt: 1,
    model: MODEL,
    provider: PROVIDER,
    started_at: started,
    finished_at: ago(11),
    duration_ms: 101_000,
    prompt_tokens: 3880,
    completion_tokens: 640,
    cost: 0.036,
    normalized_json: finding({
      reviewer: "security",
      severity: "high",
      category: "security",
      file: "src/auth.ts",
      line: 57,
      summary: "Session cookie may be written without Secure on HTTPS behind a split forwarded proto list",
      reason: "cookieSecure only inspects the first forwarded hop. Evidence in the diff: split(',')[0].",
      suggested_check: "Unit-test cookieSecure with a multi-value X-Forwarded-Proto header.",
    }),
  });
  store.patchReviewer(byRole.tests, {
    state: "done",
    attempt: 1,
    model: MODEL,
    provider: PROVIDER,
    started_at: started,
    finished_at: ago(10),
    duration_ms: 88_000,
    prompt_tokens: 3500,
    completion_tokens: 410,
    cost: 0.028,
    normalized_json: finding({
      reviewer: "tests",
      severity: "medium",
      file: "src/auth.test.ts",
      line: 44,
      summary: "No test covers a comma-separated X-Forwarded-Proto list",
      reason: "New cookieSecure behavior is only asserted for a single https value.",
      suggested_check: "Add a case for 'https, http' and 'http, https'.",
    }),
  });
  store.patchReviewer(byRole.architecture, {
    state: "done",
    attempt: 1,
    model: MODEL,
    provider: PROVIDER,
    started_at: started,
    finished_at: ago(10),
    duration_ms: 74_000,
    prompt_tokens: 3200,
    completion_tokens: 180,
    cost: 0.018,
    normalized_json: clean("architecture"),
  });
  store.patchReviewer(byRole.api, {
    state: "done",
    attempt: 1,
    model: MODEL,
    provider: PROVIDER,
    started_at: started,
    finished_at: ago(9),
    duration_ms: 69_000,
    prompt_tokens: 2900,
    completion_tokens: 120,
    cost: 0.015,
    normalized_json: clean("api"),
  });
  store.patchReviewer(byRole.maintainer, {
    state: "done",
    attempt: 1,
    model: MODEL,
    provider: PROVIDER,
    started_at: started,
    finished_at: ago(9),
    duration_ms: 80_000,
    prompt_tokens: 3600,
    completion_tokens: 260,
    cost: 0.022,
    normalized_json: finding({
      reviewer: "maintainer",
      severity: "low",
      file: "README.md",
      line: 147,
      summary: "README still describes the cookie as always Secure on HTTPS without mentioning the forwarded-proto caveat",
      reason: "Operators copying the production note may assume any TLS terminator is enough.",
      suggested_check: "Document that the first X-Forwarded-Proto value must be https.",
    }),
  });

  const aggregator = {
    schema_version: 1,
    verdict: "comment",
    summary:
      "Maomao aggregated specialist reviewer evidence for this exact commit.\n\n**1** high-severity finding retained after deduplication.\n\n- **high** `src/auth.ts:54`: Session cookie Secure flag can be dropped when X-Forwarded-Proto contains multiple values.",
    findings: [
      {
        severity: "high",
        confidence: 0.9,
        category: "security",
        file: "src/auth.ts",
        line: 54,
        summary: "Session cookie Secure flag can be dropped when X-Forwarded-Proto contains multiple values",
        body: "cookieSecure reads only the first forwarded hop. Reviewers correctness and security agreed. Confirm Set-Cookie on a split proto list.",
        reviewers_agreed: ["correctness", "security"],
      },
      {
        severity: "medium",
        confidence: 0.78,
        category: "tests",
        file: "src/auth.test.ts",
        line: 44,
        summary: "No test covers a comma-separated X-Forwarded-Proto list",
        body: "Add cases for mixed proto lists before treating the cookie helper as done.",
        reviewers_agreed: ["tests"],
      },
      {
        severity: "low",
        confidence: 0.6,
        category: "docs",
        file: "README.md",
        line: 147,
        summary: "Production cookie note omits the forwarded-proto caveat",
        body: "A one-line README fix would prevent operators from assuming any TLS terminator is sufficient.",
        reviewers_agreed: ["maintainer"],
      },
    ],
  };

  store.setJobState(job.id, "completed", {
    started_at: started,
    finished_at: finished,
    aggregator_state: "done",
    aggregator_model: AGG_MODEL,
    aggregator_provider: PROVIDER,
    aggregator_started_at: ago(8),
    aggregator_finished_at: ago(5),
    aggregator_duration_ms: 140_000,
    aggregator_prompt_tokens: 9200,
    aggregator_completion_tokens: 1100,
    aggregator_reasoning_tokens: 0,
    aggregator_cache_read_tokens: 0,
    aggregator_cache_write_tokens: 0,
    aggregator_total_tokens: 10300,
    aggregator_usage_complete: 1,
    aggregator_cost: 0.12,
    aggregator_normalized: JSON.stringify(aggregator, null, 2),
    aggregator_raw: JSON.stringify(aggregator),
    github_review_id: "424242",
    github_review_url: "https://github.com/acme/ledger/pull/412#pullrequestreview-424242",
    routing_state: "done",
    routing_mode: "hybrid",
    routing_profile: "poison-alert",
    routing_source: "hard-rule",
    routing_reason: "Authentication flow changed",
    routing_confidence: 0.94,
    routing_reviewers: JSON.stringify(["correctness", "security", "tests", "architecture", "api", "maintainer"]),
    routing_signals: JSON.stringify({ families: ["auth"], hardRiskFamilies: ["auth"] }),
    poison_alert_policy: "internal_and_external",
    internal_escalation_state: "done",
    internal_escalation_model: AGG_MODEL,
    internal_escalation_provider: PROVIDER,
    internal_escalation_cost: 0.08,
    internal_escalation_total_tokens: 4200,
    internal_escalation_alert_cleared: 0,
    internal_escalation_reason: "internal pass confirmed risk",
    external_dispatch_status: "dispatched",
    external_dispatch_reason: "immediate dispatch completed",
    external_dispatch_targets: JSON.stringify([{ type: "mention", recipient: "@repository-owner" }]),
  });
  store.log(job.id, "Checked out c0ffee1a2b3c4d5e6f708192a3b4c5d6e7f8091a");
  store.log(job.id, "6 reviewer runs finished");
  store.log(job.id, "Aggregator posted COMMENT review 424242");
  seedSettledFindingsForCompletedJob(store, job.repo_full_name, job.pr_number, job.head_sha);
}

function seedSettledFindingsForCompletedJob(
  store: JobStore,
  repoFullName: string,
  prNumber: number,
  reviewedSha: string,
): void {
  const docs = {
    category: "docs",
    file: "README.md",
    summary: "Production cookie note omits the forwarded-proto caveat",
    body: "A one-line README fix would prevent operators from assuming any TLS terminator is sufficient.",
  };
  store.dismissFinding({
    repoFullName,
    prNumber,
    fingerprint: fingerprintFinding(docs),
    actor: "octocat",
    command: "bury",
    reviewedSha,
    summary: docs.summary,
    path: docs.file,
    line: 147,
    category: docs.category,
    severity: "low",
    body: docs.body,
  });
  store.upsertFinding({
    repoFullName,
    prNumber,
    fingerprint: "resolvedfid00001",
    status: "resolved",
    reviewedSha,
    summary: "null deref after fix",
    currentPath: "src/session.ts",
    currentLine: 18,
    category: "correctness",
    severity: "medium",
  });
}

function seedStalePredecessor(store: JobStore): void {
  const { job } = store.enqueue(
    baseJob({
      prNumber: 418,
      prTitle: "Add inventory recount job",
      headSha: "oldoldoldoldoldoldoldoldoldoldoldoldold1",
      headRef: "recount",
    }),
  );
  const started = ago(80);
  const finished = ago(70);
  for (const run of store.listReviewerRuns(job.id)) {
    store.patchReviewer(run.id, {
      state: "done",
      attempt: 1,
      model: MODEL,
      provider: PROVIDER,
      started_at: started,
      finished_at: finished,
      duration_ms: 60_000,
      prompt_tokens: 2100,
      completion_tokens: 80,
      cost: 0.01,
      normalized_json: clean(run.role),
    });
  }
  store.setJobState(job.id, "completed", {
    started_at: started,
    finished_at: finished,
    aggregator_state: "done",
    aggregator_model: AGG_MODEL,
    aggregator_provider: PROVIDER,
    aggregator_normalized: JSON.stringify({
      schema_version: 1,
      verdict: "clean",
      summary: "Specialist reviewers reported no validated findings for this commit.",
      findings: [],
    }),
    github_review_id: "111",
    github_review_url: "https://github.com/acme/ledger/pull/418#pullrequestreview-111",
  });
  store.enqueue(
    baseJob({
      prNumber: 418,
      prTitle: "Add inventory recount job",
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      headRef: "recount",
    }),
  );
}

function seedReviewing(store: JobStore): void {
  const jobs = store.listJobs(20);
  const job = jobs.find((row) => row.head_sha.startsWith("abcdef01"));
  if (!job) return;
  const runs = store.listReviewerRuns(job.id);
  const started = ago(6);
  store.setJobState(job.id, "reviewing", { started_at: started, aggregator_state: "queued" });
  runs.forEach((run, index) => {
    if (index < 4) {
      store.patchReviewer(run.id, {
        state: "done",
        attempt: 1,
        model: MODEL,
        provider: PROVIDER,
        started_at: started,
        finished_at: ago(2),
        duration_ms: 70_000 + index * 1000,
        prompt_tokens: 2800,
        completion_tokens: 200,
        cost: 0.02,
        normalized_json: clean(run.role),
      });
    } else if (index === 4) {
      store.patchReviewer(run.id, {
        state: "running",
        attempt: 1,
        model: MODEL,
        provider: PROVIDER,
        started_at: ago(2),
        stdout: "opencode run …\ncollecting observations on src/jobs/recount.ts\n",
      });
    }
  });
  store.log(job.id, "Examining PR #418 at abcdef0123456789");
  store.log(job.id, "4 / 6 reviewers done; api still running");
}

function seedAggregating(store: JobStore): void {
  const { job } = store.enqueue(
    baseJob({
      repoFullName: "novacorp/api",
      repoOwner: "novacorp",
      repoName: "api",
      prNumber: 88,
      prTitle: "Deprecate v1 list endpoint",
      prHtmlUrl: "https://github.com/novacorp/api/pull/88",
      headSha: "b1d0b1d0b1d0b1d0b1d0b1d0b1d0b1d0b1d0b1d0",
      headRef: "deprecate-v1",
    }),
  );
  const started = ago(14);
  for (const run of store.listReviewerRuns(job.id)) {
    store.patchReviewer(run.id, {
      state: "done",
      attempt: 1,
      model: MODEL,
      provider: PROVIDER,
      started_at: started,
      finished_at: ago(3),
      duration_ms: 95_000,
      prompt_tokens: 3000,
      completion_tokens: 240,
      cost: 0.021,
      normalized_json:
        run.role === "api"
          ? finding({
              reviewer: "api",
              severity: "medium",
              file: "src/routes/v1.ts",
              line: 12,
              summary: "v1 list still advertised in OpenAPI after the deprecation commit",
              reason: "The spec still lists GET /v1/items as current.",
              suggested_check: "Diff the generated OpenAPI against the changelog.",
            })
          : clean(run.role),
    });
  }
  store.setJobState(job.id, "aggregating", {
    started_at: started,
    aggregator_state: "running",
    aggregator_model: AGG_MODEL,
    aggregator_provider: PROVIDER,
    aggregator_started_at: ago(2),
  });
  store.log(job.id, "Aggregation in progress");
}

function seedQueued(store: JobStore): void {
  store.enqueue(
    baseJob({
      repoFullName: "novacorp/api",
      repoOwner: "novacorp",
      repoName: "api",
      prNumber: 90,
      prTitle: "Rate-limit webhook retries",
      prHtmlUrl: "https://github.com/novacorp/api/pull/90",
      headSha: "1111222233334444555566667777888899990000",
      headRef: "webhook-retries",
    }),
  );
}

function seedRouting(store: JobStore): void {
  const { job } = store.enqueue(
    baseJob({
      prNumber: 422,
      prTitle: "Rotate session signing keys",
      headSha: "a11ce0ffeea11ce0ffeea11ce0ffeea11ce0ffee",
      headRef: "rotate-keys",
      reviewers: [],
    }),
  );
  store.setJobState(job.id, "routing", {
    started_at: ago(1),
    routing_state: "running",
    routing_mode: "hybrid",
    routing_model: "anthropic/claude-haiku-4-5",
    routing_provider: "anthropic",
    routing_reason: "Scanner found auth and secrets; router model still choosing a profile.",
    routing_signals: JSON.stringify({ families: ["auth", "secrets"], hardRiskFamilies: ["auth", "secrets"] }),
  });
  store.log(job.id, "Choosing specialists from deterministic signals + router model");
}

function seedFailed(store: JobStore): void {
  const { job } = store.enqueue(
    baseJob({
      repoFullName: "novacorp/api",
      repoOwner: "novacorp",
      repoName: "api",
      prNumber: 91,
      prTitle: "Rewrite auth middleware",
      prHtmlUrl: "https://github.com/novacorp/api/pull/91",
      headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      headRef: "auth-mw",
    }),
  );
  const runs = store.listReviewerRuns(job.id);
  const started = ago(40);
  store.patchReviewer(runs[0].id, {
    state: "failed",
    attempt: 2,
    model: MODEL,
    provider: PROVIDER,
    started_at: started,
    finished_at: ago(32),
    duration_ms: 480_000,
    exit_code: 1,
    validation_error: "Output was not valid JSON: Unexpected end of JSON input",
    stderr: "Error: model stream truncated after 120s idle\nexit 1\n",
    stdout: "{",
    raw_output: "{",
  });
  store.setJobState(job.id, "failed", {
    started_at: started,
    finished_at: ago(32),
    failure_reason: "OpenCode exited 1 after 2 attempts: timed out waiting for model response",
    aggregator_state: "failed",
  });
  store.log(job.id, "OpenCode exited 1 after 2 attempts: timed out waiting for model response", "error", runs[0].id);
}

function seedClean(store: JobStore): void {
  const { job } = store.enqueue(
    baseJob({
      prNumber: 401,
      prTitle: "Fix typo in ledger README",
      headSha: "feedfacecafe1234feedfacecafe1234feedface",
      headRef: "readme-typo",
      reviewers: [{ role: "correctness", title: "Correctness / regression hunter", model: MODEL }],
    }),
  );
  const started = ago(120);
  const finished = ago(110);
  for (const run of store.listReviewerRuns(job.id)) {
    store.patchReviewer(run.id, {
      state: "done",
      attempt: 1,
      model: MODEL,
      provider: PROVIDER,
      started_at: started,
      finished_at: finished,
      duration_ms: 52_000,
      prompt_tokens: 1800,
      completion_tokens: 90,
      cost: 0.009,
      normalized_json: clean(run.role),
    });
  }
  store.setJobState(job.id, "completed", {
    started_at: started,
    finished_at: finished,
    aggregator_state: "done",
    aggregator_model: AGG_MODEL,
    aggregator_provider: PROVIDER,
    aggregator_duration_ms: 40_000,
    aggregator_prompt_tokens: 4200,
    aggregator_completion_tokens: 180,
    aggregator_cost: 0.03,
    aggregator_normalized: JSON.stringify({
      schema_version: 1,
      verdict: "clean",
      summary: "Specialist reviewers reported no validated findings for this commit.",
      findings: [],
    }),
    github_review_id: "4001",
    github_review_url: "https://github.com/acme/ledger/pull/401#pullrequestreview-4001",
    routing_state: "done",
    routing_mode: "hybrid",
    routing_profile: "observation",
    routing_source: "deterministic",
    routing_reason: "Narrow change: 1 file(s), 2 line(s)",
    routing_confidence: 0.7,
    routing_reviewers: JSON.stringify(["correctness"]),
    routing_signals: JSON.stringify({ families: ["docs"], hardRiskFamilies: [] }),
  });
}

function seedPoisonInternalOnly(store: JobStore): void {
  const { job } = store.enqueue(
    baseJob({
      repoFullName: "novacorp/api",
      repoOwner: "novacorp",
      repoName: "api",
      prNumber: 94,
      prTitle: "Rotate billing webhook signing keys",
      prHtmlUrl: "https://github.com/novacorp/api/pull/94",
      headSha: "5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe",
      headRef: "rotate-keys",
    }),
  );
  const started = ago(30);
  for (const run of store.listReviewerRuns(job.id)) {
    store.patchReviewer(run.id, {
      state: "done",
      attempt: 1,
      model: MODEL,
      provider: PROVIDER,
      started_at: started,
      finished_at: ago(6),
      duration_ms: 88_000,
      prompt_tokens: 2800,
      completion_tokens: 210,
      cost: 0.018,
      normalized_json: clean(run.role),
    });
  }
  store.setJobState(job.id, "completed", {
    started_at: started,
    finished_at: ago(5),
    aggregator_state: "done",
    aggregator_model: AGG_MODEL,
    aggregator_provider: PROVIDER,
    aggregator_total_tokens: 8100,
    aggregator_cost: 0.09,
    aggregator_normalized: JSON.stringify({ schema_version: 1, verdict: "comment", summary: "No suspicious findings after the laboratory re-check.", findings: [] }, null, 2),
    routing_state: "done",
    routing_mode: "hybrid",
    routing_profile: "poison-alert",
    routing_source: "hard-rule",
    routing_reason: "Billing and secrets families changed",
    routing_confidence: 0.91,
    routing_signals: JSON.stringify({ families: ["billing", "secrets"], hardRiskFamilies: ["billing", "secrets"] }),
    poison_alert_policy: "internal_only",
    internal_escalation_state: "done",
    internal_escalation_model: AGG_MODEL,
    internal_escalation_provider: PROVIDER,
    internal_escalation_total_tokens: 3900,
    internal_escalation_cost: 0.07,
    internal_escalation_alert_cleared: 1,
    internal_escalation_reason: "internal pass cleared the alert",
    external_dispatch_status: "not_requested",
  });
  store.log(job.id, "Internal poison-alert pass done: alert_cleared=1 findings=0");
}

function seedPoisonSniffing(store: JobStore): void {
  const { job } = store.enqueue(
    baseJob({
      repoFullName: "novacorp/api",
      repoOwner: "novacorp",
      repoName: "api",
      prNumber: 96,
      prTitle: "Add deferred payment capture endpoint",
      prHtmlUrl: "https://github.com/novacorp/api/pull/96",
      headSha: "6060606060606060606060606060606060606060",
      headRef: "deferred-capture",
    }),
  );
  const started = ago(9);
  for (const run of store.listReviewerRuns(job.id)) {
    store.patchReviewer(run.id, {
      state: "done",
      attempt: 1,
      model: MODEL,
      provider: PROVIDER,
      started_at: started,
      finished_at: ago(2),
      duration_ms: 91_000,
      prompt_tokens: 3200,
      completion_tokens: 260,
      cost: 0.024,
      normalized_json: clean(run.role),
    });
  }
  store.setJobState(job.id, "sniffing", {
    started_at: started,
    aggregator_state: "done",
    aggregator_model: AGG_MODEL,
    aggregator_provider: PROVIDER,
    aggregator_total_tokens: 7600,
    aggregator_cost: 0.08,
    routing_state: "done",
    routing_mode: "hybrid",
    routing_profile: "poison-alert",
    routing_source: "hard-rule",
    routing_reason: "Payments flow changed under high risk",
    routing_confidence: 0.93,
    routing_signals: JSON.stringify({ families: ["billing"], hardRiskFamilies: ["billing"] }),
    poison_alert_policy: "internal_then_external",
    internal_escalation_state: "running",
    internal_escalation_model: AGG_MODEL,
    internal_escalation_provider: PROVIDER,
  });
  store.log(job.id, `Internal poison-alert pass model=${AGG_MODEL}`);
}
