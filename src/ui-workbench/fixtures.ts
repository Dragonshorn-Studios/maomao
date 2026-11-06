/**
 * Deterministic fixtures for the UI workbench.
 *
 * Every value here is a literal: no clock, no database rows, no network, no
 * filesystem. The same story therefore renders byte-identical markup on every
 * run, which is what makes screenshot comparison and DOM assertions stable.
 */
import type { JobRow, ReviewerRunRow, WebhookDeliveryRow } from "../jobs/store.js";
import type { JobState, ReviewerState } from "../config.js";
import type { ProfileFormValues } from "../config-form.js";
import { initialProfileFormValues } from "../config-form.js";
import type { FindingRow } from "../findings/types.js";
import type { ForgeBadgeFields } from "../ui/forge-badge.js";
import {
  brandMark,
  externalLinkGlyph,
  githubMark,
  gitlabMark,
  operatorMark,
  pancakeMark,
  roleGlyph,
  stackMark,
} from "../ui/glyphs.js";
import type { ModelPickerEntry } from "../ui/model-picker.js";
import type { SeverityCounts } from "../ui/metrics.js";
import { countSeverities } from "../ui/metrics.js";
import type { PromptConfigPageData, PromptRevisionView, StackMemberSummary } from "../ui/pages.js";

/** Frozen timestamps. Fixtures never read the clock. */
export const T = {
  created: "2026-01-05T09:00:00.000Z",
  started: "2026-01-05T09:01:00.000Z",
  finished: "2026-01-05T09:14:00.000Z",
} as const;

const REPO = "acme/ledger";
const SHA = "c0ffee1a2b3c4d5e6f708192a3b4c5d6e7f8091a";
const BASE_SHA = "aa11bb22cc33dd44ee55ff6677889900aabbccdd";

/** A complete job row with only the interesting fields overridden. */
export function jobFixture(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 412,
    repo_full_name: REPO,
    repo_owner: "acme",
    repo_name: "ledger",
    installation_id: 42,
    provider: "github",
    provider_instance: "github.com",
    forge_connection_id: null,
    github_account_id: null,
    github_repository_id: null,
    pr_number: 412,
    pr_title: "Harden session cookie flags on /api",
    pr_body: "Fixture pull request used by the UI workbench.",
    pr_html_url: `https://github.com/${REPO}/pull/412`,
    pr_author: "octocat",
    base_sha: BASE_SHA,
    head_sha: SHA,
    base_ref: "main",
    head_ref: "cookie-flags",
    webhook_delivery_id: "workbench-delivery",
    webhook_event: "pull_request",
    state: "completed",
    failure_reason: null,
    workspace_path: null,
    github_review_id: null,
    github_review_url: null,
    review_event: null,
    review_event_reason: null,
    aggregator_fallback: null,
    cancelled_reason: null,
    cancelled_by: null,
    profile_revision_id: null,
    job_type: "pr_review",
    review_mode: "full",
    scan_branch: null,
    brief_json: null,
    dedup_key: "",
    aggregator_raw: null,
    aggregator_normalized: null,
    aggregator_model: null,
    aggregator_provider: null,
    aggregator_state: "queued",
    aggregator_started_at: null,
    aggregator_finished_at: null,
    aggregator_duration_ms: null,
    aggregator_first_output_ms: null,
    aggregator_prompt_tokens: null,
    aggregator_completion_tokens: null,
    aggregator_cost: null,
    aggregator_reasoning_tokens: null,
    aggregator_cache_read_tokens: null,
    aggregator_cache_write_tokens: null,
    aggregator_total_tokens: null,
    aggregator_usage_complete: null,
    aggregator_usage_warning: null,
    reconciliation_json: null,
    risk_profile: null,
    risk_reason: null,
    created_at: T.created,
    updated_at: T.finished,
    started_at: T.started,
    finished_at: T.finished,
    routing_state: null,
    routing_mode: null,
    routing_profile: null,
    routing_reason: null,
    routing_confidence: null,
    routing_signals: null,
    routing_reviewers: null,
    routing_source: null,
    routing_model: null,
    routing_provider: null,
    routing_raw: null,
    routing_prompt_tokens: null,
    routing_completion_tokens: null,
    routing_cost: null,
    routing_total_tokens: null,
    routing_usage_complete: null,
    routing_usage_warning: null,
    routing_duration_ms: null,
    routing_first_output_ms: null,
    internal_escalation_state: null,
    internal_escalation_reason: null,
    internal_escalation_model: null,
    internal_escalation_provider: null,
    internal_escalation_raw: null,
    internal_escalation_normalized: null,
    internal_escalation_prompt_tokens: null,
    internal_escalation_completion_tokens: null,
    internal_escalation_cost: null,
    internal_escalation_total_tokens: null,
    internal_escalation_usage_complete: null,
    internal_escalation_usage_warning: null,
    internal_escalation_duration_ms: null,
    internal_escalation_first_output_ms: null,
    internal_escalation_alert_cleared: null,
    external_dispatch_status: null,
    external_dispatch_reason: null,
    external_dispatch_targets: null,
    external_dispatch_error: null,
    budget_exceeded_warning: null,
    escalation_id: null,
    poison_alert_policy: null,
    manual_escalate_requested: null,
    retry_count: 0,
    ...overrides,
  };
}

/** A specialist run row. `normalized_json` carries the reviewer's findings. */
export function runFixture(overrides: Partial<ReviewerRunRow> = {}): ReviewerRunRow {
  return {
    id: 900,
    job_id: 412,
    role: "correctness",
    title: "Correctness",
    model: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    state: "done",
    attempt: 1,
    raw_output: null,
    normalized_json: null,
    validation_error: null,
    stdout: null,
    stderr: null,
    exit_code: 0,
    started_at: T.started,
    finished_at: T.finished,
    duration_ms: 780_000,
    prompt_tokens: 4_100,
    completion_tokens: 820,
    cost: 0.0421,
    reasoning_tokens: 120,
    cache_read_tokens: 800,
    cache_write_tokens: 40,
    total_tokens: 5_880,
    usage_complete: 1,
    prompt_revision_id: null,
    usage_warning: null,
    first_output_ms: 1_900,
    ...overrides,
  };
}

/** A specialist run that found something. */
export function runWithFindings(
  severity: "blocker" | "high" | "medium" | "low" | "info",
  summary: string,
  overrides: Partial<ReviewerRunRow> = {},
): ReviewerRunRow {
  return runFixture({
    normalized_json: JSON.stringify({
      schema_version: 1,
      reviewer: overrides.role ?? "correctness",
      verdict: "findings",
      summary,
      findings: [
        {
          severity,
          confidence: 0.91,
          category: overrides.role ?? "correctness",
          file: "src/server.ts",
          line: 128,
          summary,
          reason: "The session cookie is written without the Secure flag, so a proxy can downgrade it.",
          suggested_check: "Assert the Set-Cookie header carries `Secure` in the session test.",
        },
      ],
    }),
    ...overrides,
  });
}

/** A specialist run that found nothing. */
export function runClean(overrides: Partial<ReviewerRunRow> = {}): ReviewerRunRow {
  return runFixture({
    normalized_json: JSON.stringify({
      schema_version: 1,
      reviewer: overrides.role ?? "correctness",
      verdict: "clean",
      summary: "No issues in this specialty for the reviewed SHA.",
      findings: [],
    }),
    ...overrides,
  });
}

/** The aggregator result stored on the job row. */
export function aggregatorNormalized(findings: Array<Record<string, unknown>>, summary: string): string {
  return JSON.stringify({
    schema_version: 1,
    reviewer: "aggregator",
    verdict: findings.length > 0 ? "findings" : "clean",
    summary,
    findings,
  });
}

/** A reviewer-board row: a run joined to the job that owns it. */
export function boardRow(
  run: ReviewerRunRow,
  job: JobRow,
  overrides: {
    state?: ReviewerState;
    jobState?: JobState;
    stackJobId?: number | null;
  } = {},
): ReviewerRunRow & {
  job_state: JobState;
  job_type: JobRow["job_type"];
  forge_provider: string;
  provider_instance: string;
  repo_full_name: string;
  pr_number: number;
  pr_title: string;
  head_sha: string;
  review_mode: JobRow["review_mode"];
  stack_job_id: number | null;
} {
  return {
    ...run,
    state: overrides.state ?? run.state,
    job_state: overrides.jobState ?? job.state,
    job_type: job.job_type,
    forge_provider: job.provider,
    provider_instance: job.provider_instance,
    repo_full_name: job.repo_full_name,
    pr_number: job.pr_number,
    pr_title: job.pr_title,
    head_sha: job.head_sha,
    review_mode: job.review_mode,
    stack_job_id: overrides.stackJobId ?? null,
  };
}

/** The profile editor's values, filled in from the production defaults. */
export function profileValuesFixture(overrides: Partial<ProfileFormValues> = {}): ProfileFormValues {
  return {
    ...initialProfileFormValues(),
    name: "workbench-profile",
    note: "Fixture profile rendered by the UI workbench.",
    reviewers: [
      { role: "correctness", model: "anthropic/claude-sonnet-4-5", timeoutSeconds: "600" },
      { role: "security", model: "anthropic/claude-sonnet-4-5", timeoutSeconds: "600" },
    ],
    routerModel: "anthropic/claude-haiku-4-5",
    verifierModel: "anthropic/claude-sonnet-4-5",
    verifierTimeoutSeconds: "300",
    maxCostUsd: "5",
    maxTokens: "250000",
    ...overrides,
  };
}

/** Field errors shown next to the controls of the invalid variant. */
export const PROFILE_FIELD_ERRORS = {
  form: "The profile could not be saved. Fix the highlighted fields.",
  name: "Name must be unique.",
  "reviewer_model_0": "Pick a model from the catalog.",
  max_cost_usd: "Enter a positive number.",
} as const;

/* -------------------------------------------------------------------------- */
/* component fixtures                                                          */
/* -------------------------------------------------------------------------- */

/** A CSRF placeholder: previews never submit anything. */
const CSRF = "workbench-csrf-token";

/** The input shape `renderFindingCard` takes. */
export interface FindingCardInput {
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
}

/** A persisted finding row — the record a card reads its status, marker, and diff from. */
export function findingRowFixture(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    id: 31,
    repo_full_name: REPO,
    pr_number: 412,
    provider: "github",
    provider_instance: "github.com",
    fingerprint: "fp-8c41d7a2",
    status: "open",
    reviewed_sha: SHA,
    current_sha: SHA,
    github_thread_id: null,
    github_comment_id: null,
    original_path: "src/server/session.ts",
    original_line: 128,
    current_path: "src/server/session.ts",
    current_line: 128,
    category: "security",
    summary: "Session cookie is written without the Secure flag",
    body: "The login handler sets the cookie without `Secure`, so a plaintext proxy can rewrite it.",
    severity: "high",
    confidence: 0.91,
    dismissed_by: null,
    dismissed_at: null,
    dismiss_command: null,
    reopened_by: null,
    reopened_at: null,
    reopen_command: null,
    reconciliation_confidence: null,
    reconciliation_reason: null,
    diff_hunk: null,
    diff_note: null,
    last_job_id: 412,
    created_at: T.created,
    updated_at: T.finished,
    ...overrides,
  };
}

/** A short unified-diff hunk — enough for the card's diff panel to render. */
export const DIFF_HUNK = [
  "@@ -120,9 +120,12 @@ export function login(request: Request) {",
  "   const token = sessions.create(user.id);",
  '-  response.headers.set("Set-Cookie", `session=${token}`);',
  "+  response.headers.set(",
  '+    "Set-Cookie",',
  "+    `session=${token}; Secure; HttpOnly; SameSite=Lax`,",
  "+  );",
  "   return response;",
  " }",
].join("\n");

/**
 * One finding card, plus the change context its links point at.
 *
 * The card is the component the job page renders per finding; the context is
 * the reviewed head SHA and the change URL, so the production permalink and
 * the "older SHA" badge behave as they do on a live page.
 */
export function findingCardFixture(
  overrides: Partial<FindingCardInput> = {},
): { input: FindingCardInput; context: { prHeadSha: string; prHtmlUrl: string } } {
  const input: FindingCardInput = {
    severity: "high",
    category: "security",
    file: "src/server/session.ts",
    line: 128,
    summary: "Session cookie is written without the Secure flag",
    reason: "The login handler sets the cookie without `Secure`, so a plaintext proxy can rewrite it.",
    suggested: "Assert the Set-Cookie header carries `Secure` in the session test.",
    agreed: ["security"],
    unconfirmed: false,
    record: findingRowFixture(),
    ...overrides,
  };
  return {
    input,
    context: { prHeadSha: SHA, prHtmlUrl: `https://github.com/${REPO}/pull/412` },
  };
}

/** One specialist run — the card the job page shows per reviewer. */
export function reviewerRunFixture(overrides: Partial<ReviewerRunRow> = {}): ReviewerRunRow {
  return runFixture({
    model: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    ...overrides,
  });
}

/** Severity counts for the chips — counted from finding-like rows. */
export function severityCountsFixture(
  severities: string[] = ["blocker", "high", "high", "medium", "info"],
): SeverityCounts {
  return countSeverities(severities.map((severity) => ({ severity })));
}

/** The stack rail — the members of a stack review, in position order. */
export function stackMembersFixture(): StackMemberSummary[] {
  const members = [
    { job: jobFixture({ id: 411, pr_number: 411 }), state: "done" },
    { job: jobFixture({ id: 412, pr_number: 412 }), state: "reviewing" },
    { job: jobFixture({ id: 413, pr_number: 413 }), state: "queued" },
  ];
  return members.map((member, index) => ({
    position: index + 1,
    prNumber: member.job.pr_number,
    memberJobId: member.job.id,
    state: member.state,
  }));
}

/** The glyph set the chrome uses — the role marks plus the brand, forge, and utility marks. */
export function brandMarkFixture(): Array<{ label: string; mark: string }> {
  return [
    { label: "Role · correctness", mark: roleGlyph("correctness") },
    { label: "Role · security", mark: roleGlyph("security") },
    { label: "Role · tests", mark: roleGlyph("tests") },
    { label: "Role · architecture", mark: roleGlyph("architecture") },
    { label: "Role · api", mark: roleGlyph("api") },
    { label: "Role · maintainer", mark: roleGlyph("maintainer") },
    { label: "Role · aggregator", mark: roleGlyph("aggregator") },
    { label: "Brand", mark: brandMark() },
    { label: "Operator", mark: operatorMark() },
    { label: "GitHub", mark: githubMark() },
    { label: "GitLab", mark: gitlabMark() },
    { label: "External link", mark: externalLinkGlyph() },
    { label: "Stack", mark: stackMark() },
    { label: "Pancake", mark: pancakeMark() },
  ];
}

/** A forge identity — the provider and the instance host a badge names. */
export function forgeBadgeFixture(
  fields: ForgeBadgeFields,
  changeNumber: number,
): { fields: ForgeBadgeFields; repoFullName: string; changeNumber: number } {
  return { fields, repoFullName: REPO, changeNumber };
}

/** One configuration-audit entry — a profile lifecycle transition. */
export interface ConfigAuditEntry {
  id: number;
  action: string;
  actor: string;
  revision_id: number | null;
  detail: string | null;
  created_at: string;
}

/** The configuration audit trail — who changed which profile revision, and when. */
export function configAuditFixture(): ConfigAuditEntry[] {
  return [
    {
      id: 3,
      action: "activated",
      actor: "octocat",
      revision_id: 12,
      detail: "activated revision 12",
      created_at: T.finished,
    },
    {
      id: 2,
      action: "draft_created",
      actor: "octocat",
      revision_id: 12,
      detail: "draft of default",
      created_at: T.started,
    },
    {
      id: 1,
      action: "deactivated",
      actor: "maomao",
      revision_id: null,
      detail: null,
      created_at: T.created,
    },
  ];
}

/** A webhook delivery row — what maomao saw, and what it did with it. */
export function deliveryRowFixture(overrides: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow {
  return {
    provider: "github",
    provider_instance: "github.com",
    delivery_id: "workbench-delivery",
    event: "pull_request",
    action: "opened",
    repo_full_name: REPO,
    actor: "octocat",
    result: "queued job 412",
    ignored: 0,
    created_at: T.created,
    ...overrides,
  };
}

/** The built-in instructions of a reviewer role — the prompt a card previews. */
const DEFAULT_ROLE_BODY = [
  "Review the changed lines only.",
  "",
  "Report a finding when the change can break a documented contract, lose data, or weaken a security control.",
  "Name the file and the line, explain the failure, and state the check that would catch it.",
].join("\n");

/** The override an operator activated for a reviewer role. */
const CUSTOM_ROLE_BODY = [
  "Review the changed lines only.",
  "",
  "Treat a missing test for a changed branch as a finding: name the branch, the file, and the test that is missing.",
].join("\n");

/** One prompt revision — the stored body of a role's override. */
export function promptRevisionFixture(overrides: Partial<PromptRevisionView> = {}): PromptRevisionView {
  return {
    id: 42,
    role_id: "correctness",
    status: "active",
    body: CUSTOM_ROLE_BODY,
    note: "Tightened the rule about missing branch tests.",
    created_by: "octocat",
    editSeq: 3,
    created_at: T.started,
    updated_at: T.finished,
    activated_at: T.finished,
    ...overrides,
  };
}

/**
 * One reviewer role on the prompt page: the role, the revisions it has, and
 * the page data the card reads its write controls from.
 */
export function promptRoleFixture(
  overrides: {
    role?: Partial<{ id: string; title: string; defaultBody: string }>;
    revisions?: PromptRevisionView[];
    data?: Partial<PromptConfigPageData>;
  } = {},
): {
  role: { id: string; title: string; defaultBody: string };
  revisions: PromptRevisionView[];
  data: PromptConfigPageData;
} {
  const role = {
    id: "correctness",
    title: "Correctness",
    defaultBody: DEFAULT_ROLE_BODY,
    ...overrides.role,
  };
  const revisions = overrides.revisions ?? [];
  return {
    role,
    revisions,
    data: {
      revisions,
      fixtures: [],
      evaluations: [],
      canWrite: true,
      csrfToken: CSRF,
      ...overrides.data,
    },
  };
}

/** The model picker's options — the catalog a picker offers. */
export function modelPickerFixture(
  overrides: {
    name?: string;
    value?: string;
    models?: ModelPickerEntry[];
    emptyLabel?: string;
    placeholder?: string;
    allowCustom?: boolean;
  } = {},
): {
  name: string;
  value: string;
  models: ModelPickerEntry[];
  emptyLabel?: string;
  placeholder?: string;
  allowCustom?: boolean;
} {
  return {
    name: "reviewer_0_model",
    value: "anthropic/claude-sonnet-4-5",
    models: [
      { id: "anthropic/claude-sonnet-4-5", hint: "default specialist" },
      { id: "anthropic/claude-haiku-4-5", hint: "fast router" },
      { id: "anthropic/claude-opus-4-6", hint: "aggregator" },
    ],
    emptyLabel: "— default —",
    placeholder: "provider/model",
    allowCustom: true,
    ...overrides,
  };
}
