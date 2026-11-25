import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrustedCheckFinding, TrustedCheckName } from "./trusted.js";

export type TrustedSeverity = TrustedCheckFinding["severity"];
const SEVERITY_ORDER: TrustedSeverity[] = ["info", "low", "medium", "high", "blocker"];

export interface TrustedPolicySuppression {
  check?: TrustedCheckName;
  fingerprint: string;
  reason: string;
}

export interface TrustedRepoPolicy {
  requireReview: boolean;
  requiredChecks: TrustedCheckName[];
  severityThreshold: TrustedSeverity;
  suppressions: TrustedPolicySuppression[];
}

export interface ResolvedTrustedPolicy extends TrustedRepoPolicy {
  revision: string;
  source: "trusted-repo" | "default";
}

export function findingFingerprint(name: TrustedCheckName, finding: TrustedCheckFinding): string {
  return createHash("sha256")
    .update(JSON.stringify([name, finding.category, finding.file ?? "", finding.line ?? 0, finding.summary]))
    .digest("hex");
}

function severityAtLeast(severity: TrustedSeverity, threshold: TrustedSeverity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function thresholdOr(value: unknown, fallback: TrustedSeverity): TrustedSeverity {
  if (value == null) return fallback;
  if (typeof value !== "string" || !SEVERITY_ORDER.includes(value as TrustedSeverity)) throw new Error("trusted policy severityThreshold is invalid");
  return value as TrustedSeverity;
}

function checksOr(value: unknown, fallback: TrustedCheckName[]): TrustedCheckName[] {
  if (value == null) return fallback;
  if (!Array.isArray(value) || value.some((item) => item !== "secrets" && item !== "security")) {
    throw new Error("trusted policy requiredChecks must contain only secrets/security");
  }
  return value as TrustedCheckName[];
}

function suppressionsOr(value: unknown): TrustedPolicySuppression[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("trusted policy suppressions must be an array");
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.fingerprint) || typeof row.reason !== "string" || !row.reason.trim()) {
      throw new Error("trusted policy suppressions require a 64-character lowercase fingerprint and reason");
    }
    return [{
      ...(row.check === "secrets" || row.check === "security" ? { check: row.check } : {}),
      fingerprint: row.fingerprint,
      reason: row.reason.trim().slice(0, 500),
    }];
  });
}

function mergePolicy(raw: unknown, fallback: TrustedRepoPolicy): TrustedRepoPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const value = raw as Record<string, unknown>;
  return {
    requireReview: boolOr(value.requireReview, fallback.requireReview),
    requiredChecks: checksOr(value.requiredChecks, fallback.requiredChecks),
    severityThreshold: thresholdOr(value.severityThreshold, fallback.severityThreshold),
    suppressions: [...fallback.suppressions, ...suppressionsOr(value.suppressions)],
  };
}

export function defaultTrustedPolicy(enabledChecks: TrustedCheckName[], revision: string): ResolvedTrustedPolicy {
  return {
    requireReview: false,
    requiredChecks: [...enabledChecks],
    severityThreshold: "high",
    suppressions: [],
    revision,
    source: "default",
  };
}

/**
 * Reads optional operator-owned maomao-policy.json from the pinned trusted
 * checkout. `defaults` apply to every repository and `repositories` may refine
 * one exact owner/repo key. Invalid JSON or schema version fails closed.
 */
export async function readTrustedPolicy(trustedDir: string, repoFullName: string, enabledChecks: TrustedCheckName[], revision: string): Promise<ResolvedTrustedPolicy> {
  let raw: string;
  try {
    raw = await readFile(join(trustedDir, "maomao-policy.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultTrustedPolicy(enabledChecks, revision);
    throw error;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1) {
    throw new Error("trusted policy must be a version-1 JSON object");
  }
  const base = mergePolicy(parsed.defaults, {
    requireReview: false,
    requiredChecks: [...enabledChecks],
    severityThreshold: "high",
    suppressions: [],
  });
  const repositories = parsed.repositories && typeof parsed.repositories === "object" && !Array.isArray(parsed.repositories)
    ? parsed.repositories as Record<string, unknown>
    : {};
  const merged = mergePolicy(repositories[repoFullName], base);
  return { ...merged, revision, source: "trusted-repo" };
}

/** Applies severity threshold and auditable suppressions to scanner output. */
export function applyTrustedPolicy<T extends {
  name: TrustedCheckName;
  status: "success" | "failure" | "error" | "skipped";
  conclusion: "success" | "failure" | "action_required" | "skipped";
  findings: TrustedCheckFinding[];
}>(result: T, policy: TrustedRepoPolicy): T & { suppressedFindings: number } {
  if (result.status !== "failure") return { ...result, suppressedFindings: 0 };
  const suppressed = new Set(policy.suppressions.filter((item) => !item.check || item.check === result.name).map((item) => item.fingerprint));
  const kept = result.findings.filter((finding) =>
    !suppressed.has(findingFingerprint(result.name, finding)) && severityAtLeast(finding.severity, policy.severityThreshold),
  );
  if (kept.length > 0) return { ...result, findings: kept, suppressedFindings: result.findings.length - kept.length };
  return {
    ...result,
    status: "success",
    conclusion: "success",
    findings: [],
    suppressedFindings: result.findings.length,
  };
}
