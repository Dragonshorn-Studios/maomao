import type { Config } from "./config.js";
import type { ProfileRevisionRow } from "./config-revisions.js";

/**
 * Read-only, non-sensitive effective-configuration view for the /config page.
 * Every entry states where its value comes from so operators can tell a
 * built-in default from an environment override from an active profile
 * revision.
 *
 * Security model: this module receives the full Config and touches credential
 * fields only to compute presence (length/truthiness) — GitHub private key,
 * webhook secret, OAuth client secret, UI password, session secret. No
 * credential value is ever copied into an entry; credentials appear only as
 * the strings "configured"/"not configured", always badged "environment"
 * since env is their only source. The canary tests in config-effective.test.ts
 * and server.test.ts enforce this.
 *
 * Source labels reflect presence of each entry's own env var, not parse
 * success: an invalid value silently falls back to the default inside
 * loadConfig but is still badged "environment", and aggregator/verifier
 * models inherit OPENCODE_REVIEWER_MODEL yet are badged "default" when their
 * own var is unset (marked as inherited instead).
 */

export type ConfigValueSource = "profile" | "environment" | "default";

export interface EffectiveConfigEntry {
  group: string;
  label: string;
  value: string;
  source: ConfigValueSource;
  /** Extra provenance, e.g. revision label "#12 (name)" or an inheritance note. */
  sourceDetail?: string;
  /** The value is honored by the schema but not enforced at runtime yet. */
  notEnforced?: boolean;
}

const envSet = (raw: string | undefined): boolean => Boolean(raw && raw.trim() !== "");

function boolLabel(value: boolean): string {
  return value ? "enabled" : "disabled";
}

/**
 * Builds the effective-configuration entries. `env` must be the same
 * environment object loadConfig consumed (same variables), so a value whose
 * env var is set is labeled "environment" and everything else "default";
 * active-profile overrides are labeled "profile" with the revision label.
 */
export function effectiveConfigEntries(
  config: Config,
  env: NodeJS.ProcessEnv,
  activeRevision: ProfileRevisionRow | null,
): EffectiveConfigEntry[] {
  const entries: EffectiveConfigEntry[] = [];
  const src = (envKey: string): ConfigValueSource =>
    envSet(env[envKey]) ? "environment" : "default";
  const add = (entry: EffectiveConfigEntry) => entries.push(entry);
  /** A plain env-or-default row. */
  const row = (group: string, label: string, envKey: string, value: string) => {
    add({ group, label, value, source: src(envKey) });
  };
  /** A profile-backed row; the caller has already checked the precondition. */
  const addProfile = (
    label: string,
    value: string,
    extra: Partial<EffectiveConfigEntry> = {},
  ) => {
    add({
      group: "Reviewers",
      label,
      value,
      source: "profile",
      sourceDetail: `#${activeRevision!.id} (${activeRevision!.name})`,
      ...extra,
    });
  };

  // --- Reviewer roles ---
  add({
    group: "Reviewers",
    label: "Enabled roles",
    value: config.reviewers.map((role) => role.id).join(", "),
    source: src("REVIEWER_ROLES"),
  });
  const envRoleModels = config.reviewers.filter((role) => role.model);
  if (envRoleModels.length > 0) {
    add({
      group: "Reviewers",
      label: "Per-role env models",
      value: envRoleModels.map((role) => `${role.id}: ${role.model}`).join(", "),
      source: "environment",
    });
  }
  if (activeRevision) {
    // applyProfileToSpecs runs the profile roles ∩ env roles, falling back to
    // all profile roles only when the intersection is empty.
    const envRoleIds = new Set(config.reviewers.map((role) => role.id));
    const profileRoles = activeRevision.definition.reviewers.map((reviewer) => reviewer.role);
    const intersection = profileRoles.filter((role) => envRoleIds.has(role));
    const effectiveSet =
      intersection.length > 0 ? intersection : profileRoles;
    const dropped = intersection.length > 0
      ? profileRoles.filter((role) => !envRoleIds.has(role))
      : [];
    const profileDetail = `#${activeRevision.id} (${activeRevision.name})`;
    add({
      group: "Reviewers",
      label: "Profile reviewer set (effective)",
      value:
        effectiveSet.join(", ") ||
        "(none — falls back to env roles)",
      source: "profile",
      sourceDetail: profileDetail,
      notEnforced: config.routing.mode !== "fixed",
    });
    if (dropped.length > 0) {
      add({
        group: "Reviewers",
        label: "Profile roles dropped (not in the env role list)",
        value: dropped.join(", "),
        source: "profile",
        sourceDetail: profileDetail,
      });
    }
    const profileModels = activeRevision.definition.reviewers.filter((reviewer) => reviewer.model);
    if (profileModels.length > 0) {
      addProfile(
        "Per-reviewer profile models",
        profileModels.map((reviewer) => `${reviewer.role}: ${reviewer.model}`).join(", "),
      );
    }
    const profileTimeouts = activeRevision.definition.reviewers.filter((reviewer) => reviewer.timeoutMs);
    if (profileTimeouts.length > 0) {
      add({
        group: "Budgets",
        label: "Profile per-reviewer timeouts",
        value: profileTimeouts
          .map((reviewer) => `${reviewer.role}: ${Math.round((reviewer.timeoutMs ?? 0) / 1000)}s`)
          .join(", "),
        source: "profile",
        sourceDetail: profileDetail,
      });
    }
    add({
      group: "Budgets",
      label: "Profile budget behavior",
      value:
        activeRevision.definition.onBudgetExceeded === "fail"
          ? "fail the job when a ceiling is hit"
          : "degrade — skip remaining paid stages and publish partial results",
      source: "profile",
      sourceDetail: profileDetail,
    });
  }

  // --- Models ---
  add({
    group: "Models",
    label: "Reviewer model",
    value: config.opencode.reviewerModel || "(empty — provider default)",
    source: src("OPENCODE_REVIEWER_MODEL"),
  });
  const inheritedDetail = "inherited from OPENCODE_REVIEWER_MODEL";
  add({
    group: "Models",
    label: "Aggregator model",
    value: config.opencode.aggregatorModel || "(empty — runs the reviewer model)",
    source: envSet(env.OPENCODE_AGGREGATOR_MODEL)
      ? "environment"
      : envSet(env.OPENCODE_REVIEWER_MODEL)
        ? "environment"
        : "default",
    sourceDetail: !envSet(env.OPENCODE_AGGREGATOR_MODEL) && envSet(env.OPENCODE_REVIEWER_MODEL)
      ? inheritedDetail
      : undefined,
  });
  add({
    group: "Models",
    label: "Verifier model",
    value: config.opencode.verifierModel || "(empty — reconciliation verification disabled; priors left open)",
    source: envSet(env.OPENCODE_VERIFIER_MODEL)
      ? "environment"
      : envSet(env.OPENCODE_REVIEWER_MODEL)
        ? "environment"
        : "default",
    sourceDetail: !envSet(env.OPENCODE_VERIFIER_MODEL) && envSet(env.OPENCODE_REVIEWER_MODEL)
      ? inheritedDetail
      : undefined,
  });
  // The pipeline resolves profileRouterModel || routing.model || reviewerModel.
  const routerEnvSet = envSet(env.OPENCODE_ROUTER_MODEL) || envSet(env.OPENCODE_REVIEWER_MODEL);
  const routerShadowed = Boolean(activeRevision?.definition.routerModel);
  add({
    group: "Models",
    label: "Router model (env/defaults)",
    value:
      config.routing.model || config.opencode.reviewerModel
        ? config.routing.model || config.opencode.reviewerModel
        : "(empty — deterministic routing in hybrid mode)",
    source: routerEnvSet ? "environment" : "default",
    sourceDetail: routerShadowed
      ? `not in effect — overridden by profile #${activeRevision!.id}`
      : undefined,
  });
  if (activeRevision?.definition.routerModel) {
    add({
      group: "Models",
      label: "Profile router model",
      value: activeRevision.definition.routerModel,
      source: "profile",
      sourceDetail: `#${activeRevision.id} (${activeRevision.name})`,
    });
  }
  add({
    group: "Models",
    label: "Model catalog (allowlist)",
    value: config.modelCatalog.length > 0
      ? config.modelCatalog.join(", ")
      : "(empty — any well-formed model allowed)",
    source: src("MODEL_CATALOG"),
    sourceDetail: config.modelCatalog.length > 0 ? "applies to profile revisions only" : undefined,
  });

  // --- Limits ---
  row("Limits", "Reviewer timeout", "OPENCODE_TIMEOUT_MS", `${Math.round(config.opencode.timeoutMs / 1000)}s`);
  row(
    "Limits",
    "Verifier timeout",
    "OPENCODE_VERIFIER_TIMEOUT_MS",
    `${Math.round(config.opencode.verifierTimeoutMs / 1000)}s`,
  );
  row("Limits", "Router timeout", "ROUTER_TIMEOUT_MS", `${Math.round(config.routing.timeoutMs / 1000)}s`);
  row(
    "Limits",
    "Reviewer concurrency (per job)",
    "OPENCODE_REVIEWER_CONCURRENCY",
    String(config.opencode.reviewerConcurrency),
  );
  row("Limits", "Job concurrency", "JOB_CONCURRENCY", String(config.jobConcurrency));
  row("Limits", "Reviewer retries", "OPENCODE_MAX_RETRIES", String(config.opencode.maxRetries));

  // --- Routing ---
  row("Routing", "Routing mode", "REVIEWER_ROUTING", config.routing.mode);
  row("Routing", "Router max diff chars", "ROUTER_MAX_DIFF_CHARS", String(config.routing.maxDiffChars));
  row("Routing", "Router max reviewers", "ROUTER_MAX_REVIEWERS", String(config.routing.maxReviewers));

  // --- Webhooks and access ---
  const actions = config.pullRequestActions.join(", ");
  add({
    group: "Webhooks and access",
    label: "Webhook actions that enqueue reviews",
    value: actions || "(none)",
    source: src("PULL_REQUEST_ACTIONS"),
  });
  add({
    group: "Webhooks and access",
    label: "Allowed GitHub accounts",
    value: config.allowedGithubAccountIds.length > 0
      ? config.allowedGithubAccountIds.join(", ")
      : "(empty — any installation; fail-closed per payload only when set)",
    source: src("ALLOWED_GITHUB_ACCOUNT_IDS"),
  });
  add({
    group: "Webhooks and access",
    label: "Allowed GitHub repositories",
    value: config.allowedGithubRepositoryIds.length > 0
      ? config.allowedGithubRepositoryIds.join(", ")
      : "(empty — any repository on an allowed account)",
    source: src("ALLOWED_GITHUB_REPOSITORY_IDS"),
  });
  add({
    group: "Webhooks and access",
    label: "Comment override authors",
    value: config.overrideAuthors.length > 0
      ? config.overrideAuthors.join(", ")
      : "(empty — write/maintain/admin collaborators)",
    source: src("MAOMAO_OVERRIDE_AUTHORS"),
  });
  row(
    "Webhooks and access",
    "Repository rate limit",
    "REPO_RATE_LIMIT_PER_WINDOW",
    config.repoRateLimitPerWindow > 0
      ? `${config.repoRateLimitPerWindow} per ${Math.round(config.repoRateWindowMs / 60000)}min`
      : "disabled",
  );

  // --- Publishing behavior ---
  row(
    "Publishing",
    "Request-changes minimum severity",
    "GITHUB_REVIEW_REQUEST_CHANGES_MIN_SEVERITY",
    config.reviewRequestChangesMinSeverity,
  );
  row("Publishing", "Allow APPROVE verdicts", "GITHUB_REVIEW_ALLOW_APPROVE", boolLabel(config.reviewAllowApprove));
  row(
    "Publishing",
    "Allow REQUEST_CHANGES verdicts",
    "GITHUB_REVIEW_ALLOW_REQUEST_CHANGES",
    boolLabel(config.reviewAllowRequestChanges),
  );
  row("Publishing", "Post empty reviews", "POST_EMPTY_REVIEW", boolLabel(config.postEmptyReview));
  row("Publishing", "Review drafts", "REVIEW_DRAFTS", boolLabel(config.reviewDrafts));
  row("Publishing", "Max inline comments", "MAX_INLINE_COMMENTS", String(config.maxInlineComments));
  row(
    "Publishing",
    "Diff size cap",
    "MAX_DIFF_BYTES",
    config.maxDiffBytes > 0 ? `${Math.round(config.maxDiffBytes / 1024)} KiB` : "no cap",
  );
  row(
    "Publishing",
    "Issue creation from scans",
    "GITHUB_ISSUE_CREATION_ENABLED",
    boolLabel(config.issueCreationEnabled),
  );
  if (activeRevision) {
    add({
      group: "Publishing",
      label: "Profile minimum publishable severity",
      value: activeRevision.definition.minPublishableSeverity,
      source: "profile",
      sourceDetail: `#${activeRevision.id} (${activeRevision.name})`,
    });
  }

  // --- Poison alerts ---
  row("Poison alerts", "Policy", "POISON_ALERT_POLICY", config.poisonAlert.policy);
  row(
    "Poison alerts",
    "Internal re-check",
    "POISON_ALERT_INTERNAL_ENABLED",
    boolLabel(config.poisonAlert.internal.enabled),
  );
  if (config.poisonAlert.internal.enabled) {
    row("Poison alerts", "Internal model", "POISON_ALERT_INTERNAL_MODEL", config.poisonAlert.internal.model);
    row(
      "Poison alerts",
      "Internal max cost",
      "POISON_ALERT_INTERNAL_MAX_COST_USD",
      `$${config.poisonAlert.internal.maxCostUsd.toFixed(2)}`,
    );
    row(
      "Poison alerts",
      "Internal max tokens",
      "POISON_ALERT_INTERNAL_MAX_TOKENS",
      String(config.poisonAlert.internal.maxTokens),
    );
  }
  row(
    "Poison alerts",
    "External dispatch",
    "POISON_ALERT_EXTERNAL_ENABLED",
    boolLabel(config.poisonAlert.external.enabled),
  );
  row(
    "Poison alerts",
    "External minimum severity",
    "POISON_ALERT_EXTERNAL_MIN_SEVERITY",
    config.poisonAlert.external.minSeverity,
  );
  if (activeRevision?.definition.maxTotalCostUsd != null) {
    add({
      group: "Budgets",
      label: "Profile total cost ceiling",
      value: `$${activeRevision.definition.maxTotalCostUsd.toFixed(2)}`,
      source: "profile",
      sourceDetail: `#${activeRevision.id} (${activeRevision.name})`,
    });
  }
  if (activeRevision?.definition.maxTotalTokens != null) {
    add({
      group: "Budgets",
      label: "Profile total token ceiling",
      value: String(activeRevision.definition.maxTotalTokens),
      source: "profile",
      sourceDetail: `#${activeRevision.id} (${activeRevision.name})`,
    });
  }

  // --- Runner ---
  row("Runner", "OpenCode binary", "OPENCODE_BIN", config.opencode.bin);
  row(
    "Runner",
    "OpenCode extra args",
    "OPENCODE_EXTRA_ARGS",
    config.opencode.extraArgs.length > 0 ? config.opencode.extraArgs.join(" ") : "(none)",
  );

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
  const oauthOn = Boolean(config.oauthClientId) && Boolean(config.oauthClientSecret);
  const passwordFormServed = config.uiPassword.length > 0 && (!oauthOn || config.uiLocalLogin);
  add({
    group: "Credentials",
    label: "UI password gate",
    value: passwordFormServed
      ? "active"
      : config.uiPassword.length > 0
        ? "inactive (password form not shown while OAuth login is enabled; set UI_LOCAL_LOGIN=true)"
        : "not configured",
    source: "environment",
  });

  return entries;
}
