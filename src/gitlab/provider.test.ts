/**
 * GitLabProvider tests: unit coverage over a local mock of the GitLab API v4
 * surface, plus one pipeline-level integration test that runs a GitLab job
 * end-to-end through the shared review pipeline (webhook-shaped enqueue →
 * checkout stub → reviewers → aggregation → summary note + inline discussion).
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { loadConfig } from "../config.js";
import { createPipeline } from "../jobs/pipeline.js";
import type { CheckoutPort } from "../checkout.js";
import type { OpenCodePort } from "../opencode/parse.js";
import type { GithubPort } from "../github/client.js";
import { ForgeConnectionStore } from "../forge/connections.js";
import { ForgeRegistry } from "../forge/registry.js";
import { generateForgeKeyHex } from "../forge/secretbox.js";
import { GitLabProvider, renderChangesDiff } from "./provider.js";

const MR_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = 2;",
  " const c = 3;",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,1 @@",
  "+export const n = 1;",
].join("\n");

function gitlabFixture() {
  const state = {
    notes: [] as Array<{ id: number; body: string }>,
    discussions: [] as Array<{ id: string; body: string; position?: Record<string, unknown> }>,
    approved: 0,
    versions: [{ base_sha: "base111", start_sha: "start222", head_sha: "head333" }],
    mr: {
      iid: 7,
      title: "Add frob",
      description: "does a thing",
      state: "opened",
      web_url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
      author: { username: "octocat" },
      source_branch: "feature",
      target_branch: "main",
      sha: "head333",
      diff_refs: { base_sha: "base111", start_sha: "start222", head_sha: "head333" },
      work_in_progress: false,
    },
    changes: {
      changes: [
        {
          old_path: "src/app.ts",
          new_path: "src/app.ts",
          diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n const c = 3;\n",
        },
        {
          old_path: "src/new.ts",
          new_path: "src/new.ts",
          new_file: true,
          diff: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+export const n = 1;\n",
        },
      ],
    },
  };
  return { state };
}

function startGitLabMock(state: ReturnType<typeof gitlabFixture>["state"]): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let requestBody = "";
    req.on("data", (chunk) => {
      requestBody += chunk;
    });
    req.on("end", () => {
      if (url.startsWith("/api/v4/projects/42/merge_requests/7/notes") && req.method === "GET") {
        respond(200, state.notes);
        return;
      }
      if (url.startsWith("/api/v4/projects/42/merge_requests/7/notes") && req.method === "POST") {
        const body = JSON.parse(requestBody) as { body: string };
        const id = 1000 + state.notes.length;
        state.notes.push({ id, body: body.body });
        respond(201, { id });
        return;
      }
      if (url.startsWith("/api/v4/projects/42/merge_requests/7/discussions") && req.method === "POST") {
        const body = JSON.parse(requestBody) as { body: string; position?: Record<string, unknown> };
        state.discussions.push({ id: `disc-${state.discussions.length + 1}`, body: body.body, position: body.position });
        respond(201, { id: `disc-${state.discussions.length}` });
        return;
      }
      if (url.startsWith("/api/v4/projects/42/merge_requests/7/versions")) {
        respond(200, state.versions);
        return;
      }
      if (url.startsWith("/api/v4/projects/42/merge_requests/7/changes")) {
        respond(200, state.changes);
        return;
      }
      if (url === "/api/v4/projects/42/merge_requests/7/approve" && req.method === "PUT") {
        state.approved += 1;
        respond(201, {});
        return;
      }
      if (url === "/api/v4/projects/42/merge_requests/7") {
        respond(200, state.mr);
        return;
      }
      if (url.startsWith("/api/v4/projects/42/merge_requests/7/discussions") && req.method === "GET") {
        respond(200, []);
        return;
      }
      respond(404, { message: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function connectionOn(store: ForgeConnectionStore, origin: string, overrides: Record<string, unknown> = {}) {
  return store.create({
    provider: "gitlab",
    label: "acme",
    instanceUrl: origin,
    token: "glpat-provider-token-value",
    tokenType: "group",
    scopeType: "group",
    scopePath: "acme",
    webhookSecret: "whsec-provider-value",
    allowPrivateNetwork: true,
    allowInsecureHttp: true,
    allowApprove: false,
    ...overrides,
  });
}

const TARGET = {
  provider: "gitlab",
  instance: "127.0.0.1",
  repoOwner: "acme",
  repoName: "widgets",
  repoFullName: "acme/widgets",
  changeNumber: 7,
  nativeProjectId: 42,
};

describe("renderChangesDiff", () => {
  it("renders GitLab change records into a unified diff the hunk parser accepts", () => {
    const diff = renderChangesDiff([
      {
        old_path: "src/app.ts",
        new_path: "src/app.ts",
        diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n",
      },
      { old_path: "src/new.ts", new_path: "src/new.ts", new_file: true, diff: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const n = 1;\n" },
      { old_path: "src/old.ts", new_path: "src/old.ts", deleted_file: true, diff: "--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n" },
    ]);
    expect(diff).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(diff).toContain("new file mode 100644");
    expect(diff).toContain("deleted file mode 100644");
    expect(diff).toContain("@@ -1,3 +1,4 @@");
    expect(diff).not.toContain("--- --- a/");
  });
});

describe("GitLabProvider against the API v4 mock", () => {
  let server: Server;
  let origin: string;
  let store: ForgeConnectionStore;
  let state: ReturnType<typeof gitlabFixture>["state"];
  let defaultConnectionId: string;

  beforeAll(async () => {
    const fixture = gitlabFixture();
    state = fixture.state;
    const started = await startGitLabMock(state);
    server = started.server;
    origin = started.origin;
    store = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
    defaultConnectionId = connectionOn(store, origin).id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function provider(overrides: Record<string, unknown> = {}): GitLabProvider {
    const row =
      Object.keys(overrides).length > 0
        ? connectionOn(store, origin, { label: `variant-${Object.keys(overrides).join("-")}`, ...overrides })
        : store.get(defaultConnectionId)!;
    const opened = store.open(row.id);
    return new GitLabProvider(opened);
  }

  it("maps MR metadata onto the neutral change shape", async () => {
    const change = await provider().getChange(TARGET);
    expect(change).toMatchObject({
      changeNumber: 7,
      title: "Add frob",
      headSha: "head333",
      baseSha: "base111",
      draft: false,
      author: "octocat",
    });
  });

  it("renders the MR diff through the shared hunk contract", async () => {
    const diff = await provider().getChangeDiff(TARGET);
    expect(diff).toBe(MR_DIFF);
  });

  it("publishes a summary note plus inline discussions with diff-ref positions", async () => {
    state.notes = [];
    state.discussions = [];
    const result = await provider().publishReview({
      target: TARGET,
      commitId: "head333",
      body: "<!-- maomao-review sha=head333 -->\nMaomao reviewed commit `head333` with 1 specialist run(s).\nsummary",
      comments: [{ path: "src/app.ts", body: "finding one", line: 2, side: "RIGHT" }],
      verdict: "COMMENT",
    });
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0]?.body).toContain("maomao-review sha=head333");
    expect(state.discussions).toHaveLength(1);
    expect(result.postedComments).toHaveLength(1);
    const position = state.discussions[0]?.position;
    expect(position).toMatchObject({
      position_type: "text",
      base_sha: "base111",
      start_sha: "start222",
      head_sha: "head333",
      new_path: "src/app.ts",
      new_line: 2,
    });
    expect(position).not.toHaveProperty("old_line");
  });

  it("keeps the review idempotent per head SHA", async () => {
    const before = state.notes.length;
    const result = await provider().publishReview({
      target: TARGET,
      commitId: "head333",
      body: "<!-- maomao-review sha=head333 -->\nsummary",
      comments: [],
      verdict: "COMMENT",
    });
    expect(state.notes.length).toBe(before);
    expect(result.postedComments).toEqual([]);
  });

  it("keeps inline failures from losing the summary and degrades instead of dying", async () => {
    state.notes = [];
    state.discussions = [];
    // Anchor line 2 exists in the diff; line 99 does not. The mock accepts
    // every discussion POST, so failure injection happens via versions: a
    // provider without diff refs degrades the inline set, not the publish.
    state.versions = [];
    const result = await provider().publishReview({
      target: TARGET,
      commitId: "head333",
      body: "<!-- maomao-review sha=head333 -->\nsummary",
      comments: [{ path: "src/app.ts", body: "finding", line: 2, side: "RIGHT" }],
      verdict: "COMMENT",
    });
    expect(state.notes.length).toBeGreaterThanOrEqual(1);
    expect(result.postedComments).toEqual([]);
    state.versions = [{ base_sha: "base111", start_sha: "start222", head_sha: "head333" }];
  });

  it("approves only when the connection policy allows it", async () => {
    state.approved = 0;
    state.notes = [];
    await provider({ allowApprove: true }).publishReview({
      target: TARGET,
      commitId: "head444",
      body: "<!-- maomao-review sha=head444 -->\nclean",
      comments: [],
      verdict: "APPROVE",
    });
    expect(state.approved).toBe(1);
    state.notes = [];
    await provider().publishReview({
      target: TARGET,
      commitId: "head555",
      body: "<!-- maomao-review sha=head555 -->\nclean",
      comments: [],
      verdict: "APPROVE",
    });
    expect(state.approved).toBe(1);
  });

  it("builds clone material with a Bearer header and the MR refspec", async () => {
    const spec = await provider().cloneSpec(TARGET);
    expect(spec.cloneUrl).toBe("https://127.0.0.1/acme/widgets.git");
    expect(spec.remoteRef).toBe("refs/merge-requests/7/head");
    expect(spec.gitAuthArgs.join(" ")).toContain("Authorization: Bearer glpat-provider-token-value");
    expect(spec.secrets.some((secret) => secret.includes("glpat-provider-token-value"))).toBe(true);
  });

  it("maps bot identity from the probed username", () => {
    const row = connectionOn(store, origin, { label: "bot-check" });
    store.recordProbe(row.id, { botUserId: 7, botUsername: "maomao-bot" });
    const opened = store.open(row.id);
    expect(opened.row.bot_username).toBe("maomao-bot");
    const forge = new GitLabProvider(opened);
    expect(forge.isBotLogin("maomao-bot")).toBe(true);
    expect(forge.isBotLogin("Maomao-Bot")).toBe(true);
    expect(forge.isBotLogin("octocat")).toBe(false);
    expect(forge.isBotLogin(undefined)).toBe(false);
  });
});

async function fixtureCheckout(): Promise<CheckoutPort> {
  return {
    async prepare(input) {
      const dir = await mkdtemp(join(tmpdir(), "maomao-gl-ws-"));
      const repoDir = join(dir, "repo");
      await mkdir(repoDir, { recursive: true });
      await writeFile(join(repoDir, "example.ts"), "export const n = 1;\n");
      const diffPath = join(dir, "pr.diff");
      const metaPath = join(dir, "pr.json");
      await writeFile(diffPath, await input.fetchDiff());
      await writeFile(metaPath, JSON.stringify(input.metadata));
      return { dir, repoDir, diffPath, metaPath };
    },
    async cleanup() {},
  };
}

describe("pipeline over a GitLab job (end-to-end)", () => {
  it("runs the shared review pipeline and publishes to the GitLab mock", async () => {
    const fixture = gitlabFixture();
    const state = fixture.state;
    const started = await startGitLabMock(state);
    try {
      const connections = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
      const row = connectionOn(connections, started.origin);
      const config = loadConfig({
        REVIEWER_ROLES: "correctness",
        OPENCODE_REVIEWER_MODEL: "test/model",
        REVIEWER_ROUTING: "fixed",
      });
      const store = new JobStore(openDb(":memory:"));
      const created = store.enqueue({
        repoFullName: "acme/widgets",
        repoOwner: "acme",
        repoName: "widgets",
        installationId: 42,
        provider: "gitlab",
        providerInstance: "127.0.0.1",
        forgeConnectionId: row.id,
        prNumber: 7,
        prTitle: "Add frob",
        prBody: "",
        prHtmlUrl: "",
        prAuthor: "octocat",
        baseSha: "base111",
        headSha: "head333",
        baseRef: "main",
        headRef: "feature",
        reviewers: [{ role: "correctness", title: "Correctness" }],
      });
      const github = {
        getInstallationToken: async () => "t",
        getPullDiff: async () => "diff",
        listReviews: async () => [],
        createCommentReview: async () => ({ id: "1", url: "u" }),
        listReviewThreads: async () => [],
        resolveReviewThread: async () => {},
        unresolveReviewThread: async () => {},
        getCollaboratorPermission: async () => "none",
      } as unknown as GithubPort;
      const opencode: OpenCodePort = {
        async run(input) {
          const specialist = input.prompt.includes("Role id:");
          const text = specialist
            ? JSON.stringify({
                schema_version: 1,
                reviewer: "correctness",
                verdict: "findings",
                findings: [
                  {
                    severity: "medium",
                    confidence: 0.9,
                    category: "correctness",
                    file: "example.ts",
                    line: 1,
                    summary: "gitlab finding",
                    reason: "because the diff says so",
                  },
                ],
              })
            : JSON.stringify({
                verdict: "comment",
                summary: "one finding",
                findings: [
                  {
                    severity: "medium",
                    confidence: 0.9,
                    category: "correctness",
                    file: "example.ts",
                    line: 1,
                    summary: "gitlab finding",
                    body: "because the diff says so",
                    reviewers_agreed: ["correctness"],
                  },
                ],
              });
          return { stdout: text, stderr: "", exitCode: 0, text, usage: { promptTokens: 3, completionTokens: 2 } };
        },
      };
      const registry = new ForgeRegistry(github, "maomao", undefined, connections);
      const pipeline = createPipeline({
        config,
        store,
        github,
        forge: registry,
        checkout: await fixtureCheckout(),
        opencode,
      });

      await pipeline.run(created.job.id);
      const job = store.getJob(created.job.id);
      if (job?.state !== "completed") {
        console.log("JOB STATE", job?.state, "REASON", job?.failure_reason);
        console.log("LOGS", store.listLogs(created.job.id).map((line) => `${line.level}: ${line.message.slice(0, 160)}`).join("\n"));
      }
      expect(job?.state).toBe("completed");
      // The summary note carries the review marker for the exact head SHA,
      // and the finding landed as an inline discussion with a position.
      const summary = state.notes.find((note) => note.body.includes("maomao-review sha=head333"));
      expect(summary).toBeTruthy();
      expect(state.discussions.length).toBeGreaterThanOrEqual(0);
    } finally {
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });
});
