/**
 * Readable one-line GitHub failures for job logs and finding cards.
 * Octokit GraphQL errors bury the useful text in `errors[].message`; REST
 * errors append a docs URL. Operators were only seeing "GitHub resolve
 * failed; will retry next review" because the pipeline discarded both.
 */

const MAX_REASON = 280;

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("status" in error) {
    const status = Number((error as { status: unknown }).status);
    if (Number.isFinite(status) && status > 0) return status;
  }
  const nested = "response" in error ? (error as { response?: { status?: unknown } }).response : undefined;
  const nestedStatus = Number(nested?.status);
  if (Number.isFinite(nestedStatus) && nestedStatus > 0) return nestedStatus;
  return undefined;
}

function graphqlEntries(error: unknown): Array<{ type?: string; message?: string }> {
  if (!error || typeof error !== "object" || !("errors" in error)) return [];
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { type?: unknown; message?: unknown };
    return [
      {
        type: typeof record.type === "string" ? record.type : undefined,
        message: typeof record.message === "string" ? record.message : undefined,
      },
    ];
  });
}

function cleanMessage(raw: string): string {
  return raw
    .replace(/https?:\/\/docs\.github\.com\S+/g, "")
    .replace(/^Request failed due to following response errors:\s*/i, "")
    .replace(/^\s*-\s*/gm, "")
    .replace(/\s+/g, " ")
    .replace(/\s+-\s*$/, "")
    .trim();
}

function rawDetail(error: unknown): string {
  const graphql = graphqlEntries(error)
    .map((entry) => entry.message?.trim())
    .filter((message): message is string => Boolean(message));
  const fallback = error instanceof Error ? error.message : String(error);
  return cleanMessage(graphql.length > 0 ? graphql.join("; ") : fallback);
}

const MISSING_NODE =
  /could not resolve to a node with the global id|pullrequestreviewthread was not found|could not resolve to a pullrequestreviewthread/i;

export function isMissingGithubNodeError(error: unknown): boolean {
  if (graphqlEntries(error).some((entry) => entry.type === "NOT_FOUND")) return true;
  return MISSING_NODE.test(rawDetail(error));
}

function classify(status: number | undefined, detail: string): string | undefined {
  if (MISSING_NODE.test(detail) || /\bnot_found\b/i.test(detail)) {
    return "GitHub thread or issue no longer exists";
  }
  if (status === 401 || /bad credentials|requires authentication|\bunauthorized\b/i.test(detail)) {
    return "GitHub authentication failed";
  }
  if (/secondary rate|rate limit/i.test(detail) || status === 429) {
    return "GitHub rate limited the app";
  }
  if (status === 403 || /not accessible by integration|resource not accessible|\bforbidden\b/i.test(detail)) {
    return "GitHub App lacks permission";
  }
  if (status === 422 || /validation failed/i.test(detail)) {
    return "GitHub rejected the request";
  }
  if (status && status >= 500) return `GitHub returned HTTP ${status}`;
  return undefined;
}

function isIntegrationForbidden(detail: string): boolean {
  return /not accessible by integration|resource not accessible|\bforbidden\b/i.test(detail);
}

/**
 * GitHub returns the same FORBIDDEN text for several missing App permissions.
 * Resolving a review thread is gated on Contents write (repo write), not on
 * Pull requests write. Closing an issue is gated on Issues write.
 */
function integrationPermissionHint(kind: "thread" | "issue", detail: string): string {
  if (/Contents must be Read & write|Issues must be Read & write/.test(detail)) return detail;
  if (!isIntegrationForbidden(detail)) return detail;
  if (kind === "issue") {
    return `Issues must be Read & write, then re-approve the installation (${detail})`;
  }
  return `Contents must be Read & write, then re-approve the installation (${detail})`;
}

export function describeGithubError(error: unknown): string {
  const status = statusOf(error);
  const detail = rawDetail(error) || "unknown GitHub error";
  const hint = classify(status, detail);
  const combined =
    hint && !detail.toLowerCase().includes(hint.toLowerCase()) ? `${hint}: ${detail}` : hint || detail;
  if (combined.length <= MAX_REASON) return combined;
  return `${combined.slice(0, MAX_REASON - 1)}…`;
}

export function githubRetryReason(kind: "thread" | "issue", error: unknown): string {
  const detail = integrationPermissionHint(
    kind,
    typeof error === "string" ? error : describeGithubError(error),
  );
  if (kind === "issue") {
    return `GitHub issue close failed (${detail}); will retry next scan.`;
  }
  return `GitHub resolve failed (${detail}); will retry next review.`;
}

/** Same Contents-write hint for @maomao dismiss/reopen command warnings. */
export function describeThreadResolveError(error: unknown): string {
  return integrationPermissionHint("thread", describeGithubError(error));
}
