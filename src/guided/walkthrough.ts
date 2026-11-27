import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Config } from "../config.js";
import type { CheckoutPort } from "../checkout.js";
import { createCheckout } from "../checkout.js";
import type { ForgeRegistry } from "../forge/registry.js";
import type { ForgeRepoTarget } from "../forge/types.js";
import type { OpenCodePort } from "../opencode/parse.js";
import { opencodeEnvSecrets } from "../opencode/spawn.js";
import { providerAuthSecrets } from "../opencode/credentials.js";
import { githubSecrets } from "../config.js";
import { redactSecrets, truncate } from "../util.js";
import { parseBriefPayload } from "../jobs/brief.js";
import type { GuidedReviewSessionRow } from "./store.js";
import {
  GUIDED_WALKTHROUGH_OUTPUT_CHARS,
  GuidedWalkthroughStore,
  type GuidedWalkthroughPayload,
  type GuidedWalkthroughRow,
} from "./walkthrough-store.js";

export interface GuidedReviewRunOptions {
  model?: string;
  timeoutMs?: number;
  maxCostUsd?: number;
}

export interface GuidedWalkthroughServiceDeps {
  config: Config;
  store: GuidedWalkthroughStore;
  forge: ForgeRegistry;
  opencode: OpenCodePort;
  checkout?: CheckoutPort;
  /** Exact-SHA repo-brief cache; reused as optional repository context when already generated. */
  briefCache?: {
    getRepoBriefCache(provider: string, providerInstance: string, repoFullName: string, sha: string): { payload: string; created_at: string } | undefined;
  };
  /** Active-profile Guided Review overrides for the repository, resolved at enqueue/run time. */
  resolveOptions?: (repoFullName: string) => GuidedReviewRunOptions | undefined;
}

function walkthroughWorkspaceRoot(workspaceRoot: string): string {
  return join(workspaceRoot, "guided");
}

function asArray<T>(value: unknown, map: (entry: unknown) => T | undefined): T[] {
  return Array.isArray(value) ? value.map(map).filter((entry): entry is T => entry !== undefined).slice(0, 40) : [];
}

function text(value: unknown, fallback = "Unavailable from the inspected evidence."): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 4000) : fallback;
}

function parsePayload(raw: string): GuidedWalkthroughPayload | undefined {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const intent = typeof parsed.intent === "object" && parsed.intent ? (parsed.intent as Record<string, unknown>) : {};
  return {
    schema_version: 1,
    kind: "guided_walkthrough",
    intent: { text: text(intent.text), uncertainty: text(intent.uncertainty, "No explicit uncertainty was reported.") },
    changeMap: asArray(parsed.changeMap, (entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== "string" || !record.path.trim()) return undefined;
      return { path: record.path.trim().slice(0, 500), summary: text(record.summary), evidence: text(record.evidence) };
    }),
    flow: text(parsed.flow),
    decisions: asArray(parsed.decisions, (entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const record = entry as Record<string, unknown>;
      return { title: text(record.title, "Unnamed decision"), details: text(record.details), evidence: text(record.evidence) };
    }),
    tests: text(parsed.tests),
    risks: asArray(parsed.risks, (entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const record = entry as Record<string, unknown>;
      const line = typeof record.line === "number" && Number.isInteger(record.line) && record.line > 0 ? record.line : undefined;
      return {
        question: text(record.question, "What evidence should a reviewer check here?"),
        ...(typeof record.path === "string" && record.path.trim() ? { path: record.path.trim().slice(0, 500) } : {}),
        ...(line ? { line } : {}),
        evidence: text(record.evidence),
      };
    }),
    generatedAt: new Date().toISOString(),
  };
}

function buildPrompt(input: { target: ForgeRepoTarget; model: string }): string {
  return `You are preparing a read-only Guided Review walkthrough for ${input.target.repoFullName}#${input.target.changeNumber}.
The exact reviewed base SHA is ${input.target.baseSha}; the exact head SHA is ${input.target.headSha}. The checkout is pinned to that head. The attached pr.diff is the exact base/head comparison and pr.json is the pull metadata. When repo-brief.json is attached, it is an exact-SHA cached repository brief with bounded file fragments; use it as context, but treat the diff as authoritative for changes.

Do not review for defects, do not invent product requirements, and do not state certainty the evidence does not support. This is a spoiler-free exploration primer for a human who has not read Maomao's review: never mention verdicts, severities, findings, or whether the pull request is correct. Separate what the PR/docs explicitly say from inference. If evidence is unavailable, say so.

Keep the primer concise: intent.text at most 420 characters, flow at most 700 characters, each changeMap summary at most 220 characters, and each evidence string at most 180 characters. Include exactly one changeMap entry for every file in pr.diff; if evidence is insufficient for a file, say that in its summary/evidence rather than omitting it.

Return ONLY one JSON object with this shape:
{
  "intent": {"text": "intent as expressed in the PR title/body/docs", "uncertainty": "explicit uncertainty or missing evidence"},
  "changeMap": [{"path": "repo/path", "summary": "what changed", "evidence": "file/hunk evidence"}],
  "flow": "execution/data flow after the change",
  "decisions": [{"title": "consequential decision or invariant", "details": "why it matters", "evidence": "file/hunk evidence"}],
  "tests": "tests present or missing, with evidence",
  "risks": [{"question": "reviewer question", "path": "optional repo/path", "line": 123, "evidence": "file/hunk evidence"}]
}
Keep output under 6000 words. Use concrete paths and hunk/line evidence wherever possible.`;
}

/** One bounded background explanation task per exact-SHA walkthrough fingerprint. */
export class GuidedWalkthroughService {
  private readonly checkout: CheckoutPort;
  private readonly runs = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: GuidedWalkthroughServiceDeps) {
    this.checkout = deps.checkout ?? createCheckout(walkthroughWorkspaceRoot(deps.config.workspaceRoot));
    this.deps.store.recoverInterrupted();
  }

  private options(repoFullName: string): GuidedReviewRunOptions {
    const profile = this.deps.resolveOptions?.(repoFullName) ?? {};
    return {
      model: profile.model || this.deps.config.chat.model || undefined,
      timeoutMs: profile.timeoutMs || this.deps.config.chat.timeoutMs || undefined,
      maxCostUsd: profile.maxCostUsd || this.deps.config.chat.maxCostUsd || undefined,
    };
  }

  model(repoFullName?: string): string {
    return (repoFullName ? this.options(repoFullName).model : this.deps.config.chat.model) || "opencode-default";
  }

  ensure(session: GuidedReviewSessionRow, installationId: number): GuidedWalkthroughRow {
    const row = this.deps.store.open(
      {
        provider: session.provider,
        instance: session.provider_instance,
        repoFullName: session.repo_full_name,
        prNumber: session.pr_number,
        baseSha: session.base_sha,
        headSha: session.head_sha,
      },
      this.model(session.repo_full_name),
    );
    for (const stale of this.deps.store.listStaleCancellations(
      {
        provider: session.provider,
        instance: session.provider_instance,
        repoFullName: session.repo_full_name,
        prNumber: session.pr_number,
      },
      row.fingerprint,
    )) {
      this.controllers.get(stale.fingerprint)?.abort();
    }
    if (row.status === "pending") this.start(row, installationId);
    return this.deps.store.get(row.id) ?? row;
  }

  retry(row: GuidedWalkthroughRow, installationId: number): GuidedWalkthroughRow | undefined {
    if (!this.deps.store.requestRetry(row.id)) return this.deps.store.get(row.id);
    const fresh = this.deps.store.get(row.id);
    if (fresh) this.start(fresh, installationId);
    return fresh;
  }

  cancel(row: GuidedWalkthroughRow): boolean {
    const accepted = this.deps.store.requestCancel(row.id);
    if (accepted) this.controllers.get(row.fingerprint)?.abort();
    return accepted;
  }

  private start(row: GuidedWalkthroughRow, installationId: number): void {
    if (this.runs.has(row.fingerprint)) return;
    const controller = new AbortController();
    this.controllers.set(row.fingerprint, controller);
    const run = this.generate(row, installationId, controller.signal)
      .catch((error) => {
        const secrets = [...githubSecrets(this.deps.config), ...opencodeEnvSecrets(process.env), ...providerAuthSecrets(process.env)];
        const cancelled = controller.signal.aborted || this.deps.store.cancelRequested(row.id);
        this.deps.store.markFailed(row.id, redactSecrets(error instanceof Error ? error.message : String(error), secrets), cancelled);
      })
      .finally(() => {
        this.controllers.delete(row.fingerprint);
        this.runs.delete(row.fingerprint);
      });
    this.runs.set(row.fingerprint, run);
  }

  private target(row: GuidedWalkthroughRow): ForgeRepoTarget {
    const [repoOwner, repoName] = row.repo_full_name.split("/");
    return {
      provider: row.provider,
      instance: row.provider_instance,
      repoOwner,
      repoName,
      repoFullName: row.repo_full_name,
      changeNumber: row.pr_number,
      baseSha: row.base_sha,
      headSha: row.head_sha,
    };
  }

  private async generate(row: GuidedWalkthroughRow, installationId: number, signal: AbortSignal): Promise<void> {
    if (!this.deps.store.claim(row.id)) return;
    const target = this.target(row);
    const forge = this.deps.forge.forJob({
      provider: row.provider,
      provider_instance: row.provider_instance,
      installation_id: installationId,
    });
    let metadataAvailable = true;
    const change = await forge.getChange(target).catch(() => {
      metadataAvailable = false;
      return undefined;
    });
    const spec = await forge.cloneSpec(target);
    const workspace = await this.checkout.prepare({
      jobId: row.id,
      cloneUrl: spec.cloneUrl,
      gitAuthArgs: spec.gitAuthArgs,
      remoteRef: spec.remoteRef,
      secrets: spec.secrets,
      baseSha: row.base_sha,
      headSha: row.head_sha,
      signal,
      fetchDiff: () => forge.getChangeDiff(target, this.deps.config.maxDiffBytes),
      metadata: {
        provider: row.provider,
        instance: row.provider_instance,
        repoFullName: row.repo_full_name,
        prNumber: row.pr_number,
        baseSha: row.base_sha,
        headSha: row.head_sha,
        title: change?.title ?? "",
        body: change?.body ?? "",
        htmlUrl: change?.htmlUrl ?? "",
        author: change?.author ?? "",
        pullMetadataAvailable: metadataAvailable,
      },
    });
    const files = [workspace.diffPath, workspace.metaPath];
    const cachedBrief = this.deps.briefCache?.getRepoBriefCache(row.provider, row.provider_instance, row.repo_full_name, row.head_sha);
    const briefPayload = cachedBrief ? parseBriefPayload(cachedBrief.payload) : undefined;
    if (briefPayload?.sha === row.head_sha) {
      try {
        await mkdir(workspace.dir, { recursive: true });
        const briefPath = join(workspace.dir, "repo-brief.json");
        await writeFile(briefPath, cachedBrief!.payload, "utf8");
        files.push(briefPath);
      } catch (error) {
        console.warn(`guided walkthrough could not attach cached repo brief for ${row.repo_full_name}@${row.head_sha}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const result = await this.deps.opencode.run({
        cwd: workspace.repoDir,
        model: row.model === "opencode-default" ? this.deps.config.chat.model : row.model,
        prompt: buildPrompt({ target, model: row.model }),
        files,
        timeoutMs: this.options(row.repo_full_name).timeoutMs || 180_000,
        signal,
      });
      const text = result.text || result.stdout;
      if (signal.aborted || this.deps.store.cancelRequested(row.id)) throw new Error("generation cancelled");
      if (result.exitCode !== 0 || !text.trim()) {
        throw new Error(`walkthrough run failed (exit ${result.exitCode}): ${truncate(result.stderr.trim() || "no output", 300)}`);
      }
      if (text.length > GUIDED_WALKTHROUGH_OUTPUT_CHARS) throw new Error("walkthrough output exceeded the output bound");
      const maxCostUsd = this.options(row.repo_full_name).maxCostUsd ?? 0;
      if (maxCostUsd > 0 && (result.usage.cost ?? 0) > maxCostUsd) {
        throw new Error(`walkthrough exceeded the configured cost ceiling ($${maxCostUsd.toFixed(2)})`);
      }
      const payload = parsePayload(text);
      if (!payload) throw new Error("walkthrough output was not valid structured JSON");
      if (!this.deps.store.markReady(row.id, payload)) throw new Error("generation cancelled or superseded");
    } finally {
      await this.checkout.cleanup(workspace.dir).catch((error) => {
        console.warn(`guided walkthrough cleanup failed for ${workspace.dir}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
