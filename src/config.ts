import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { clamp, parseBoolean, parseCsv, parseIdList, parseInteger, replaceEscapedNewlines } from "./util.js";
import { DEFAULT_REVIEWER_ROLES, type ReviewerRole } from "./prompts.js";

export type JobState =
  | "queued"
  | "preparing"
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
  extraArgs: string[];
  timeoutMs: number;
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
  jobConcurrency: number;
  reviewDrafts: boolean;
  postEmptyReview: boolean;
  pullRequestActions: PullRequestAction[];
  maxInlineComments: number;
  uiPassword: string;
  uiSessionSecret: string;
  /** GitHub user/org node ids (`installation.account.id`). Empty = unrestricted on this axis. */
  allowedGithubAccountIds: number[];
  /** GitHub repository node ids (`repository.id`). Empty = unrestricted on this axis. */
  allowedGithubRepositoryIds: number[];
  /** Max pull-request diff size in bytes before OpenCode. `0` disables the cap. */
  maxDiffBytes: number;
  /** Max review jobs accepted per repository id inside `repoRateWindowMs`. `0` disables. */
  repoRateLimitPerWindow: number;
  repoRateWindowMs: number;
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
  const byId = new Map(DEFAULT_REVIEWER_ROLES.map((role) => [role.id, role]));
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
      extraArgs: parseCsv(env.OPENCODE_EXTRA_ARGS).flatMap((arg) => arg.split(" ")).filter(Boolean),
      timeoutMs: parseInteger(env.OPENCODE_TIMEOUT_MS, 10 * 60 * 1000),
      maxRetries: clamp(parseInteger(env.OPENCODE_MAX_RETRIES, 1), 0, 5),
      reviewerConcurrency: Math.max(1, parseInteger(env.OPENCODE_REVIEWER_CONCURRENCY, 2)),
    },
    reviewers: loadReviewers(env),
    jobConcurrency: Math.max(1, parseInteger(env.JOB_CONCURRENCY, 1)),
    reviewDrafts: parseBoolean(env.REVIEW_DRAFTS, false),
    postEmptyReview: parseBoolean(env.POST_EMPTY_REVIEW, false),
    pullRequestActions,
    maxInlineComments: Math.max(0, parseInteger(env.MAX_INLINE_COMMENTS, 12)),
    uiPassword: env.UI_PASSWORD?.trim() || env.MAOMAO_UI_PASSWORD?.trim() || "",
    uiSessionSecret: env.UI_SESSION_SECRET?.trim() || env.MAOMAO_UI_SESSION_SECRET?.trim() || "",
    allowedGithubAccountIds: parseIdList(env.ALLOWED_GITHUB_ACCOUNT_IDS),
    allowedGithubRepositoryIds: parseIdList(env.ALLOWED_GITHUB_REPOSITORY_IDS),
    maxDiffBytes: clamp(parseInteger(env.MAX_DIFF_BYTES, 1_048_576), 0, 50 * 1024 * 1024),
    repoRateLimitPerWindow: Math.max(0, parseInteger(env.REPO_RATE_LIMIT_PER_WINDOW, 6)),
    repoRateWindowMs: Math.max(0, parseInteger(env.REPO_RATE_WINDOW_MS, 60 * 60 * 1000)),
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
  const passwordSet = Boolean(config.uiPassword);
  const secretSet = Boolean(config.uiSessionSecret);
  if (passwordSet !== secretSet) {
    throw new Error("Set both UI_PASSWORD and UI_SESSION_SECRET (or neither, for an open local UI)");
  }
}

export function githubSecrets(config: Config): string[] {
  return [config.github.privateKey, config.github.webhookSecret].filter((value) => value.length >= 4);
}
