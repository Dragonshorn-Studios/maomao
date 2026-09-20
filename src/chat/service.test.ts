import { mkdirSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore, type JobRow } from "../jobs/store.js";
import { loadConfig } from "../config.js";
import type { OpenCodePort } from "../opencode/parse.js";
import type { CheckoutPort } from "../checkout.js";
import type { ForgeCloneSpec } from "../forge/types.js";
import type { ForgePort } from "../forge/port.js";
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
  prepares: Array<Parameters<CheckoutPort["prepare"]>[0]>;
}

function fakeForge(spec: ForgeCloneSpec): { forJob: () => Pick<ForgePort, "cloneSpec"> } {
  return {
    forJob: () => ({
      cloneSpec: async () => spec,
    }),
  };
}

function harness(options: {
  config?: Record<string, string>;
  reply?: string;
  findings?: Array<Record<string, unknown>>;
  cloneSpec?: ForgeCloneSpec;
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
  const prepares: Harness["prepares"] = [];
  const cloneSpec: ForgeCloneSpec = options.cloneSpec ?? {
    cloneUrl: "https://github.com/acme/widgets.git",
    gitAuthArgs: ["-c", "http.extraHeader=AUTHORIZATION: basic dG9r"],
    remoteRef: "refs/pull/4/head",
    secrets: ["tok"],
  };
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
      prepares.push(input);
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
    forge: fakeForge(cloneSpec),
    checkout,
    opencode,
  });
  return { service, chatStore, jobStore, runs, prepareCount, prepares };
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

  it("refuses to persist a reply when opencode exits nonzero", async () => {
    const { service, chatStore, jobStore } = harness();
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    const failing: OpenCodePort = {
      async run(input) {
        input.onStdout?.('{"type":"step_start","sessionID":"ses_x","part":{}}\n');
        return { stdout: "err", stderr: "model not found", exitCode: 1, text: "", usage: {} };
      },
    };
    const deps = service as unknown as { deps: { opencode: OpenCodePort } };
    const original = deps.deps.opencode;
    deps.deps.opencode = failing;
    await expect(service.send({ job, conversation, question: "q" })).rejects.toThrow(/explainer run failed/);
    // No fake assistant reply persisted; the question remains; conversation recoverable.
    expect(chatStore.listMessages(conversation.id).map((m) => m.role)).toEqual(["user"]);
    expect(chatStore.getConversation(conversation.id)?.state).toBe("error");
    // The next send resumes the same (errored) conversation once the cause clears.
    deps.deps.opencode = original;
    await service.send({ job, conversation, question: "retry" });
    expect(chatStore.getConversation(conversation.id)?.state).toBe("active");
  });

  it("does not persist a partial answer as complete when aborted mid-send", async () => {
    const { service, chatStore, jobStore } = harness();
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    const controller = new AbortController();
    const aborting: OpenCodePort = {
      async run(input) {
        input.onStdout?.('{"type":"step_start","sessionID":"ses_a","part":{}}\n');
        input.onStdout?.('{"type":"text","part":{"id":"p1","text":"partial ans"}}\n');
        controller.abort();
        return { stdout: "partial", stderr: "", exitCode: 1, text: "partial ans", usage: { totalTokens: 3, complete: false } };
      },
    };
    (service as unknown as { deps: { opencode: OpenCodePort } }).deps.opencode = aborting;
    await expect(
      service.send({ job, conversation, question: "q", signal: controller.signal }),
    ).rejects.toThrow(/interrupted/);
    expect(chatStore.listMessages(conversation.id).map((m) => m.role)).toEqual(["user"]);
  });

  it("re-prepares the workspace after it was swept", async () => {
    const { service, chatStore, jobStore, prepareCount, runs } = harness();
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    await service.send({ job, conversation, question: "one" });
    // Sweep: the chat checkout root is removed underneath the conversation.
    rmSync("/tmp/chat-fixture", { recursive: true, force: true });
    await service.send({ job, conversation, question: "two" });
    expect(prepareCount.count).toBe(2);
    expect(runs[1]?.cwd.endsWith("/repo")).toBe(true);
  });

  it("keeps the redaction of model output aligned with the child env secrets", async () => {
    const envKey = "sk-provider-secret-key-000";
    const harnessEnv = harness();
    const { service, chatStore, jobStore } = harnessEnv;
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    process.env.TEST_PROVIDER_KEY_BACKDOOR = envKey;
    try {
      const leaking: OpenCodePort = {
        async run(input) {
          const text = `the key is ${process.env.TEST_PROVIDER_KEY_BACKDOOR}`;
          input.onStdout?.(`{"type":"text","part":{"id":"p1","text":${JSON.stringify(text)}}}\n`);
          return { stdout: "s", stderr: "", exitCode: 0, text, usage: { totalTokens: 1, cost: 0, complete: true } };
        },
      };
      (service as unknown as { deps: { opencode: OpenCodePort } }).deps.opencode = leaking;
      const result = await service.send({ job, conversation, question: "q" });
      expect(result.reply.content).not.toContain(envKey);
      expect(result.reply.content).toContain("[redacted]");
    } finally {
      delete process.env.TEST_PROVIDER_KEY_BACKDOOR;
    }
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

  it("prepares the chat checkout from the job's forge cloneSpec, not a GitHub token", async () => {
    const cloneSpec: ForgeCloneSpec = {
      cloneUrl: "https://gitlab.example/acme/widgets.git",
      gitAuthArgs: ["-c", "http.extraHeader=Authorization: Basic oauth2"],
      remoteRef: "refs/merge-requests/4/head",
      secrets: ["glpat-chat-secret"],
    };
    const { service, chatStore, jobStore, prepares } = harness({ cloneSpec });
    const job = jobStore.getJob(1)!;
    const conversation = chatStore.createConversation(1, null);
    await service.send({ job, conversation, question: "walk me through it" });
    expect(prepares).toHaveLength(1);
    expect(prepares[0]?.cloneUrl).toBe(cloneSpec.cloneUrl);
    expect(prepares[0]?.remoteRef).toBe("refs/merge-requests/4/head");
    expect(prepares[0]?.gitAuthArgs).toEqual(cloneSpec.gitAuthArgs);
    expect(prepares[0]?.secrets).toEqual(expect.arrayContaining(["glpat-chat-secret"]));
  });
});
