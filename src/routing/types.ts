export const REVIEW_PROFILES = ["observation", "diagnosis", "poison-alert"] as const;
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];

export const ROUTING_MODES = ["hybrid", "deterministic", "model", "fixed"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const POISON_ALERT_POLICIES = [
  "internal_only",
  "external_only",
  "internal_then_external",
  "internal_and_external",
  "manual",
] as const;
export type PoisonAlertPolicy = (typeof POISON_ALERT_POLICIES)[number];

export const EXTERNAL_DISPATCH_STATUSES = ["not_requested", "dispatching", "dispatched", "dispatch_failed"] as const;
export type ExternalDispatchStatus = (typeof EXTERNAL_DISPATCH_STATUSES)[number];

export const HARD_RISK_FAMILIES = ["auth", "secrets", "billing", "migrations", "deploy"] as const;
export type HardRiskFamily = (typeof HARD_RISK_FAMILIES)[number];

export const SIGNAL_FAMILIES = [
  ...HARD_RISK_FAMILIES,
  "concurrency",
  "api",
  "dependencies",
  "tests",
  "docs",
] as const;
export type SignalFamily = (typeof SIGNAL_FAMILIES)[number];

export interface ChangedFileSignal {
  path: string;
  language: string;
  added: number;
  removed: number;
  families: SignalFamily[];
  isTest: boolean;
  isLockfile: boolean;
  isDocs: boolean;
}

export interface RoutingSignals {
  fileCount: number;
  addedLines: number;
  removedLines: number;
  languages: string[];
  families: SignalFamily[];
  hardRiskFamilies: HardRiskFamily[];
  files: ChangedFileSignal[];
  testsAdded: boolean;
  testsMissing: boolean;
  lockfileChanged: boolean;
  titleHints: SignalFamily[];
  bodyHints: SignalFamily[];
}

export interface RoutingDecision {
  profile: ReviewProfile;
  reviewers: string[];
  reason: string;
  confidence: number;
  source: "deterministic" | "model" | "hybrid" | "fallback" | "fixed" | "hard-rule";
  signals: RoutingSignals;
  hardRuleEscalated: boolean;
  modelRaw?: string;
}

export type ExternalTarget =
  | { type: "mention"; recipient: string }
  | { type: "command"; recipient: string; command: string }
  | { type: "webhook"; urlSecretRef: string; signingSecretRef: string };

export interface RouterConfig {
  mode: RoutingMode;
  model: string;
  timeoutMs: number;
  maxDiffChars: number;
  maxReviewers: number;
  maxContextChars: number;
  observationMaxFiles: number;
  observationMaxLines: number;
  poisonAlertMinFiles: number;
  poisonAlertMinLines: number;
}

export interface PoisonAlertInternalConfig {
  enabled: boolean;
  model: string;
  maxCostUsd: number;
  maxTokens: number;
  timeoutSeconds: number;
  retries: number;
  context: "findings_and_relevant_hunks";
  fallback: "keep_first_pass" | "fail";
}

export interface PoisonAlertExternalConfig {
  enabled: boolean;
  targets: ExternalTarget[];
  minSeverity: "blocker" | "high" | "medium" | "low" | "info";
}

export interface PoisonAlertConfig {
  policy: PoisonAlertPolicy;
  mentionName: string;
  escalateCommand: string;
  internal: PoisonAlertInternalConfig;
  external: PoisonAlertExternalConfig;
}
