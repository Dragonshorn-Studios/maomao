/**
 * The allowlist of stories shown at /dev/ui.
 *
 * This is the only file that knows Maomao's UI exists. Every preview renders
 * the real production component with a deterministic fixture — no markup is
 * copied and no rendering path is duplicated.
 */
import type { JobRow, JobStore, ReviewerRunRow } from "../jobs/store.js";
import { KNOWN_REVIEWER_ROLES } from "../prompts.js";
import type { ChatConversationRow, ChatMessageRow } from "../chat/store.js";
import { jobMetricsFromRuns } from "../ui/metrics.js";
import { layoutBody } from "../ui/layout.js";
import { forgeBadgeTitleHtml } from "../ui/forge-badge.js";
import { modelPicker } from "../ui/model-picker.js";
import { escapeHtml } from "../util.js";
import {
  configAuditTable,
  deliveriesTable,
  promptRoleCard,
  renderFindingCard,
  renderHome,
  renderJob,
  renderProfileForm,
  renderQueueCard,
  renderReviewerBoard,
  renderRun,
  renderSeverityChips,
  renderStackStrip,
  type JobPageOptions,
} from "../ui/pages.js";
import { renderChatPage, type ChatPageData } from "../ui/chat-page.js";
import type { WorkbenchStory, WorkbenchVariant } from "./contract.js";
import {
  aggregatorNormalized,
  boardRow,
  brandMarkFixture,
  configAuditFixture,
  deliveryRowFixture,
  DIFF_HUNK,
  findingCardFixture,
  findingRowFixture,
  forgeBadgeFixture,
  jobFixture,
  modelPickerFixture,
  PROFILE_FIELD_ERRORS,
  profileValuesFixture,
  promptRevisionFixture,
  promptRoleFixture,
  reviewerRunFixture,
  runClean,
  runFixture,
  runWithFindings,
  severityCountsFixture,
  stackMembersFixture,
  T,
} from "./fixtures.js";

/** The fake chat endpoint the chat island talks to instead of a model. */
export const FAKE_CHAT_STREAM_URL = "/dev/ui/fake/chat/stream";

/** A CSRF placeholder: previews never submit anything. */
const WORKBENCH_CSRF = "workbench-csrf-token";

/**
 * A store with no rows. `renderHome` only asks the store for stack summaries
 * and pancake stats; the workbench answers them from literals so the gallery
 * boots without a database file.
 */
function emptyStore(): JobStore {
  return {
    stackMemberSummaries: () => new Map(),
    stackMembershipForJobs: () => new Map(),
    memberJobsForStacks: () => new Map(),
    pancakeStats: () => ({ count: 0, latestId: 0 }),
  } as unknown as JobStore;
}

/* -------------------------------------------------------------------------- */
/* job/status card                                                            */
/* -------------------------------------------------------------------------- */

const CARD_COMPLETED_JOB = jobFixture({
  state: "completed",
  aggregator_state: "done",
  aggregator_model: "anthropic/claude-opus-4-6",
  aggregator_provider: "anthropic",
  aggregator_started_at: T.started,
  aggregator_finished_at: T.finished,
  aggregator_duration_ms: 214_000,
  aggregator_prompt_tokens: 12_400,
  aggregator_completion_tokens: 1_900,
  aggregator_total_tokens: 14_300,
  aggregator_cost: 0.1284,
  aggregator_usage_complete: 1,
  aggregator_normalized: aggregatorNormalized(
    [
      {
        severity: "high",
        confidence: 0.93,
        category: "security",
        file: "src/server.ts",
        line: 128,
        summary: "Session cookie is written without the Secure flag",
        reason: "The login handler sets the cookie without `Secure`, so a plaintext proxy can rewrite it.",
        suggested_check: "Assert the Set-Cookie header carries `Secure` in the session test.",
      },
      {
        severity: "info",
        confidence: 0.72,
        category: "maintainability",
        file: "src/server.ts",
        line: 141,
        summary: "Cookie flags are assembled in three places",
        reason: "The same flag list is repeated per cookie, which invites drift.",
        suggested_check: "Extract a single cookie-options helper.",
      },
    ],
    "One security issue worth fixing before merge.",
  ),
});

const CARD_COMPLETED_RUNS: ReviewerRunRow[] = [
  runWithFindings("high", "Session cookie is written without the Secure flag", {
    id: 901,
    role: "security",
    title: "Security",
  }),
  runClean({ id: 902, role: "correctness", title: "Correctness" }),
  runFixture({
    id: 903,
    role: "performance",
    title: "Performance",
    state: "done",
    normalized_json: JSON.stringify({
      schema_version: 1,
      reviewer: "performance",
      verdict: "clean",
      summary: "No hot-path regressions in this diff.",
      findings: [],
    }),
  }),
];

const CARD_REVIEWING_JOB = jobFixture({
  state: "reviewing",
  aggregator_state: "running",
  aggregator_started_at: T.started,
  started_at: T.started,
  finished_at: null,
  pr_title: "Reconcile prior findings before the specialist pass",
});

const CARD_REVIEWING_RUNS: ReviewerRunRow[] = [
  runFixture({ id: 911, role: "correctness", title: "Correctness", state: "running", finished_at: null }),
  runFixture({ id: 912, role: "security", title: "Security", state: "queued", started_at: null, finished_at: null }),
  runClean({ id: 913, role: "performance", title: "Performance" }),
];

const CARD_FAILED_JOB = jobFixture({
  state: "failed",
  failure_reason: "opencode exited with code 1 after 3 attempts",
  aggregator_state: "failed",
  finished_at: T.finished,
  pr_title: "Retry the reviewer set after a transport failure",
});

const CARD_FAILED_RUNS: ReviewerRunRow[] = [
  runFixture({
    id: 921,
    role: "correctness",
    title: "Correctness",
    state: "failed",
    exit_code: 1,
    stderr: "opencode: provider returned 503 after 3 attempts",
    validation_error: "reviewer output was not valid JSON",
    normalized_json: null,
  }),
  runFixture({ id: 922, role: "security", title: "Security", state: "queued", started_at: null, finished_at: null }),
];

const CARD_LONG_JOB = jobFixture({
  state: "completed",
  pr_title:
    "Migrate the pull request review pipeline to the new reviewer contract so that stale findings are reconciled before the specialist pass, the aggregator receives structured evidence instead of free-form text, and every published comment keeps a verifiable link back to the exact reviewed commit",
  aggregator_state: "done",
  aggregator_model: "anthropic/claude-opus-4-6",
  aggregator_provider: "anthropic",
  aggregator_normalized: aggregatorNormalized(
    Array.from({ length: 8 }, (_, index) => ({
      severity: index === 0 ? "blocker" : index < 3 ? "high" : "medium",
      confidence: 0.9,
      category: "correctness",
      file: `src/services/review-${index + 1}.ts`,
      line: 40 + index,
      summary: `Finding ${index + 1}: the review pipeline drops the reconciliation result when the specialist set changes`,
      reason: "The reconciler result is written to a column that is not read back by the aggregator, so a stale finding survives into the published comment.",
      suggested_check: "Cover the changed-specialist case in the pipeline test.",
    })),
    "Eight findings, one of them a merge blocker.",
  ),
});

const CARD_LONG_RUNS: ReviewerRunRow[] = [
  runWithFindings("blocker", "Finding 1: the review pipeline drops the reconciliation result", {
    id: 931,
    role: "correctness",
    title: "Correctness",
  }),
];

/* -------------------------------------------------------------------------- */
/* job detail page                                                            */
/* -------------------------------------------------------------------------- */

const DETAIL_COMPLETED_JOB = CARD_COMPLETED_JOB;
const DETAIL_COMPLETED_RUNS = CARD_COMPLETED_RUNS;
const DETAIL_FAILED_JOB = jobFixture({
  id: 413,
  state: "failed",
  failure_reason: "the aggregator produced output that failed schema validation twice",
  aggregator_state: "failed",
  aggregator_model: "anthropic/claude-opus-4-6",
  aggregator_provider: "anthropic",
  aggregator_started_at: T.started,
  aggregator_finished_at: T.finished,
  aggregator_usage_warning: "the provider stopped reporting token counts halfway through",
  pr_title: "Publish one conservative review comment",
});
const DETAIL_FAILED_RUNS: ReviewerRunRow[] = [
  runClean({ id: 941, role: "correctness", title: "Correctness" }),
  runWithFindings("medium", "The published comment drops the severity labels", {
    id: 942,
    role: "maintainability",
    title: "Maintainability",
  }),
];
const DETAIL_STALE_JOB = jobFixture({
  id: 414,
  state: "stale",
  aggregator_state: "stale",
  pr_title: "A superseded commit that must never publish a review",
  head_sha: "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
});

/* -------------------------------------------------------------------------- */
/* reviewer board                                                             */
/* -------------------------------------------------------------------------- */

const BOARD_MIXED_ROWS = [
  boardRow(runFixture({ id: 951, role: "correctness", title: "Correctness", state: "running", finished_at: null }), CARD_REVIEWING_JOB, {
    state: "running",
    jobState: "reviewing",
  }),
  boardRow(runClean({ id: 952, role: "security", title: "Security" }), CARD_COMPLETED_JOB),
  boardRow(
    runFixture({ id: 953, role: "performance", title: "Performance", state: "failed", exit_code: 1 }),
    CARD_FAILED_JOB,
    { state: "failed", jobState: "failed" },
  ),
  boardRow(runFixture({ id: 954, role: "tests", title: "Tests", state: "queued", started_at: null, finished_at: null }), CARD_REVIEWING_JOB, {
    state: "queued",
    jobState: "reviewing",
  }),
];

/* -------------------------------------------------------------------------- */
/* component fixtures                                                          */
/* -------------------------------------------------------------------------- */

/** One finding card per variant — the card the job page renders per finding. */
const FINDING_CARDS = {
  blocker: findingCardFixture({
    severity: "blocker",
    category: "security",
    summary: "The login route lets any caller mint a session",
    reason:
      "The handler takes the user id from the request body, so an unauthenticated caller can mint a session for any account.",
    suggested: "Reject the request unless it carries the caller's own session.",
    agreed: ["security", "correctness"],
    record: findingRowFixture({
      id: 30,
      fingerprint: "fp-1a70c93e",
      severity: "blocker",
      summary: "The login route lets any caller mint a session",
      body: "The handler takes the user id from the request body, so an unauthenticated caller can mint a session for any account.",
      confidence: 0.97,
    }),
  }),
  high: findingCardFixture({
    severity: "high",
    category: "security",
    summary: "Session cookie is written without the Secure flag",
    reason:
      "The login handler sets the cookie without `Secure`, so a plaintext proxy can rewrite it.",
    suggested: "Assert the Set-Cookie header carries `Secure` in the session test.",
    agreed: ["security"],
  }),
  info: findingCardFixture({
    severity: "info",
    category: "maintainability",
    file: "src/server/session.ts",
    line: 141,
    summary: "Cookie flags are assembled in three places",
    reason: "The same flag list is repeated per cookie, which invites drift.",
    suggested: "Extract a single cookie-options helper.",
    agreed: [],
  }),
  "with-diff": findingCardFixture({
    severity: "medium",
    category: "correctness",
    line: 131,
    summary: "The session cookie is written without the Secure flag",
    reason: "The cookie is assembled inline instead of through the shared helper, so the flags drift per call site.",
    suggested: "Route the cookie through the shared options helper.",
    agreed: ["correctness"],
    record: findingRowFixture({
      id: 32,
      fingerprint: "fp-6d02b5f8",
      severity: "medium",
      category: "correctness",
      current_line: 131,
      summary: "The session cookie is written without the Secure flag",
      body: "The cookie is assembled inline instead of through the shared helper, so the flags drift per call site.",
      confidence: 0.84,
      diff_hunk: DIFF_HUNK,
    }),
  }),
  unconfirmed: findingCardFixture({
    severity: "low",
    category: "maintainability",
    file: "src/server/session.ts",
    line: 150,
    summary: "The session TTL is spelled out in two places",
    reason: "A specialist observed the TTL twice; the aggregator has not confirmed it yet.",
    suggested: "Name the constant both call sites should share.",
    agreed: [],
    unconfirmed: true,
    // A specialist observation has no persisted record yet, so the card shows
    // no marker note and no "view at this SHA" permalink.
    record: undefined,
  }),
};

/** One specialist run per variant — the card the job page shows per reviewer. */
const REVIEWER_RUNS = {
  done: runWithFindings("high", "Session cookie is written without the Secure flag", {
    id: 961,
    role: "security",
    title: "Security",
  }),
  running: reviewerRunFixture({
    id: 962,
    role: "correctness",
    title: "Correctness",
    state: "running",
    finished_at: null,
    duration_ms: null,
    total_tokens: null,
    cost: null,
    usage_complete: null,
    normalized_json: null,
  }),
  failed: reviewerRunFixture({
    id: 963,
    role: "correctness",
    title: "Correctness",
    state: "failed",
    exit_code: 1,
    stderr: "opencode: provider returned 503 after 3 attempts",
    validation_error: "reviewer output was not valid JSON",
    normalized_json: null,
  }),
  stale: reviewerRunFixture({
    id: 964,
    role: "tests",
    title: "Tests",
    state: "stale",
    finished_at: null,
    normalized_json: null,
  }),
};

/** The severity counts the chips story frames. */
const SEVERITY_CHIP_COUNTS = {
  mixed: severityCountsFixture(),
  empty: severityCountsFixture([]),
};

/** The members of the stack the strip story frames. */
const STACK_MEMBERS = stackMembersFixture();

/** Every inline mark the chrome draws. */
const BRAND_MARKS = brandMarkFixture();

/** The forge identities the badge story frames. */
const FORGE_BADGES = {
  github: forgeBadgeFixture({ provider: "github", provider_instance: "github.com" }, 412),
  gitlab: forgeBadgeFixture({ provider: "gitlab", provider_instance: "gitlab.com" }, 412),
  other: forgeBadgeFixture({ provider: "gitea", provider_instance: "git.acme.internal" }, 412),
};

/** The audit trail the audit-table story frames. */
const CONFIG_AUDIT = configAuditFixture();

/** The delivery log the deliveries-table story frames. */
const DELIVERIES = {
  delivered: [
    deliveryRowFixture(),
    deliveryRowFixture({
      delivery_id: "workbench-delivery-2",
      action: "synchronize",
      created_at: T.started,
      result: "queued job 413",
    }),
  ],
  failed: [
    deliveryRowFixture({
      delivery_id: "workbench-delivery-3",
      action: "opened",
      created_at: T.started,
      result: "error: the repository is not installed on this connection",
    }),
    deliveryRowFixture({
      delivery_id: "workbench-delivery-4",
      event: "issue_comment",
      action: null,
      actor: "octocat",
      created_at: T.finished,
      result: "ignored: the comment is not a command",
      ignored: 1,
    }),
  ],
  empty: [],
};

/** The reviewer roles the prompt-role-card story frames. */
const PROMPT_ROLES = {
  default: promptRoleFixture(),
  custom: promptRoleFixture({ revisions: [promptRevisionFixture()] }),
};

/** The model pickers the model-picker story frames. */
const MODEL_PICKERS = {
  selected: modelPickerFixture(),
  empty: modelPickerFixture({ value: "", models: [] }),
};

/* -------------------------------------------------------------------------- */
/* chat island                                                                */
/* -------------------------------------------------------------------------- */

const CHAT_JOB: JobRow = jobFixture({
  id: 415,
  pr_title: "Explain the reviewed change",
});

function chatData(overrides: {
  conversation?: ChatConversationRow | undefined;
  messages?: ChatMessageRow[];
  enabled?: boolean;
  maxMessages?: number;
  usedCost?: number;
  maxCostUsd?: number;
  model?: string;
}): ChatPageData {
  return {
    job: {
      id: CHAT_JOB.id,
      repo_full_name: CHAT_JOB.repo_full_name,
      head_sha: CHAT_JOB.head_sha,
      pr_number: CHAT_JOB.pr_number,
    },
    conversation: overrides.conversation,
    messages: overrides.messages ?? [],
    findings: [
      { severity: "high", summary: "Session cookie is written without the Secure flag" },
      { severity: "info", summary: "Cookie flags are assembled in three places" },
    ],
    enabled: overrides.enabled ?? true,
    maxMessages: overrides.maxMessages ?? 20,
    usedCost: overrides.usedCost ?? 0.0121,
    maxCostUsd: overrides.maxCostUsd ?? 1,
    model: overrides.model ?? "anthropic/claude-sonnet-4-5",
    options: { csrfToken: WORKBENCH_CSRF, surface: "operator" },
  };
}

const CHAT_CONFIG_PATTERN = /(<script id="maomao-chat-config" type="application\/json">)([\s\S]*?)(<\/script>)/;

/**
 * The production chat page, framed for the workbench: the island markup is
 * production markup, only the stream endpoint is repointed at the fake
 * in-process handler so no model is ever called.
 */
function chatPreview(data: ChatPageData): string {
  const body = layoutBody(renderChatPage(data));
  const match = CHAT_CONFIG_PATTERN.exec(body);
  if (!match) return body;

  const config = JSON.parse(match[2]) as { streamUrl?: string };
  config.streamUrl = FAKE_CHAT_STREAM_URL;
  const json = JSON.stringify(config).replaceAll("</", "<\\/");
  return body.replace(match[0], `${match[1]}${json}${match[3]}`);
}

/* -------------------------------------------------------------------------- */
/* the story book                                                             */
/* -------------------------------------------------------------------------- */

/** Looks up a variant fixture by id; unknown ids fall back to the first one. */
function byId<T extends Record<string, unknown>>(table: T, id: string): T[keyof T] {
  return (table[id] ?? Object.values(table)[0]) as T[keyof T];
}

export const STORIES: WorkbenchStory[] = [
  {
    id: "job-card",
    title: "Job / status card",
    category: "Jobs",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts", "src/ui/metrics.ts", "src/ui/copy.ts"],
    defaultViewport: "desktop",
    uses: ["severity-chips"],
    notes: "The dashboard queue card — the same markup the home page renders.",
    variants: [
      { id: "completed", title: "Completed with findings" },
      { id: "reviewing", title: "Reviewing (live)" },
      { id: "failed", title: "Failed" },
      { id: "long-text", title: "Long title and many findings" },
    ],
    preview: (variant) => {
      const table = {
        completed: { job: CARD_COMPLETED_JOB, runs: CARD_COMPLETED_RUNS },
        reviewing: { job: CARD_REVIEWING_JOB, runs: CARD_REVIEWING_RUNS },
        failed: { job: CARD_FAILED_JOB, runs: CARD_FAILED_RUNS },
        "long-text": { job: CARD_LONG_JOB, runs: CARD_LONG_RUNS },
      };
      const { job, runs } = byId(table, variant.id);
      const metrics = jobMetricsFromRuns(job, runs);
      // The card is an <li>; the production list wraps it, so the frame shows
      // the card exactly as the dashboard does.
      return `<ol class="queue">${renderQueueCard(job, metrics, "apothecary", WORKBENCH_CSRF)}</ol>`;
    },
  },
  {
    id: "job-detail",
    title: "Job detail page",
    category: "Jobs",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts", "src/ui/metrics.ts"],
    defaultViewport: "desktop",
    uses: ["finding-card", "reviewer-run", "severity-chips"],
    notes: "The per-job page: state, findings summary, reviewer runs, usage.",
    variants: [
      { id: "completed-with-findings", title: "Completed with findings" },
      { id: "failed", title: "Failed aggregation" },
      { id: "stale", title: "Stale (superseded commit)" },
    ],
    preview: (variant) => {
      const table = {
        "completed-with-findings": { job: DETAIL_COMPLETED_JOB, runs: DETAIL_COMPLETED_RUNS },
        failed: { job: DETAIL_FAILED_JOB, runs: DETAIL_FAILED_RUNS },
        stale: { job: DETAIL_STALE_JOB, runs: [] },
      };
      const { job, runs } = byId(table, variant.id);
      const options: JobPageOptions = { csrfToken: WORKBENCH_CSRF, chatEnabled: true };
      return layoutBody(renderJob(job, runs, [], options));
    },
  },
  {
    id: "reviewer-board",
    title: "Reviewer runs board",
    category: "Reviewers",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts", "src/ui/copy.ts"],
    defaultViewport: "desktop",
    uses: ["reviewer-run"],
    notes: "Every specialist run across all jobs, newest first.",
    variants: [
      { id: "mixed", title: "Mixed run states" },
      { id: "empty", title: "No runs" },
    ],
    preview: (variant) => {
      const rows = variant.id === "empty" ? [] : BOARD_MIXED_ROWS;
      return layoutBody(renderReviewerBoard(rows as Parameters<typeof renderReviewerBoard>[0], {}));
    },
  },
  {
    id: "config-form",
    title: "Profile configuration form",
    category: "Configuration",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts", "src/config-form.ts", "src/ui/model-picker.ts"],
    defaultViewport: "desktop",
    uses: ["model-picker"],
    notes: "The structured profile editor — labels, controls, and field errors.",
    variants: [
      { id: "valid", title: "Valid values" },
      { id: "invalid", title: "Field errors" },
    ],
    preview: (variant) => {
      const errors = variant.id === "invalid" ? { ...PROFILE_FIELD_ERRORS } : undefined;
      return renderProfileForm(profileValuesFixture(), errors, {
        csrfToken: WORKBENCH_CSRF,
        knownRoles: KNOWN_REVIEWER_ROLES.map((role) => ({ id: role.id, title: role.title })),
        modelCatalog: [
          { id: "anthropic/claude-sonnet-4-5", hint: "default specialist" },
          { id: "anthropic/claude-haiku-4-5", hint: "fast router" },
          { id: "anthropic/claude-opus-4-6", hint: "aggregator" },
        ],
      });
    },
  },
  {
    id: "empty-state",
    title: "Empty and error states",
    category: "States",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts", "src/ui/copy.ts"],
    defaultViewport: "desktop",
    uses: ["severity-chips"],
    notes: "The dashboard with no jobs, and the dashboard after a failed request.",
    variants: [
      { id: "empty-queue", title: "Empty queue" },
      { id: "error-notice", title: "Error notice" },
    ],
    preview: (variant) => {
      const options =
        variant.id === "error-notice"
          ? { error: "Could not load the job list: the database is locked. Retry in a moment." }
          : {};
      return layoutBody(renderHome([], emptyStore(), options));
    },
  },
  {
    id: "chat",
    title: "Ask Maomao chat island",
    category: "React islands",
    family: "react",
    sourceFiles: ["src/ui/chat-entry.tsx", "src/ui/chat-page.ts", "src/ui/chat-stream.ts"],
    defaultViewport: "desktop",
    notes: "The assistant-ui island. Its stream endpoint is a fake in-process handler — no model is ever called.",
    variants: [
      { id: "empty", title: "No messages yet" },
      { id: "conversation", title: "Existing conversation" },
      { id: "failed", title: "Last message failed" },
    ],
    preview: (variant) => {
      if (variant.id === "conversation") {
        return chatPreview(
          chatData({
            conversation: {
              id: 7,
              job_id: CHAT_JOB.id,
              created_by: null,
              opencode_session_id: null,
              workspace_path: null,
              state: "active",
              last_error: null,
              message_count: 2,
              cost: 0.0121,
              total_tokens: 4_200,
              created_at: T.created,
              updated_at: T.finished,
            },
            messages: [
              {
                id: 1,
                conversation_id: 7,
                role: "user",
                content: "What does this change do?",
                cost: null,
                total_tokens: null,
                duration_ms: null,
                created_at: T.created,
              },
              {
                id: 2,
                conversation_id: 7,
                role: "assistant",
                content: "It tightens the session cookie flags on the login route.",
                cost: 0.0121,
                total_tokens: 4_200,
                duration_ms: 3_400,
                created_at: T.finished,
              },
            ],
          }),
        );
      }
      if (variant.id === "failed") {
        return chatPreview(
          chatData({
            conversation: {
              id: 8,
              job_id: CHAT_JOB.id,
              created_by: null,
              opencode_session_id: null,
              workspace_path: null,
              state: "error",
              last_error: "the explainer run exited with code 1",
              message_count: 1,
              cost: 0,
              total_tokens: 0,
              created_at: T.created,
              updated_at: T.finished,
            },
            messages: [
              {
                id: 3,
                conversation_id: 8,
                role: "user",
                content: "Why did the review fail?",
                cost: null,
                total_tokens: null,
                duration_ms: null,
                created_at: T.created,
              },
            ],
          }),
        );
      }
      return chatPreview(chatData({}));
    },
  },
  {
    id: "finding-card",
    title: "Finding card",
    category: "Findings",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts", "src/ui/metrics.ts"],
    defaultViewport: "desktop",
    notes: "One finding as the job page renders it: severity, location, reason, and the diff panel.",
    variants: [
      { id: "blocker", title: "Blocker" },
      { id: "high", title: "High" },
      { id: "info", title: "Info" },
      { id: "with-diff", title: "With diff" },
      { id: "unconfirmed", title: "Unconfirmed" },
    ],
    preview: (variant) => {
      const { input, context } = byId(FINDING_CARDS, variant.id);
      return renderFindingCard(input, context);
    },
  },
  {
    id: "reviewer-run",
    title: "Reviewer run card",
    category: "Reviewers",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts"],
    defaultViewport: "desktop",
    notes: "One specialist run as the job page renders it: model, usage, and the reported findings.",
    variants: [
      { id: "done", title: "Done" },
      { id: "running", title: "Running" },
      { id: "failed", title: "Failed" },
      { id: "stale", title: "Stale" },
    ],
    preview: (variant) => {
      const run = byId(REVIEWER_RUNS, variant.id);
      // The job page renders the run cards in a `.cards` grid; a failed run
      // also gets the retry form.
      return `<div class="cards">${renderRun(run, variant.id === "failed", WORKBENCH_CSRF)}</div>`;
    },
  },
  {
    id: "severity-chips",
    title: "Severity chips",
    category: "Findings",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts", "src/ui/metrics.ts"],
    defaultViewport: "desktop",
    notes: "The severity chips a job card counts its findings with.",
    variants: [
      { id: "mixed", title: "Mixed severities" },
      { id: "empty", title: "No findings" },
    ],
    preview: (variant) => renderSeverityChips(byId(SEVERITY_CHIP_COUNTS, variant.id)),
  },
  {
    id: "stack-strip",
    title: "Stack strip",
    category: "Stacks",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts"],
    defaultViewport: "desktop",
    uses: ["severity-chips"],
    notes: "The miniature stack rail a queue card shows for a stack review.",
    variants: [
      { id: "members", title: "Three members" },
      { id: "empty", title: "No members" },
    ],
    preview: (variant) => renderStackStrip(variant.id === "empty" ? [] : STACK_MEMBERS),
  },
  {
    id: "brand-marks",
    title: "Brand and role marks",
    category: "Chrome",
    family: "ssr",
    sourceFiles: ["src/ui/glyphs.ts"],
    defaultViewport: "desktop",
    notes: "Every inline mark the chrome draws: the role glyphs, the brand, the forge marks, the utility marks.",
    variants: [{ id: "all-marks", title: "All marks" }],
    preview: () => {
      const cells = BRAND_MARKS.map(
        (entry) =>
          `<div><span class="brand-mark">${entry.mark}</span><p class="label">${escapeHtml(entry.label)}</p></div>`,
      ).join("");
      return `<div class="meta-grid">${cells}</div>`;
    },
  },
  {
    id: "forge-badge",
    title: "Forge badge",
    category: "Chrome",
    family: "ssr",
    sourceFiles: ["src/ui/forge-badge.ts"],
    defaultViewport: "desktop",
    notes: "The forge mark beside a change title: the provider mark, the repository, and the native change id.",
    variants: [
      { id: "github", title: "GitHub" },
      { id: "gitlab", title: "GitLab" },
      { id: "other", title: "Other forge" },
    ],
    preview: (variant) => {
      const badge = byId(FORGE_BADGES, variant.id);
      const title = escapeHtml(jobFixture().pr_title);
      return `<p class="specimen-title">${forgeBadgeTitleHtml(badge.fields, badge.repoFullName, badge.changeNumber)} · ${title}</p>`;
    },
  },
  {
    id: "audit-table",
    title: "Configuration audit table",
    category: "Configuration",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts"],
    defaultViewport: "desktop",
    notes: "The configuration audit trail — who changed which profile revision, and when.",
    variants: [
      { id: "populated", title: "With entries" },
      { id: "empty", title: "No entries" },
    ],
    preview: (variant) => configAuditTable(variant.id === "empty" ? [] : CONFIG_AUDIT),
  },
  {
    id: "deliveries-table",
    title: "Webhook deliveries table",
    category: "Configuration",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts"],
    defaultViewport: "desktop",
    notes: "The webhook delivery log — what maomao saw, what it did with it, and what it ignored.",
    variants: [
      { id: "delivered", title: "Handled" },
      { id: "failed", title: "Failed" },
      { id: "empty", title: "No deliveries" },
    ],
    preview: (variant) => deliveriesTable(byId(DELIVERIES, variant.id)),
  },
  {
    id: "prompt-role-card",
    title: "Prompt role card",
    category: "Configuration",
    family: "ssr",
    sourceFiles: ["src/ui/pages.ts"],
    defaultViewport: "desktop",
    notes: "One reviewer role on the prompt page: the built-in instructions or the active override.",
    variants: [
      { id: "default", title: "Built-in" },
      { id: "custom", title: "Active override" },
    ],
    preview: (variant) => {
      const { role, revisions, data } = byId(PROMPT_ROLES, variant.id);
      return promptRoleCard(role, revisions, data);
    },
  },
  {
    id: "model-picker",
    title: "Model picker",
    category: "Configuration",
    family: "ssr",
    sourceFiles: ["src/ui/model-picker.ts"],
    defaultViewport: "desktop",
    notes: "The model dropdown every model field uses: the input, the button, and the grouped options.",
    variants: [
      { id: "selected", title: "Model selected" },
      { id: "empty", title: "No models" },
    ],
    preview: (variant) => {
      const options = byId(MODEL_PICKERS, variant.id);
      // The picker is a labelled control on the profile editor.
      return `<label>Model ${modelPicker(options)}</label>`;
    },
  },
];

/** The registry the workbench serves. */
export const REGISTRY_STORIES = STORIES;

export type { WorkbenchVariant };
