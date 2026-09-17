import type { Config } from "./config.js";
import type { ProfileRevisionRow } from "./config-revisions.js";

/**
 * Read-only, non-sensitive effective-configuration view for the /config page.
 * Every entry states where its value comes from so operators can tell a
 * built-in default from an environment override from an active profile
 * revision.
 *
 * Security model: this module receives the full Config but NEVER reads
 * credential fields (GitHub private key / webhook secret / OAuth secret,
 * UI password / session secret, provider keys). Those appear only as
 * configured / not configured booleans, and no entry value ever embeds a
 * secret.
 */

export type ConfigValueSource = "profile" | "environment" | "default";

export interface EffectiveConfigEntry {
  group: string;
  label: string;
  value: string;
  source: ConfigValueSource;
  /** Revision id when source is "profile". */
  sourceDetail?: string;
  /** The value is honored by the schema but not enforced at runtime yet. */
  notEnforced?: boolean;
}

const envSet = (raw: string | undefined): boolean => Boolean(raw && raw.trim() !== "");

function boolLabel(value: boolean): string {
  return value ? "enabled" : "disabled";
}

/**
 * Builds the effective-configuration entries. `env` is the same environment
 * object loadConfig consumed, so a value whose env var is set is labeled
 * "environment" and everything else "default"; active-profile overrides are
 * labeled "profile" with the revision id.
 */
export function effectiveConfigEntries(
  config: Config,
  env: NodeJS.ProcessEnv,
  activeRevision: ProfileRevisionRow | null,
): EffectiveConfigEntry[] {
  const profileSource: { source: ConfigValueSource; sourceDetail?: string } = activeRevision
    ? { source: "profile", sourceDetail: `#${activeRevision.id} (${activeRevision.name})` }
    : { source: "default" };

  const entries: EffectiveConfigEntry[] = [];
  const add = (entry: EffectiveConfigEntry) => entries.push(entry);

  // --- Reviewer roles ---
  const envRoles = envSet(env.REVIEWER_ROLES);
  const envRoleList = envRoles
    ? (env.REVIEWER_ROLES ?? "").split(",").map((role) => role.trim()).filter(Boolean)
    : [];
  add({
    group: "Reviewers",
    label: "Enabled roles (env/default)",
    value: config.reviewers.map((role) => role.id).join(", "),
    source: envRoles ? "environment" : "default",
  });
  if (activeRevision) {
    add({
      group: "Reviewers",
      label: "Profile reviewer set",
      value:
        activeRevision.definition.reviewers.map((reviewer) => reviewer.role).join(", ") ||
        "(none — falls back to env roles)",
      ...profileSource,
    });
    const profileModels = activeRevision.definition.reviewers.filter((reviewer) => reviewer.model);
    if (profileModels.length > 0) {
      add({
        group: "Reviewers",
        label: "Per-reviewer profile models",
        value: profileModels.map((reviewer) => `${reviewer.role}: ${reviewer.model}`).join(", "),
        ...profileSource,
      });
    }
  }

  // --- Models ---
  const model = (value: string, envKey: string, label: string) => {
    add({
      group: "Models",
      label,
      value: value || "(empty — provider default)",
      source: envSet(env[envKey]) ? "environment" : "default",
    });
  };
  model(config.opencode.reviewerModel, "OPENCODE_REVIEWER_MODEL", "Reviewer model");
  model(config.opencode.aggregatorModel, "OPENCODE_AGGREGATOR_MODEL", "Aggregator model");
  model(config.opencode.verifierModel, "OPENCODE_VERIFIER_MODEL", "Verifier model");
  model(config.routing.model, "OPENCODE_ROUTER_MODEL", "Router model");
  if (activeRevision?.definition.routerModel) {
    add({
      group: "Models",
      label: "Profile router model",
      value: activeRevision.definition.routerModel,
      ...profileSource,
    });
  }
  add({
    group: "Models",
    label: "Model catalog (allowlist)",
    value: config.modelCatalog.length > 0 ? config.modelCatalog.join(", ") : "(empty — any well-formed model allowed)",
    source: envSet(env.MODEL_CATALOG) ? "environment" : "default",
  });

  // --- Timeouts and concurrency ---
  add({
    group: "Limits",
    label: "Reviewer timeout",
    value: `${Math.round(config.opencode.timeoutMs / 1000)}s`,
    source: envSet(env.OPENCODE_TIMEOUT_MS) ? "environment" : "default",
  });
  add({
    group: "Limits",
    label: "Verifier timeout",
    value: `${Math.round(config.opencode.verifierTimeoutMs / 1000)}s`,
    source: envSet(env.OPENCODE_VERIFIER_TIMEOUT_MS) ? "environment" : "default",
  });
  add({
    group: "Limits",
    label: "Router timeout",
    value: `${Math.round(config.routing.timeoutMs / 1000)}s`,
    source: envSet(env.ROUTER_TIMEOUT_MS) ? "environment" : "default",
  });
  add({
    group: "Limits",
    label: "Reviewer concurrency (per job)",
    value: String(config.opencode.reviewerConcurrency),
    source: envSet(env.OPENCODE_REVIEWER_CONCURRENCY) ? "environment" : "default",
  });
  add({
    group: "Limits",
    label: "Job concurrency",
    value: String(config.jobConcurrency),
    source: envSet(env.JOB_CONCURRENCY) ? "environment" : "default",
  });
  add({
    group: "Limits",
    label: "Reviewer retries",
    value: String(config.opencode.maxRetries),
    source: envSet(env.OPENCODE_MAX_RETRIES) ? "environment" : "default",
  });

  // --- Routing ---
  add({
    group: "Routing",
    label: "Routing mode",
    value: config.routing.mode,
    source: envSet(env.REVIEWER_ROUTING) ? "environment" : "default",
  });
  add({
    group: "Routing",
    label: "Router max diff chars",
    value: String(config.routing.maxDiffChars),
    source: envSet(env.ROUTER_MAX_DIFF_CHARS) ? "environment" : "default",
  });
  add({
    group: "Routing",
    label: "Router max reviewers",
    value: String(config.routing.maxReviewers),
    source: envSet(env.ROUTER_MAX_REVIEWERS) ? "environment" : "default",
  });

  // --- Publishing behavior ---
  const severity = (value: string) => value;
  add({
    group: "Publishing",
    label: "Request-changes minimum severity",
    value: severity(config.reviewRequestChangesMinSeverity),
    source: envSet(env.GITHUB_REVIEW_REQUEST_CHANGES_MIN_SEVERITY) ? "environment" : "default",
  });
  add({
    group: "Publishing",
    label: "Allow APPROVE verdicts",
    value: boolLabel(config.reviewAllowApprove),
    source: envSet(env.GITHUB_REVIEW_ALLOW_APPROVE) ? "environment" : "default",
  });
  add({
    group: "Publishing",
    label: "Allow REQUEST_CHANGES verdicts",
    value: boolLabel(config.reviewAllowRequestChanges),
    source: envSet(env.GITHUB_REVIEW_ALLOW_REQUEST_CHANGES) ? "environment" : "default",
  });
  add({
    group: "Publishing",
    label: "Post empty reviews",
    value: boolLabel(config.postEmptyReview),
    source: envSet(env.POST_EMPTY_REVIEW) ? "environment" : "default",
  });
  add({
    group: "Publishing",
    label: "Review drafts",
    value: boolLabel(config.reviewDrafts),
    source: envSet(env.REVIEW_DRAFTS) ? "environment" : "default",
  });
  add({
    group: "Publishing",
    label: "Max inline comments",
    value: String(config.maxInlineComments),
    source: envSet(env.MAX_INLINE_COMMENTS) ? "environment" : "default",
  });
  add({
    group: "Publishing",
    label: "Diff size cap",
    value: config.maxDiffBytes > 0 ? `${Math.round(config.maxDiffBytes / 1024)} KiB` : "no cap",
    source: envSet(env.MAX_DIFF_BYTES) ? "environment" : "default",
  });
  if (activeRevision) {
    add({
      group: "Publishing",
      label: "Profile minimum publishable severity",
      value: activeRevision.definition.minPublishableSeverity,
      ...profileSource,
    });
  }

  // --- Budgets ---
  add({
    group: "Budgets",
    label: "Poison-alert internal max cost",
    value: `$${config.poisonAlert.internal.maxCostUsd.toFixed(2)}`,
    source: envSet(env.POISON_ALERT_INTERNAL_MAX_COST_USD) ? "environment" : "default",
  });
  add({
    group: "Budgets",
    label: "Poison-alert internal max tokens",
    value: String(config.poisonAlert.internal.maxTokens),
    source: envSet(env.POISON_ALERT_INTERNAL_MAX_TOKENS) ? "environment" : "default",
  });
  if (activeRevision?.definition.maxTotalCostUsd != null) {
    add({
      group: "Budgets",
      label: "Profile total cost ceiling",
      value: `$${activeRevision.definition.maxTotalCostUsd.toFixed(2)}`,
      ...profileSource,
      notEnforced: true,
    });
  }
  if (activeRevision?.definition.maxTotalTokens != null) {
    add({
      group: "Budgets",
      label: "Profile total token ceiling",
      value: String(activeRevision.definition.maxTotalTokens),
      ...profileSource,
      notEnforced: true,
    });
  }
  const profileTimeouts = activeRevision?.definition.reviewers.filter((reviewer) => reviewer.timeoutMs) ?? [];
  if (profileTimeouts.length > 0) {
    add({
      group: "Budgets",
      label: "Profile per-reviewer timeouts",
      value: profileTimeouts.map((reviewer) => `${reviewer.role}: ${Math.round((reviewer.timeoutMs ?? 0) / 1000)}s`).join(", "),
      ...profileSource,
      notEnforced: true,
    });
  }

  // --- Credentials (presence only, never values) ---
  const configured = (set: boolean) => (set ? "configured" : "not configured");
  add({
    group: "Credentials",
    label: "GitHub App credentials",
    value: configured(Boolean(config.github.appId) && config.github.privateKey.length > 0),
    source: "environment",
  });
  add({
    group: "Credentials",
    label: "GitHub webhook secret",
    value: configured(config.github.webhookSecret.length > 0),
    source: "environment",
  });
  add({
    group: "Credentials",
    label: "GitHub OAuth operator login",
    value: configured(Boolean(config.oauthClientId) && Boolean(config.oauthClientSecret)),
    source: "environment",
  });
  add({
    group: "Credentials",
    label: "UI password gate",
    value: configured(config.uiPassword.length > 0 && config.uiSessionSecret.length > 0),
    source: "environment",
  });

  return entries;
}
