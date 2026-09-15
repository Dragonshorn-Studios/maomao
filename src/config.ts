import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseBoolean, parseCsv, parseInteger, parseNumber, replaceEscapedNewlines } from "./util.js";
import { DEFAULT_REVIEWER_ROLES, KNOWN_REVIEWER_ROLES, type ReviewerRole } from "./prompts.js";
import { parseExternalTargetsJson, validateCommandText } from "./routing/escalation.js";
import {
  POISON_ALERT_POLICIES,
  ROUTING_MODES,
  type PoisonAlertConfig,
  type PoisonAlertPolicy,
  type RouterConfig,
  type RoutingMode,
} from "./routing/types.js";
import type { Severity } from "./schema.js";

export type JobState =
  | "queued"
  | "preparing"
  | "routing"
  | "reconciling"
  | "reviewing"
  | "aggregating"
  | "publishing"
  | "completed"
  | "failed"
  | "stale"
  | "cancelled";

export type ReviewerState = "queued" | "running" | "done" | "failed";

export type PullRequestAction = "opened" | "reopened" | "synchronize" | "ready_for_review";

export interface GithubConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  appSlug: string;
}

export interface OpenCodeConfig {
  bin: string;
  reviewerModel: string;
  aggregatorModel: string;
  verifierModel: string;
  extraArgs: string[];
  timeoutMs: number;
  verifierTimeoutMs: number;
  maxRetries: number;
  reviewerConcurrency: number;
}

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  workspaceRoot: string;
  workspaceRetentionHours: number;
  logLevel: string;
  github: GithubConfig;
  opencode: OpenCodeConfig;
  reviewers: ReviewerRole[];
  routing: RouterConfig;
  poisonAlert: PoisonAlertConfig;
  jobConcurrency: number;
  reviewDrafts: boolean;
  postEmptyReview: boolean;
  pullRequestActions: PullRequestAction[];
  maxInlineComments: number;
  reconcileMinConfidence: number;
  uiPassword: string;
  uiSessionSecret: string;
}

const DEFAULT_ACTIONS: PullRequestAction[] = [
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
];

export function loadPrivateKey(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  if (path) {
    const resolved = resolve(path);
    if (!existsSync(resolved)) {
      throw new Error(`GITHUB_APP_PRIVATE_KEY_PATH not found: ${resolved}`);
    }
    return readFileSync(resolved, "utf8").trim();
  }
  const raw = env.GITHUB_APP_PRIVATE_KEY ?? "";
  return replaceEscapedNewlines(raw).trim();
}

function loadReviewers(env: NodeJS.ProcessEnv): ReviewerRole[] {
  const ids = parseCsv(env.REVIEWER_ROLES);
  const selected = ids.length > 0 ? ids : DEFAULT_REVIEWER_ROLES.map((role) => role.id);
  const byId = new Map(KNOWN_REVIEWER_ROLES.map((role) => [role.id, role]));
  return selected.map((id) => {
    const known = byId.get(id);
    const envPrompt = env[`REVIEWER_PROMPT_${id.toUpperCase().replaceAll("-", "_")}`];
    const envModel = env[`REVIEWER_MODEL_${id.toUpperCase().replaceAll("-", "_")}`];
    if (known) {
      return {
        ...known,
        prompt: envPrompt?.trim() || known.prompt,
        model: envModel?.trim() || known.model,
      };
    }
    return {
      id,
      title: id,
      prompt:
        envPrompt?.trim() ||
        `Review this pull request in the role of "${id}". Focus only on that specialty. Do not modify files.`,
      model: envModel?.trim(),
    };
  });
}

function parseRoutingMode(raw: string | undefined): RoutingMode {
  const value = (raw?.trim().toLowerCase() || "hybrid") as RoutingMode;
  if ((ROUTING_MODES as readonly string[]).includes(value)) return value;
  throw new Error(`REVIEWER_ROUTING must be one of ${ROUTING_MODES.join(", ")}`);
}

function parsePolicy(raw: string | undefined): PoisonAlertPolicy {
  const value = (raw?.trim().toLowerCase() || "internal_and_external") as PoisonAlertPolicy;
  if ((POISON_ALERT_POLICIES as readonly string[]).includes(value)) return value;
  throw new Error(`POISON_ALERT_POLICY must be one of ${POISON_ALERT_POLICIES.join(", ")}`);
}

function parseSeverity(raw: string | undefined, fallback: Severity): Severity {
  const value = (raw?.trim().toLowerCase() || fallback) as Severity;
  if (["blocker", "high", "medium", "low", "info"].includes(value)) return value;
  throw new Error("POISON_ALERT_EXTERNAL_MIN_SEVERITY must be blocker, high, medium, low, or info");
}

function loadRouting(env: NodeJS.ProcessEnv): RouterConfig {
  return {
    mode: parseRoutingMode(env.REVIEWER_ROUTING),
    model: env.OPENCODE_ROUTER_MODEL?.trim() || "",
    timeoutMs: parseInteger(env.ROUTER_TIMEOUT_MS, 60_000),
    maxDiffChars: Math.max(500, parseInteger(env.ROUTER_MAX_DIFF_CHARS, 12_000)),
    maxReviewers: Math.max(1, parseInteger(env.ROUTER_MAX_REVIEWERS, 6)),
    maxContextChars: Math.max(1_000, parseInteger(env.ROUTER_MAX_CONTEXT_CHARS, 24_000)),
    observationMaxFiles: Math.max(1, parseInteger(env.ROUTER_OBSERVATION_MAX_FILES, 2)),
    observationMaxLines: Math.max(1, parseInteger(env.ROUTER_OBSERVATION_MAX_LINES, 40)),
    poisonAlertMinFiles: Math.max(1, parseInteger(env.ROUTER_POISON_ALERT_MIN_FILES, 20)),
    poisonAlertMinLines: Math.max(1, parseInteger(env.ROUTER_POISON_ALERT_MIN_LINES, 500)),
  };
}

function loadPoisonAlert(env: NodeJS.ProcessEnv): PoisonAlertConfig {
  const fallback = env.POISON_ALERT_INTERNAL_FALLBACK?.trim().toLowerCase() === "fail" ? "fail" : "keep_first_pass";
  return {
    policy: parsePolicy(env.POISON_ALERT_POLICY),
    mentionName: env.MAOMAO_MENTION?.trim().replace(/^@/, "") || "maomao",
    escalateCommand: validateCommandText(env.POISON_ALERT_ESCALATE_COMMAND?.trim() || "escalate"),
    internal: {
      enabled: parseBoolean(env.POISON_ALERT_INTERNAL_ENABLED, false),
      model: env.POISON_ALERT_INTERNAL_MODEL?.trim() || "",
      maxCostUsd: Math.max(0, parseNumber(env.POISON_ALERT_INTERNAL_MAX_COST_USD, 0.3)),
      maxTokens: Math.max(0, parseInteger(env.POISON_ALERT_INTERNAL_MAX_TOKENS, 150_000)),
      timeoutSeconds: Math.max(1, parseInteger(env.POISON_ALERT_INTERNAL_TIMEOUT_SECONDS, 300)),
      retries: Math.max(0, parseInteger(env.POISON_ALERT_INTERNAL_RETRIES, 1)),
      context: "findings_and_relevant_hunks",
      fallback,
    },
    external: {
      enabled: parseBoolean(env.POISON_ALERT_EXTERNAL_ENABLED, false),
      targets: parseExternalTargetsJson(env.POISON_ALERT_EXTERNAL_TARGETS_JSON),
      minSeverity: parseSeverity(env.POISON_ALERT_EXTERNAL_MIN_SEVERITY, "high"),
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const actions = parseCsv(env.PULL_REQUEST_ACTIONS) as PullRequestAction[];
  const pullRequestActions = (actions.length > 0 ? actions : DEFAULT_ACTIONS).filter((action) =>
    DEFAULT_ACTIONS.includes(action),
  ) as PullRequestAction[];

  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: parseInteger(env.PORT, 3000),
    databasePath: env.DATABASE_PATH?.trim() || "./data/maomao.sqlite",
    workspaceRoot: env.WORKSPACE_ROOT?.trim() || "./data/workspaces",
    workspaceRetentionHours: parseInteger(env.WORKSPACE_RETENTION_HOURS, 24),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    github: {
      appId: env.GITHUB_APP_ID?.trim() || "",
      privateKey: loadPrivateKey(env),
      webhookSecret: env.GITHUB_WEBHOOK_SECRET?.trim() || "",
      appSlug: env.GITHUB_APP_SLUG?.trim() || "",
    },
    opencode: {
      bin: env.OPENCODE_BIN?.trim() || "opencode",
      reviewerModel: env.OPENCODE_REVIEWER_MODEL?.trim() || "",
      aggregatorModel: env.OPENCODE_AGGREGATOR_MODEL?.trim() || env.OPENCODE_REVIEWER_MODEL?.trim() || "",
      verifierModel:
        env.OPENCODE_VERIFIER_MODEL?.trim() || env.OPENCODE_REVIEWER_MODEL?.trim() || "",
      extraArgs: parseCsv(env.OPENCODE_EXTRA_ARGS).flatMap((arg) => arg.split(" ")).filter(Boolean),
      timeoutMs: parseInteger(env.OPENCODE_TIMEOUT_MS, 10 * 60 * 1000),
      verifierTimeoutMs: parseInteger(env.OPENCODE_VERIFIER_TIMEOUT_MS, 2 * 60 * 1000),
      maxRetries: parseInteger(env.OPENCODE_MAX_RETRIES, 1),
      reviewerConcurrency: Math.max(1, parseInteger(env.OPENCODE_REVIEWER_CONCURRENCY, 2)),
    },
    reviewers: loadReviewers(env),
    routing: loadRouting(env),
    poisonAlert: loadPoisonAlert(env),
    jobConcurrency: Math.max(1, parseInteger(env.JOB_CONCURRENCY, 1)),
    reviewDrafts: parseBoolean(env.REVIEW_DRAFTS, false),
    postEmptyReview: parseBoolean(env.POST_EMPTY_REVIEW, false),
    pullRequestActions,
    maxInlineComments: Math.max(0, parseInteger(env.MAX_INLINE_COMMENTS, 12)),
    reconcileMinConfidence: clamp01(env.RECONCILE_MIN_CONFIDENCE, 0.7),
    uiPassword: env.UI_PASSWORD?.trim() || env.MAOMAO_UI_PASSWORD?.trim() || "",
    uiSessionSecret: env.UI_SESSION_SECRET?.trim() || env.MAOMAO_UI_SESSION_SECRET?.trim() || "",
  };
}

export function assertRuntimeConfig(config: Config): void {
  const missing: string[] = [];
  if (!config.github.appId) missing.push("GITHUB_APP_ID");
  if (!config.github.privateKey) missing.push("GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH");
  if (!config.github.webhookSecret) missing.push("GITHUB_WEBHOOK_SECRET");
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
  if (config.reviewers.length === 0) {
    throw new Error("At least one reviewer role is required");
  }
  if (config.routing.mode === "model" && !config.routing.model && !config.opencode.reviewerModel) {
    throw new Error("REVIEWER_ROUTING=model requires OPENCODE_ROUTER_MODEL or OPENCODE_REVIEWER_MODEL");
  }
  if (config.poisonAlert.internal.enabled && !config.poisonAlert.internal.model) {
    throw new Error("POISON_ALERT_INTERNAL_ENABLED requires POISON_ALERT_INTERNAL_MODEL");
  }
  const passwordSet = Boolean(config.uiPassword);
  const secretSet = Boolean(config.uiSessionSecret);
  if (passwordSet !== secretSet) {
    throw new Error("Set both UI_PASSWORD and UI_SESSION_SECRET (or neither, for an open local UI)");
  }
}

export function githubSecrets(config: Config): string[] {
  return [config.github.privateKey, config.github.webhookSecret].filter((value) => value.length >= 4);
}

function clamp01(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}
