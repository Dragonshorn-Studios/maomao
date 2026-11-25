import type { TrustedCheckName } from "./trusted.js";
import { trustedCheckNativeName } from "./trusted.js";

export interface MergeReadinessDecision {
  conclusion: "success" | "failure" | "action_required";
  detail: string;
}

/** Pure exact-input merge-readiness aggregation; callers bind it to one head SHA. */
export function mergeReadinessDecision(input: {
  reviewConclusion?: string;
  requireReview: boolean;
  requiredChecks: TrustedCheckName[];
  results: Array<{ name: string; status: string }>;
}): MergeReadinessDecision {
  const failures: string[] = [];
  const errors: string[] = [];
  if (input.reviewConclusion === "failure" || input.reviewConclusion === "timed_out") failures.push("review");
  if (input.requireReview && input.reviewConclusion !== "success") failures.push("review did not pass required policy");
  for (const name of input.requiredChecks) {
    const native = trustedCheckNativeName(name);
    const row = input.results.find((candidate) => candidate.name === native);
    if (!row) errors.push(`${native} missing`);
    else if (row.status === "failure") failures.push(native);
    else if (row.status !== "success") errors.push(`${native} ${row.status}`);
  }
  return {
    conclusion: failures.length ? "failure" : errors.length ? "action_required" : "success",
    detail: failures.length || errors.length
      ? [...failures.map((item) => `blocking: ${item}`), ...errors.map((item) => `unavailable: ${item}`)].join("; ")
      : "all required review and deterministic check inputs passed",
  };
}
