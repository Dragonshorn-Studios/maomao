import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore, type JobRow } from "../jobs/store.js";
import { loadConfig } from "../config.js";
import type { OpenCodePort } from "../opencode/parse.js";
import type { GithubPort } from "../github/client.js";
import type { CheckoutPort } from "../checkout.js";
import { join } from "node:path";
import { ChatBudgetError, ChatService } from "./service.js";
import { ChatStore } from "./store.js";

const HEAD = "head333";

function baseJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    repo_full_name: "acme/widgets",
    repo_owner: "acme",
    repo_name: "widgets",
    installation_id: 9,
    pr_number: 4,
    pr_title: "Change example",
    pr_body: "",
    pr_html_url: "",
    pr_author: "dev",
    base_sha: "base111",
    head_sha: HEAD,
    base_ref: "main",
    head_ref: "feat",
    job_type: "pr_review",
    ...overrides,
  } as unknown as JobRow;
}

interface Harness {
  service: ChatService;
  chatStore: ChatStore;
  jobStore: JobStore;
  runs: Array<{ cwd: string; prompt: string; extraArgs?: string[]; model?: string }>;
  prepareCount: { count: number };
}

function harness(options: {
  config?: Record<string, string>;
  reply?: string;
  findings?: Array<Record<string, unknown>>;
} = {}): Harness {
  const config = loadConfig({
    GITHUB_WEBHOOK_SECRET: "s3cret",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    REVIEWER_ROLES: "correctness",
    OPENCODE_REVIEWER_MODEL: "test/model",
    ...options.config,
  });
  const jobStore = new JobStore(openDb(":memory:"));
  const chatStore = new ChatStore(openDb(":memory:"));
  const runs: Harness["runs"] = [];
  const prepareCount = { count: 0 };
  const opencode: OpenCodePort = {
    async run(input) {
      runs.push({ cwd: input.cwd, prompt: input.prompt, extraArgs: input.extraArgs, model: input.model });
      const text = options.reply ?? "Here is what this change does.";
      // Emulate the real runner: events stream over stdout.
      for (const event of [
        `{"type":"step_start","sessionID":"ses_fixed","part":{}}`,
        `{"type":"text","part":{"id":"p1","text":${JSON.stringify(text)}}}`,
        `{"type":"step_finish","part":{"reason":"stop","tokens":{"total":120},"cost":0.02}}`,
      ]) {
        input.onStdout?.(event + "\n");
      }
      return {
        stdout: "streamed",
        stderr: "",
        exitCode: 0,
        text,
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cost: 0.02, complete: true },
      };
    },
  };
  const checkout: CheckoutPort = {
    async prepare(input) {
      prepareCount.count += 1;
      const dir = `/tmp/chat-fixture/job-${input.jobId}-${input.headSha.slice(0, 8)}`;
      mkdirSync(join(dir, "repo"), { recursive: true });
      return { dir, repoDir: join(dir, "repo"), diffPath: join(dir, "pr.diff"), metaPath: join(dir, "pr.json") };
    },
    async cleanup() {},
  };
  jobStore.enqueue({
    repoFullName: "acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    installationId: 9,
    prNumber: 4,
    prTitle: "Change example",
    prBody: "",
    prHtmlUrl: "",
    prAuthor: "dev",
    baseSha: "base111",
    headSha: HEAD,
    baseRef: "main",
    headRef: "feat",
    reviewers: [],
  });
  for (const finding of options.findings ?? []) {
    jobStore.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 4,
      fingerprint: String(finding.fingerprint),
      status: "open",
      reviewedSha: HEAD,
      severity: (finding.severity as string) ?? "medium",
      category: (finding.category as string) ?? "correctness",
      currentPath: (finding.path as string) ?? "src/app.ts",
      currentLine: (finding.line as number) ?? 2,
      summary: (finding.summary as string) ?? "a finding",
    });
  }
  const service = new ChatService({
    config,
    chatStore,
    jobStore,
    github: { getInstallationToken: async () => "tok" } as Pick<GithubPort, "getInstallationToken">,
    checkout,
    opencode,
  });
  return { service, chatStore, jobStore, runs, prepareCount };
}

describe("ChatService", () => {
  it("sends a question, persists both messages, and records usage", async () => {
    const { service, chatStore, jobStore } = harness();
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, "octocat");
    const result = await service.send({ job, conversation, question: "What does this change do?" });
    expect(result.reply.content).toContain("Here is what this change does.");
    expect(result.sessionId).toBe("ses_fixed");
    const messages = chatStore.listMessages(conversation.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.cost).toBeCloseTo(0.02);
    expect(messages[1]?.total_tokens).toBe(120);
    const usage = chatStore.usage(conversation.id);
    expect(usage.messages).toBe(2);
    expect(usage.cost).toBeCloseTo(0.02);
  });

  it("continues the same opencode session on follow-up messages", async () => {
    const { service, chatStore, jobStore, runs } = harness();
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    await service.send({ job, conversation, question: "first" });
    await service.send({ job, conversation, question: "second" });
    expect(runs[0]?.extraArgs).toEqual([]);
    expect(runs[1]?.extraArgs).toEqual(["--session", "ses_fixed"]);
  });

  it("seeds the first message with review context and findings, but not follow-ups", async () => {
    const { service, chatStore, jobStore, runs } = harness({
      findings: [{ fingerprint: "fp123", severity: "high", summary: "unsafe cast", path: "src/app.ts", line: 9 }],
    });
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    await service.send({ job, conversation, question: "why is this high?" });
    await service.send({ job, conversation, question: "and the rest?" });
    expect(runs[0]?.prompt).toContain(`Reviewed head commit: ${HEAD}`);
    expect(runs[0]?.prompt).toContain("unsafe cast");
    expect(runs[0]?.prompt).toContain("Read-only");
    expect(runs[0]?.prompt.endsWith("why is this high?")).toBe(true);
    expect(runs[1]?.prompt).toBe("and the rest?");
  });

  it("enforces the message ceiling with a budget error", async () => {
    const { service, chatStore, jobStore } = harness({ config: { MAOMAO_EXPLAIN_MAX_MESSAGES: "1" } });
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    await service.send({ job, conversation, question: "first" });
    await expect(service.send({ job, conversation, question: "second" })).rejects.toBeInstanceOf(ChatBudgetError);
  });

  it("enforces the cost ceiling", async () => {
    const { service, chatStore, jobStore } = harness({ config: { MAOMAO_EXPLAIN_MAX_COST_USD: "0.01" } });
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    // The first reply costs 0.02 ≥ the 0.01 ceiling; the next send refuses.
    await service.send({ job, conversation, question: "first" });
    await expect(service.send({ job, conversation, question: "second" })).rejects.toBeInstanceOf(ChatBudgetError);
  });

  it("serializes concurrent sends so user/assistant pairs stay ordered", async () => {
    const { service, chatStore, jobStore, runs } = harness();
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    const first = service.send({ job, conversation, question: "first" });
    const second = service.send({ job, conversation, question: "second" });
    await Promise.all([first, second]);
    const messages = chatStore.listMessages(conversation.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(runs[0]?.prompt.endsWith("first")).toBe(true);
    expect(runs[1]?.prompt.endsWith("second")).toBe(true);
  });

  it("runs in the prepared checkout's repo directory and reuses it across messages", async () => {
    const { service, chatStore, jobStore, runs, prepareCount } = harness();
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    await service.send({ job, conversation, question: "one" });
    await service.send({ job, conversation, question: "two" });
    expect(runs[0]?.cwd.endsWith("/repo")).toBe(true);
    expect(prepareCount.count).toBe(1);
  });
});
