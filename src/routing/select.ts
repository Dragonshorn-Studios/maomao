import type { RouterConfig, RoutingDecision, RoutingSignals, ReviewProfile } from "./types.js";

const FAMILY_ROLES: Record<string, string[]> = {
  auth: ["security", "correctness"],
  secrets: ["security", "maintainer"],
  billing: ["security", "api", "correctness"],
  migrations: ["data-integrity", "correctness", "maintainer"],
  deploy: ["security", "maintainer"],
  concurrency: ["concurrency", "correctness"],
  api: ["api", "correctness"],
  dependencies: ["security", "maintainer"],
  tests: ["tests"],
  docs: ["maintainer"],
};

const PROFILE_RANK: Record<ReviewProfile, number> = {
  observation: 0,
  diagnosis: 1,
  "poison-alert": 2,
};

export function rankProfile(profile: ReviewProfile): number {
  return PROFILE_RANK[profile];
}

export function maxProfile(a: ReviewProfile, b: ReviewProfile): ReviewProfile {
  return rankProfile(a) >= rankProfile(b) ? a : b;
}

export function filterAllowedRoles(roles: string[], allowlist: string[]): string[] {
  const allowed = new Set(allowlist);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const role of roles) {
    if (!allowed.has(role) || seen.has(role)) continue;
    seen.add(role);
    out.push(role);
  }
  return out;
}

export function rolesForSignals(signals: RoutingSignals, allowlist: string[]): string[] {
  const suggested: string[] = ["correctness"];
  for (const family of signals.families) {
    suggested.push(...(FAMILY_ROLES[family] ?? []));
  }
  if (signals.testsMissing) suggested.push("tests");
  if (signals.fileCount >= 8) suggested.push("architecture");
  if (allowlist.includes("maintainer") && (signals.hardRiskFamilies.length > 0 || signals.lockfileChanged)) {
    suggested.push("maintainer");
  }
  const filtered = filterAllowedRoles(suggested, allowlist);
  if (filtered.length > 0) return filtered;
  return allowlist.slice(0, Math.max(1, allowlist.length));
}

export function deterministicProfile(signals: RoutingSignals, config: RouterConfig): ReviewProfile {
  if (signals.hardRiskFamilies.length > 0) return "poison-alert";
  const totalLines = signals.addedLines + signals.removedLines;
  if (signals.fileCount >= config.poisonAlertMinFiles || totalLines >= config.poisonAlertMinLines) {
    return "poison-alert";
  }
  const onlyDocsOrTests =
    signals.fileCount > 0 &&
    signals.files.every((file) => file.isDocs || file.isTest) &&
    !signals.lockfileChanged;
  if (
    signals.fileCount <= config.observationMaxFiles &&
    totalLines <= config.observationMaxLines &&
    signals.hardRiskFamilies.length === 0 &&
    (onlyDocsOrTests || totalLines <= Math.min(20, config.observationMaxLines))
  ) {
    return "observation";
  }
  return "diagnosis";
}

export function capReviewers(roles: string[], profile: ReviewProfile, config: RouterConfig): string[] {
  const observationCap = Math.min(2, config.maxReviewers);
  const diagnosisCap = Math.min(4, config.maxReviewers);
  const cap =
    profile === "observation" ? observationCap : profile === "diagnosis" ? diagnosisCap : config.maxReviewers;
  if (roles.length <= cap) return roles;
  const preferred = ["correctness", "security", "tests", "data-integrity", "concurrency", "api", "maintainer", "architecture"];
  const ordered = [...roles].sort((a, b) => {
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return ordered.slice(0, Math.max(1, cap));
}

export function applyHardRuleOverride(
  profile: ReviewProfile,
  reviewers: string[],
  signals: RoutingSignals,
  allowlist: string[],
  config: RouterConfig,
): { profile: ReviewProfile; reviewers: string[]; hardRuleEscalated: boolean } {
  const deterministic = deterministicProfile(signals, config);
  const escalated = rankProfile(deterministic) > rankProfile(profile);
  const nextProfile = maxProfile(profile, deterministic);
  let nextReviewers = filterAllowedRoles(reviewers, allowlist);
  if (nextReviewers.length === 0 || nextProfile !== profile) {
    nextReviewers = rolesForSignals(signals, allowlist);
  }
  if (nextProfile === "poison-alert") {
    nextReviewers = filterAllowedRoles([...nextReviewers, ...rolesForSignals(signals, allowlist)], allowlist);
  }
  return {
    profile: nextProfile,
    reviewers: capReviewers(nextReviewers, nextProfile, config),
    hardRuleEscalated: escalated || signals.hardRiskFamilies.length > 0 && nextProfile === "poison-alert" && profile !== "poison-alert",
  };
}

export function diagnosisFallback(
  signals: RoutingSignals,
  allowlist: string[],
  config: RouterConfig,
  reason: string,
): RoutingDecision {
  const profile = maxProfile("diagnosis", deterministicProfile(signals, config));
  return {
    profile,
    reviewers: capReviewers(rolesForSignals(signals, allowlist), profile, config),
    reason,
    confidence: 0.4,
    source: "fallback",
    signals,
    hardRuleEscalated: profile === "poison-alert" && signals.hardRiskFamilies.length > 0,
  };
}

export function deterministicDecision(
  signals: RoutingSignals,
  allowlist: string[],
  config: RouterConfig,
): RoutingDecision {
  const profile = deterministicProfile(signals, config);
  const reason =
    signals.hardRiskFamilies.length > 0
      ? `Hard-risk signals: ${signals.hardRiskFamilies.join(", ")}`
      : profile === "observation"
        ? `Narrow change: ${signals.fileCount} file(s), ${signals.addedLines + signals.removedLines} line(s)`
        : profile === "poison-alert"
          ? `Large change: ${signals.fileCount} file(s), ${signals.addedLines + signals.removedLines} line(s)`
          : `Ordinary change across ${signals.fileCount} file(s)`;
  return {
    profile,
    reviewers: capReviewers(rolesForSignals(signals, allowlist), profile, config),
    reason,
    confidence: signals.hardRiskFamilies.length > 0 ? 0.95 : 0.7,
    source: "deterministic",
    signals,
    hardRuleEscalated: false,
  };
}

export function mergeModelDecision(
  model: { profile: ReviewProfile; reviewers: string[]; reason: string; confidence: number },
  signals: RoutingSignals,
  allowlist: string[],
  config: RouterConfig,
  raw?: string,
): RoutingDecision {
  const overridden = applyHardRuleOverride(model.profile, model.reviewers, signals, allowlist, config);
  return {
    profile: overridden.profile,
    reviewers: overridden.reviewers,
    reason: overridden.hardRuleEscalated
      ? `${model.reason} (escalated by hard-risk rules: ${signals.hardRiskFamilies.join(", ") || "size"})`
      : model.reason,
    confidence: model.confidence,
    source: overridden.hardRuleEscalated ? "hard-rule" : "hybrid",
    signals,
    hardRuleEscalated: overridden.hardRuleEscalated,
    modelRaw: raw,
  };
}
