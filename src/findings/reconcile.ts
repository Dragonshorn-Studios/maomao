import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { ForgeDiscussion } from "../forge/types.js";
import { findingComment, isMaomaoDiscussion, parseDiscussionFindingMarker } from "../forge/discussions.js";
import type { JobRow, JobStore } from "../jobs/store.js";
import type { OpenCodePort, OpenCodeUsage } from "../opencode/parse.js";
import { buildVerifierPrompt } from "../prompts.js";
import type { AggregatorFinding } from "../schema.js";
import { parseVerifierResult } from "../schema.js";
import { fingerprintFinding, stripHtmlComments } from "./identity.js";
import { boundContexts, collectFindingContext } from "./context.js";
import type { ClassifiedFinding, FindingClassification, ReconciliationSnapshot } from "./types.js";
import { currentFindingsForRisk } from "./types.js";

export interface PriorFinding {
  fingerprint: string;
  threadId?: string;
  commentId?: string;
  path?: string;
  line?: number;
  summary: string;
  body?: string;
  category?: string;
  severity?: string;
  reviewedSha?: string;
  dismissed: boolean;
  settledResolved: boolean;
  githubAlreadyResolved?: boolean;
}

export function collectPriorFindings(input: {
  threads: ForgeDiscussion[];
  stored: ReturnType<JobStore["listFindings"]>;
}): PriorFinding[] {
  const byFingerprint = new Map<string, PriorFinding>();

  for (const row of input.stored) {
    byFingerprint.set(row.fingerprint, {
      fingerprint: row.fingerprint,
      threadId: row.github_thread_id ?? undefined,
      commentId: row.github_comment_id ?? undefined,
      path: row.current_path ?? row.original_path ?? undefined,
      line: row.current_line ?? row.original_line ?? undefined,
      summary: row.summary,
      body: row.body ?? undefined,
      category: row.category ?? undefined,
      severity: row.severity ?? undefined,
      reviewedSha: row.reviewed_sha,
      dismissed: row.status === "dismissed",
      settledResolved: row.status === "resolved",
      githubAlreadyResolved: false,
    });
  }

  for (const thread of input.threads) {
    if (!isMaomaoDiscussion(thread)) continue;
    const comment = findingComment(thread);
    const marker = parseDiscussionFindingMarker(thread);
    if (!marker) continue;
    const existing = byFingerprint.get(marker.id);
    const dismissed = existing?.dismissed === true;
    const summary = existing?.summary || summarizeComment(comment?.body ?? "");
    // An open Maomao thread always re-checks, even if SQLite already says resolved
    // (GitHub resolve may have failed last time). A GitHub-resolved thread is
    // caught here so the DB/UI match GitHub without another verifier pass.
    byFingerprint.set(marker.id, {
      fingerprint: marker.id,
      threadId: thread.id,
      commentId: comment?.databaseId != null ? String(comment.databaseId) : existing?.commentId,
      path: comment?.path ?? thread.path ?? existing?.path,
      line: comment?.line ?? thread.line ?? existing?.line ?? undefined,
      summary,
      body: existing?.body ?? comment?.body,
      category: existing?.category,
      severity: existing?.severity,
      reviewedSha: marker.sha || existing?.reviewedSha,
      dismissed,
      settledResolved: dismissed ? false : thread.isResolved,
      githubAlreadyResolved: dismissed ? false : thread.isResolved,
    });
  }

  return [...byFingerprint.values()];
}

export function acceptClassification(
  status: FindingClassification,
  confidence: number,
  minConfidence: number,
  file?: string,
  line?: number,
  reason = "",
): { status: FindingClassification; reason: string } {
  if (status === "dismissed") return { status, reason: reason || "human override" };
  if (status === "uncertain") return { status, reason: reason || "insufficient evidence" };
  if (confidence < minConfidence) {
    return {
      status: "uncertain",
      reason: `low confidence (${confidence}); leaving open`,
    };
  }
  if (status === "moved" && (!file || !line)) {
    return { status: "uncertain", reason: "moved without a new location; leaving open" };
  }
  return { status, reason: reason || status };
}

export async function classifyPriorFindings(input: {
  /** Called when the verifier run fails, so the pipeline can log the cause. */
  onVerifierError?: (message: string) => void;
  config: Config;
  opencode: OpenCodePort;
  job: JobRow;
  repoDir: string;
  diff: string;
  workspaceDir: string;
  priors: PriorFinding[];
  signal: AbortSignal;
  /** Returns a block message when the profile budget forbids a verifier run. */
  budgetBlock?: () => string | undefined;
  /** Receives the verifier run's usage so the pipeline can count it against the profile budget. */
  onVerifierUsage?: (usage: OpenCodeUsage) => void;
}): Promise<ClassifiedFinding[]> {
  const classified: ClassifiedFinding[] = [];
  const toVerify: PriorFinding[] = [];
  for (const prior of input.priors) {
    if (prior.dismissed) {
      classified.push({
        fingerprint: prior.fingerprint,
        status: "dismissed",
        confidence: 1,
        reason: "authorized human override",
        threadId: prior.threadId,
        commentId: prior.commentId,
        originalPath: prior.path,
        originalLine: prior.line,
        category: prior.category,
        summary: prior.summary,
        body: prior.body,
        severity: prior.severity,
      });
      continue;
    }
    if (prior.settledResolved) {
      classified.push({
        fingerprint: prior.fingerprint,
        status: "resolved",
        confidence: 1,
        reason: prior.githubAlreadyResolved
          ? "GitHub thread already resolved"
          : "already resolved; no open thread to re-check",
        threadId: prior.threadId,
        commentId: prior.commentId,
        githubAlreadyResolved: true,
        originalPath: prior.path,
        originalLine: prior.line,
        category: prior.category,
        summary: prior.summary,
        body: prior.body,
        severity: prior.severity,
      });
      continue;
    }
    toVerify.push(prior);
  }

  if (toVerify.length === 0) return classified;

  const verifierResults = await runVerifier(input, toVerify);
  const byId = new Map(verifierResults.map((item) => [item.fingerprint, item]));
  for (const prior of toVerify) {
    const raw = byId.get(prior.fingerprint);
    const accepted = acceptClassification(
      raw?.status ?? "uncertain",
      raw?.confidence ?? 0,
      input.config.reconcileMinConfidence,
      raw?.file ?? prior.path,
      raw?.line ?? prior.line,
      raw?.reason ?? "verifier did not classify this finding",
    );
    classified.push({
      fingerprint: prior.fingerprint,
      status: accepted.status,
      confidence: raw?.confidence ?? 0,
      reason: accepted.reason,
      threadId: prior.threadId,
      commentId: prior.commentId,
      originalPath: prior.path,
      originalLine: prior.line,
      currentPath: accepted.status === "moved" ? raw?.file : prior.path,
      currentLine: accepted.status === "moved" ? raw?.line : prior.line,
      category: prior.category,
      summary: prior.summary,
      body: prior.body,
      severity: prior.severity,
    });
  }
  return classified;
}

export function findingsForPublish(
  aggregated: AggregatorFinding[],
  snapshot: ReconciliationSnapshot,
): Array<AggregatorFinding & { fingerprint: string }> {
  const dismissed = new Set(
    snapshot.items.filter((item) => item.status === "dismissed").map((item) => item.fingerprint),
  );
  const keepExisting = new Set(
    snapshot.items
      .filter((item) => item.status === "still_valid" || item.status === "uncertain")
      .map((item) => item.fingerprint),
  );
  const out: Array<AggregatorFinding & { fingerprint: string }> = [];
  const seen = new Set<string>();

  for (const finding of aggregated) {
    const fingerprint = fingerprintFinding(finding);
    if (dismissed.has(fingerprint) || keepExisting.has(fingerprint)) continue;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({ ...finding, fingerprint });
  }

  for (const item of snapshot.items) {
    if (item.status !== "moved") continue;
    if (dismissed.has(item.fingerprint) || seen.has(item.fingerprint)) continue;
    if (!item.currentPath || !item.currentLine) continue;
    seen.add(item.fingerprint);
    out.push({
      severity: (item.severity as AggregatorFinding["severity"]) || "medium",
      confidence: item.confidence,
      category: item.category ?? "general",
      file: item.currentPath,
      line: item.currentLine,
      summary: item.summary,
      body: item.body,
      reviewers_agreed: [],
      fingerprint: item.fingerprint,
    });
  }
  return out;
}

export { currentFindingsForRisk };

async function runVerifier(
  input: {
    config: Config;
    opencode: OpenCodePort;
    job: JobRow;
    repoDir: string;
    diff: string;
    workspaceDir: string;
    signal: AbortSignal;
    onVerifierError?: (message: string) => void;
    budgetBlock?: () => string | undefined;
    onVerifierUsage?: (usage: OpenCodeUsage) => void;
  },
  priors: PriorFinding[],
): Promise<Array<{ fingerprint: string; status: FindingClassification; confidence: number; reason: string; file?: string; line?: number }>> {
  const budgetMessage = input.budgetBlock?.();
  if (budgetMessage) {
    input.onVerifierError?.(budgetMessage);
    return priors.map((prior) => ({
      fingerprint: prior.fingerprint,
      status: "uncertain" as const,
      confidence: 0,
      reason: `verifier skipped: ${budgetMessage}`,
    }));
  }
  if (!input.config.opencode.verifierModel) {
    return priors.map((prior) => ({
      fingerprint: prior.fingerprint,
      status: "uncertain" as const,
      confidence: 0,
      reason: "verifier model is not configured; leaving open",
    }));
  }

  const contexts: string[] = [];
  const payload = [];
  for (const prior of priors) {
    const context = await collectFindingContext({
      repoDir: input.repoDir,
      diff: input.diff,
      path: prior.path,
      line: prior.line,
      summary: prior.summary,
    });
    contexts.push(`fingerprint=${prior.fingerprint}\n${context}`);
    payload.push({
      fingerprint: prior.fingerprint,
      category: prior.category,
      severity: prior.severity,
      path: prior.path,
      line: prior.line,
      summary: prior.summary,
    });
  }

  const contextPath = join(input.workspaceDir, "reconcile-context.md");
  await writeFile(contextPath, boundContexts(contexts), "utf8");

  try {
    const result = await input.opencode.run({
      cwd: input.repoDir,
      model: input.config.opencode.verifierModel,
      prompt: buildVerifierPrompt({
        repoFullName: input.job.repo_full_name,
        prNumber: input.job.pr_number,
        prTitle: input.job.pr_title,
        headSha: input.job.head_sha,
        findings: payload,
      }),
      files: [contextPath],
      timeoutMs: input.config.opencode.verifierTimeoutMs,
      extraArgs: input.config.opencode.extraArgs,
      bin: input.config.opencode.bin,
      title: `maomao-verifier-${input.job.id}`,
      signal: input.signal,
    });
    input.onVerifierUsage?.(result.usage);
    const parsed = parseVerifierResult(result.text || result.stdout);
    return parsed.classifications.map((item) => ({
      fingerprint: item.fingerprint,
      status: item.status,
      confidence: item.confidence,
      reason: item.reason,
      file: item.file,
      line: item.line,
    }));
  } catch (error) {
    input.onVerifierError?.(error instanceof Error ? error.message : String(error));
    return priors.map((prior) => ({
      fingerprint: prior.fingerprint,
      status: "uncertain" as const,
      confidence: 0,
      reason: "verifier failed; leaving open",
    }));
  }
}

export function summarizeComment(body: string): string {
  const withoutMarker = stripHtmlComments(body).replace(/\*\*[^*]+\*\*:\s*/g, "").trim();
  const first = withoutMarker.split("\n").find((line) => line.trim()) ?? "prior finding";
  return first.slice(0, 240);
}
