/**
 * The code-explainer service. One conversation per job (+ operator resets):
 * the first message re-finds or prepares a read-only checkout of the exact
 * reviewed head, seeds the review context, and every exchange is one
 * read-only `opencode run` continued in the same session. Maomao is the only
 * surface — the browser never reaches opencode.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Config } from "../config.js";
import { githubSecrets } from "../config.js";
import type { GithubPort } from "../github/client.js";
import type { CheckoutPort } from "../checkout.js";
import { createCheckout } from "../checkout.js";
import type { OpenCodePort } from "../opencode/parse.js";
import { OpenCodeTimeoutError, opencodeEnvSecrets } from "../opencode/spawn.js";
import { reviewerPermissionConfig } from "../opencode/env.js";
import { formatDuration, redactSecrets } from "../util.js";
import type { ChatConversationRow, ChatMessageRow, ChatStore } from "./store.js";
import { ExplainerEventParser } from "./events.js";

export class ChatBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatBudgetError";
  }
}

export interface ChatFindingContext {
  fingerprint: string;
  severity: string | null;
  category: string | null;
  path: string | null;
  line: number | null;
  summary: string;
}

export interface ChatSendResult {
  reply: ChatMessageRow;
  sessionId: string;
}

export interface ChatServiceDeps {
  config: Config;
  chatStore: ChatStore;
  jobStore: {
    getJob(id: number): {
      id: number;
      repo_full_name: string;
      repo_owner: string;
      repo_name: string;
      installation_id: number;
      pr_number: number;
      pr_title: string;
      pr_author: string;
      base_sha: string;
      head_sha: string;
      job_type: string;
    } | undefined;
    listFindings(repoFullName: string, prNumber: number): Array<{
      fingerprint: string;
      severity: string | null;
      category: string | null;
      current_path: string | null;
      current_line: number | null;
      summary: string;
    }>;
  };
  github: Pick<GithubPort, "getInstallationToken">;
  /** Separate checkout root (`<workspaceRoot>/chat`) so chat can never clobber a pipeline workspace. */
  checkout?: CheckoutPort;
  opencode: OpenCodePort;
}

const REPO_DIR = "repo";

export class ChatService {
  private readonly checkout: CheckoutPort;
  /**
   * Serializes sends per JOB (not per conversation): conversations on one job
   * share the checkout directory, and a reset while a send streams would clobber it.
   */
  private readonly locks = new Map<number, Promise<unknown>>();

  constructor(private readonly deps: ChatServiceDeps) {
    this.checkout = deps.checkout ?? createCheckout(join(deps.config.workspaceRoot, "chat"));
  }

  async send(input: {
    job: NonNullable<ReturnType<ChatServiceDeps["jobStore"]["getJob"]>>;
    conversation: ChatConversationRow;
    question: string;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  }): Promise<ChatSendResult> {
    const previous = this.locks.get(input.job.id) ?? Promise.resolve();
    const chained = previous.catch(() => undefined).then(() => this.sendLocked(input));
    this.locks.set(input.job.id, chained);
    try {
      return await chained;
    } finally {
      if (this.locks.get(input.job.id) === chained) this.locks.delete(input.job.id);
    }
  }

  private async sendLocked(input: {
    job: NonNullable<ReturnType<ChatServiceDeps["jobStore"]["getJob"]>>;
    conversation: ChatConversationRow;
    question: string;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  }): Promise<ChatSendResult> {
    const { config, chatStore } = this.deps;
    // Re-read under the lock: a queued send must not run on a stale row
    // snapshot missing the session binding a previous send just wrote.
    const conversation = chatStore.getConversation(input.conversation.id) ?? input.conversation;
    const budget = chatStore.usage(conversation.id);
    if (budget.messages >= config.chat.maxMessages) {
      throw new ChatBudgetError(
        `This conversation reached its message limit (${config.chat.maxMessages}); reset it to start a new one.`,
      );
    }
    if (config.chat.maxCostUsd > 0 && budget.cost >= config.chat.maxCostUsd) {
      throw new ChatBudgetError(
        `This conversation reached its cost ceiling ($${config.chat.maxCostUsd.toFixed(2)}); reset it to start a new one.`,
      );
    }

    const workspace = await this.ensureWorkspace(conversation, input.job);
    const repoDir = join(workspace, REPO_DIR);

    chatStore.appendMessage({ conversationId: conversation.id, role: "user", content: input.question });

    const firstMessage = budget.messages === 0;
    const prompt = firstMessage ? this.seedPrompt(input.job, input.question) : input.question;
    const started = Date.now();
    const parser = new ExplainerEventParser();
    let lastDeltaIndex = 0;

    const redactAll = (text: string) =>
      redactSecrets(text, [...githubSecrets(config), ...opencodeEnvSecrets(process.env)]);

    try {
      const result = await this.deps.opencode.run({
        cwd: repoDir,
        model: this.model() ?? "",
        prompt,
        files: [],
        timeoutMs: config.chat.timeoutMs,
        extraArgs: conversation.opencode_session_id
          ? ["--session", conversation.opencode_session_id]
          : [],
        signal: input.signal,
        onStdout: (chunk) => {
          const { sessionId, textParts } = parser.feed(chunk);
          if (sessionId && !conversation.opencode_session_id) {
            chatStore.bindSession(conversation.id, sessionId, workspace);
            conversation.opencode_session_id = sessionId;
          }
          for (; lastDeltaIndex < textParts.length; lastDeltaIndex += 1) {
            input.onDelta?.(textParts[lastDeltaIndex]!);
          }
        },
      });

      // A failed run must never become an empty "assistant reply": the runner
      // resolves on any exit, so failures are only visible here.
      const stderr = result.stderr.trim();
      if (result.exitCode !== 0 || (parser.textParts.length === 0 && !result.usage.totalTokens)) {
        throw new Error(
          `explainer run failed (exit ${result.exitCode}): ${redactAll(stderr.slice(0, 300) || "no output; model auth or configuration is the usual cause")}`,
        );
      }
      // A disconnect or timeout mid-stream leaves a partial answer; persisting
      // it as a complete reply would misrepresent what happened.
      if (input.signal?.aborted) {
        throw new Error("explainer was interrupted before the answer completed");
      }

      const sessionId = parser.sessionId ?? conversation.opencode_session_id;
      if (sessionId) {
        chatStore.bindSession(conversation.id, sessionId, workspace);
      }
      const replyText = redactAll(parser.textParts.join("\n\n") || result.text);
      const usage = result.usage;
      const reply = chatStore.appendMessage({
        conversationId: conversation.id,
        role: "assistant",
        content: replyText,
        cost: usage.cost,
        totalTokens: usage.totalTokens,
        durationMs: Date.now() - started,
      });
      chatStore.clearError(conversation.id);
      return { reply, sessionId: sessionId ?? "" };
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Error && error.message === "aborted")) {
        // Operator disconnect: not a conversation failure. The question stays
        // in the transcript; the next send resumes the same session.
        throw abortError();
      }
      const message =
        error instanceof OpenCodeTimeoutError
          ? `the explainer timed out after ${formatDuration(config.chat.timeoutMs)}`
          : error instanceof Error
            ? redactAll(error.message)
            : String(error);
      chatStore.setError(conversation.id, message);
      throw error instanceof Error && error.name === "AbortError" ? abortError() : error;
    }
  }

  private model(): string | undefined {
    return this.deps.config.chat.model || this.deps.config.opencode.reviewerModel || undefined;
  }

  /**
   * Re-finds the job's workspace when the pipeline left one standing;
   * otherwise prepares a fresh read-only checkout under `<workspaceRoot>/chat`
   * (never the pipeline's own directory — `checkout.prepare` clears its target).
   */
  private async ensureWorkspace(
    conversation: ChatConversationRow,
    job: NonNullable<ReturnType<ChatServiceDeps["jobStore"]["getJob"]>>,
  ): Promise<string> {
    if (conversation.workspace_path && existsSync(join(conversation.workspace_path, REPO_DIR))) {
      return conversation.workspace_path;
    }
    const token =
      job.installation_id > 0 ? await this.deps.github.getInstallationToken(job.installation_id) : undefined;
    const workspace = await this.checkout.prepare({
      jobId: job.id,
      installationId: job.installation_id,
      owner: job.repo_owner,
      repo: job.repo_name,
      prNumber: job.pr_number,
      baseSha: job.base_sha,
      headSha: job.head_sha,
      token,
      secrets: token ? [token, ...githubSecrets(this.deps.config)] : githubSecrets(this.deps.config),
      fetchDiff: async () => "",
      metadata: {
        repo: job.repo_full_name,
        pr: job.pr_number,
        title: job.pr_title,
        purpose: "chat",
        headSha: job.head_sha,
      },
    });
    this.deps.chatStore.setWorkspace(conversation.id, workspace.dir);
    conversation.workspace_path = workspace.dir;
    return workspace.dir;
  }

  /** First-message seed: the review context that makes answers reviewer-shaped. */
  private seedPrompt(
    job: NonNullable<ReturnType<ChatServiceDeps["jobStore"]["getJob"]>>,
    question: string,
  ): string {
    const findings = this.deps.jobStore.listFindings(job.repo_full_name, job.pr_number);
    const findingLines = findings
      .map(
        (finding) =>
          `- [${finding.severity ?? "?"}] ${finding.summary} (${finding.current_path ?? "?"}:${
            finding.current_line ?? "?"
          }, fingerprint ${finding.fingerprint})`,
      )
      .join("\n");
    const lines = [
      "You are Maomao's code explainer. You explain a reviewed change to the operator who ran the review.",
      "Read-only: you can read, glob, and grep the repository, but you must never modify anything.",
      "",
      `Repository: ${job.repo_full_name} (${job.job_type === "health_scan" ? "health scan" : "pull request"} by ${job.pr_author || "unknown"})`,
      `Change under review: ${job.pr_title || "(no title)"}`,
      `Reviewed head commit: ${job.head_sha}`,
      "",
      "Maomao's review reported these findings on this exact commit:",
      findingLines || "(no findings — the review came back clean)",
      "",
      "Explain trade-offs and reasoning like a reviewer would; cite files as path:line.",
      "",
      `The operator asks: ${question}`,
    ];
    return lines.join("\n");
  }
}

function abortError(): Error {
  const error = new Error("explainer interrupted");
  error.name = "AbortError";
  return error;
}

/** The explainer runs under the same deny-by-default permissions as reviewers. */
export function explainerPermissionConfig(): Record<string, unknown> {
  return reviewerPermissionConfig();
}
