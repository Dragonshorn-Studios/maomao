/**
 * Finding lifecycle parity for GitLab (issue #18 slice 5, parity with #17):
 * prior Maomao discussions reconcile before routing, fixed findings resolve
 * through the Discussions API, dismissed-vs-resolved survive, bury notes
 * remove findings for the rest of the MR, and none of it crosses connections.
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
import { fingerprintFinding, findingMarker } from "../findings/identity.js";
import { ForgeConnectionStore } from "../forge/connections.js";
import { ForgeRegistry } from "../forge/registry.js";
import { generateForgeKeyHex } from "../forge/secretbox.js";
import { handleGitLabWebhook } from "./webhooks.js";

const HEAD = "head333";

const FINDING = {
  severity: "medium" as const,
  confidence: 0.9,
  category: "correctness",
  file: "src/app.ts",
  line: 2,
  summary: "unchecked subtraction can underflow the counter",
  body: "the counter goes negative",
  reason: "because the diff says so",
};

const FP = fingerprintFinding({
  category: FINDING.category,
  file: FINDING.file,
  line: FINDING.line,
  summary: FINDING.summary,
  body: FINDING.body,
});

function lifecycleFixture() {
  const state = {
    notes: [] as Array<{ id: number; body: string }>,
    /** Prior Maomao discussion for the finding, unresolved. */
    discussions: [
      {
        id: "disc-prior",
        notes: [
          {
            id: 8000,
            body: `${findingMarker(FP, HEAD)}\n**medium**: ${FINDING.summary}`,
            author: { id: 999, username: "maomao-bot" },
            resolvable: true,
            resolved: false,
          },
        ],
      },
    ],
    resolutions: [] as Array<{ id: string; resolved: boolean }>,
    versions: [{ base_sha: "base111", start_sha: "start222", head_sha: HEAD }],
    changes: {
      changes: [
        {
          old_path: "src/app.ts",
          new_path: "src/app.ts",
          diff: `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n const c = 3;\n`,
        },
      ],
    },
  };
  return { state };
}

function startLifecycleMock(state: ReturnType<typeof lifecycleFixture>["state"]): Promise<{ server: Server; origin: string }> {
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
        const body = JSON.parse(requestBody) as { body: string };
        state.discussions.push({
          id: `disc-${state.discussions.length + 1}`,
          notes: [{ id: 9000 + state.discussions.length, body: body.body, author: { id: 999, username: "maomao-bot" }, resolvable: true, resolved: false }],
        });
        respond(201, { id: `disc-${state.discussions.length}` });
        return;
      }
      if (url.includes("/discussions/") && req.method === "PUT") {
        const id = decodeURIComponent(url.split("/discussions/")[1]?.split("?")[0] ?? "");
        state.resolutions.push({ id, resolved: url.includes("resolved=true") });
        // Mark the seeded discussion resolved so later listings agree.
        for (const discussion of state.discussions) {
          if (discussion.id === id) {
            for (const note of discussion.notes) {
              if (note.resolvable) note.resolved = url.includes("resolved=true");
            }
          }
        }
        respond(200, { id });
        return;
      }
      if (url.includes("/discussions") && req.method === "GET") {
        respond(200, state.discussions);
        return;
      }
      if (url.includes("/versions")) {
        respond(200, state.versions);
        return;
      }
      if (url.includes("/changes")) {
        respond(200, state.changes);
        return;
      }
      if (url === "/api/v4/projects/42/merge_requests/7") {
        respond(200, {
          iid: 7,
          title: "Add frob",
          state: "opened",
          web_url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
          author: { username: "octocat" },
          source_branch: "feature",
          target_branch: "main",
          sha: HEAD,
          diff_refs: { base_sha: "base111", start_sha: "start222", head_sha: HEAD },
        });
        return;
      }
      respond(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function fixtureCheckout(): Promise<CheckoutPort> {
  return {
    async prepare(input) {
      const dir = await mkdtemp(join(tmpdir(), "maomao-lc-ws-"));
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

/** Fake OpenCode: verifier resolves or keeps the prior finding; reviewers re-find it; aggregator echoes. */
function fakeOpencode(mode: "resolved" | "still_valid", calls: { verifier: number }): OpenCodePort {
  return {
    async run(input) {
      if (input.title?.includes("verifier") || input.prompt.includes("finding verifier")) {
        calls.verifier += 1;
        console.log("VERIFIER CALL for", input.title);
        const status = mode === "resolved" ? "resolved" : "still_valid";
        return {
          stdout: JSON.stringify({
            classifications: [{ fingerprint: FP, status, confidence: 0.95, reason: "parity fixture" }],
          }),
          stderr: "",
          exitCode: 0,
          text: "",
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }
      if (input.title?.includes("aggregator")) {
        const text = JSON.stringify({ verdict: "clean", summary: "the prior finding is gone", findings: [] });
        return { stdout: text, stderr: "", exitCode: 0, text, usage: { promptTokens: 1, completionTokens: 1 } };
      }
      // The issue was fixed: the specialist no longer re-finds it.
      const text = JSON.stringify({
        schema_version: 1,
        reviewer: "correctness",
        verdict: "clean",
        findings: [],
      });
      return { stdout: text, stderr: "", exitCode: 0, text, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
}

describe("GitLab finding lifecycle parity", () => {
  let server: Server;
  let origin: string;
  let state: ReturnType<typeof lifecycleFixture>["state"];
  let connections: ForgeConnectionStore;
  let connectionId: string;
  let store: JobStore;
  const verifierCalls = { verifier: 0 };

  function enqueueJob(headSha: string) {
    return store.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      provider: "gitlab",
      providerInstance: "127.0.0.1",
      forgeConnectionId: connectionId,
      prNumber: 7,
      prTitle: "Add frob",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "octocat",
      baseSha: "base111",
      headSha,
      baseRef: "main",
      headRef: "feature",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
  }

  async function pipeline() {
    const config = loadConfig({
      REVIEWER_ROLES: "correctness",
      OPENCODE_REVIEWER_MODEL: "test/model",
      OPENCODE_VERIFIER_MODEL: "test/model",
      REVIEWER_ROUTING: "fixed",
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
    return createPipeline({
      config,
      store,
      github,
      forge: new ForgeRegistry(github, "maomao", undefined, connections),
      checkout: await fixtureCheckout(),
      opencode: fakeOpencode("resolved", verifierCalls),
    });
  }

  beforeAll(async () => {
    const fixture = lifecycleFixture();
    state = fixture.state;
    const started = await startLifecycleMock(state);
    server = started.server;
    origin = started.origin;
    connections = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
    connectionId = connections
      .create({
        provider: "gitlab",
        label: "acme",
        instanceUrl: origin,
        token: "glpat-lifecycle-token-value",
        tokenType: "group",
        scopeType: "group",
        scopePath: "acme",
        webhookSecret: "whsec-lifecycle-value",
        allowPrivateNetwork: true,
        allowInsecureHttp: true,
        allowApprove: false,
      })
      .id;
    store = new JobStore(openDb(":memory:"));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reconciles the prior discussion, resolves the fixed finding, and records it", async () => {
    // Seed the prior finding exactly as a previous run's publication would have.
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: FP,
      scope: { provider: "gitlab", instance: "127.0.0.1" },
      status: "open",
      reviewedSha: HEAD,
      currentSha: HEAD,
      summary: FINDING.summary,
      body: FINDING.body,
      severity: FINDING.severity,
      category: FINDING.category,
      originalPath: FINDING.file,
      originalLine: FINDING.line,
      githubThreadId: "disc-prior",
    });

    const created = enqueueJob(HEAD);
    const runner = await pipeline();
    await runner.run(created.job.id);

    const job = store.getJob(created.job.id);
    if (job?.state !== "completed") {
      console.log("STATE", job?.state, "REASON", job?.failure_reason);
      console.log(store.listLogs(created.job.id).map((l) => `${l.level}: ${l.message.slice(0, 200)}`).join("\n"));
    }
    expect(job?.state).toBe("completed");
    // The fixed finding resolved through the Discussions API…
    expect(state.resolutions).toContainEqual({ id: "disc-prior", resolved: true });
    // …and the stored row says resolved (not dismissed) with the reason.
    const row = store.listFindings("acme/widgets", 7, { provider: "gitlab", instance: "127.0.0.1" })[0];
    expect(row?.status).toBe("resolved");
    expect(row?.dismissed_by).toBeNull();
    expect(row?.reconciliation_reason).toContain("parity fixture");
  });

  it("keeps a buried finding buried: the bury note dismisses and the next publish omits it", async () => {
    // The finding is open again after a republish on a new head.
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: FP,
      scope: { provider: "gitlab", instance: "127.0.0.1" },
      status: "open",
      reviewedSha: HEAD,
      summary: FINDING.summary,
      githubThreadId: "disc-prior",
    });
    state.discussions[0].notes[0].resolved = false;

    // An authorized human buries it through a note reply in the discussion.
    // The reply note lives inside the seeded discussion, like real GitLab.
    state.discussions[0].notes.push({
      id: 9100,
      body: "@maomao bury",
      author: { id: 222, username: "maintainer" },
      resolvable: false,
      resolved: false,
    });
    const bury = await handleGitLabWebhook({
      config: loadConfig({ REVIEWER_ROLES: "correctness" }),
      store,
      connections,
      connectionId,
      request: {
        event: "note",
        rawBody: JSON.stringify({
          object_kind: "note",
          user: { id: 222, username: "maintainer" },
          project: { id: 42, path_with_namespace: "acme/widgets" },
          object_attributes: { id: 9100, note: "@maomao bury", noteable_type: "MergeRequest", action: "created" },
          merge_request: { iid: 7 },
        }),
        legacyToken: "whsec-lifecycle-value",
      },
      gitlabFactory: () => ({
        listDiscussions: async () => ({
          discussions: state.discussions.map((discussion) => ({
            id: discussion.id,
            individual_note: false,
            notes: discussion.notes,
          })),
          truncated: false,
        }),
        resolveDiscussion: async (_projectId: number, _iid: number, discussionId: string, resolved: boolean) => {
          state.resolutions.push({ id: discussionId, resolved });
        },
        getAccessLevel: async () => 40,
      }),
    });
    expect(bury.status).toBe(200);
    expect(bury.body.status).toBe("dismissed");
    const buried = store.listFindings("acme/widgets", 7, { provider: "gitlab", instance: "127.0.0.1" })[0];
    expect(buried?.status).toBe("dismissed");
    expect(buried?.dismissed_by).toBe("maintainer");

    // The next review of a NEW head re-finds the same code issue, but the
    // dismissed fingerprint is omitted from publication.
    const nextHead = "head555";
    state.versions = [{ base_sha: "base111", start_sha: "start222", head_sha: nextHead }];
    const created = enqueueJob(nextHead);
    const notesBefore = state.notes.length;
    const discussionsBefore = state.discussions.length;
    const nextPipeline = pipeline();
    void nextPipeline;
    await (await pipeline()).run(created.job.id);
    const job = store.getJob(created.job.id);
    expect(job?.state).toBe("completed");
    // No new discussion and no new summary mention of the buried finding.
    expect(state.discussions.length).toBe(discussionsBefore);
    const summary = state.notes.slice(notesBefore).find((note) => note.body.includes(`maomao-review sha=${nextHead}`));
    if (summary) {
      expect(summary.body).not.toContain(FINDING.summary);
    }
    // Dismissed is preserved as a human override, distinct from resolved.
    const row = store.listFindings("acme/widgets", 7, { provider: "gitlab", instance: "127.0.0.1" })[0];
    expect(row?.status).toBe("dismissed");
    expect(row?.dismiss_command).toBe("bury");
  });

  it("skips the verifier for prior discussions the forge already resolved", async () => {
    // Self-contained: a second finding whose forge discussion is already
    // resolved, on a store row that is stale-open.
    const otherFp = fingerprintFinding({
      category: "correctness",
      file: "src/app.ts",
      summary: "other resolved issue on the same MR",
      body: "",
    });
    state.discussions.push({
      id: "disc-prior-2",
      notes: [
        {
          id: 8500,
          body: `${findingMarker(otherFp, HEAD)}\n**low**: other resolved issue on the same MR`,
          author: { id: 999, username: "maomao-bot" },
          resolvable: true,
          resolved: true,
        },
      ],
    });
    store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: otherFp,
      scope: { provider: "gitlab", instance: "127.0.0.1" },
      status: "open",
      reviewedSha: HEAD,
      summary: "other resolved issue on the same MR",
      githubThreadId: "disc-prior-2",
    });
    const before = verifierCalls.verifier;
    const probeConnections = connections;
    const probeRow = probeConnections.get(connectionId)!;
    const probeProvider = new (await import("./provider.js")).GitLabProvider(probeConnections.open(probeRow.id));
    const probeDiscussions = await probeProvider.listDiscussions({
      provider: "gitlab", instance: "127.0.0.1", repoOwner: "acme", repoName: "widgets", repoFullName: "acme/widgets", changeNumber: 7, nativeProjectId: 42,
    });
    console.log("PROBE DISCUSSIONS", JSON.stringify(probeDiscussions));
    console.log("STORED ROWS", store.listFindings("acme/widgets", 7, { provider: "gitlab", instance: "127.0.0.1" }).map((r) => `${r.fingerprint}/${r.status}/thread=${r.github_thread_id}`));
    console.log("STATE DISCUSSIONS", state.discussions.map((d) => `${d.id}:${d.notes.map((n) => `${n.id}:resolvable=${n.resolvable}:resolved=${n.resolved}`).join(",")}`));
    const created = enqueueJob("head777");
    state.versions = [{ base_sha: "base111", start_sha: "start222", head_sha: "head777" }];
    await (await pipeline()).run(created.job.id);
    const snap = JSON.parse(store.getJob(created.job.id)?.reconciliation_json ?? "{}") as { items: Array<{ fingerprint: string; status: string; reason: string }> };
    console.log("CLASSIFIED", snap.items.map((item) => `${item.fingerprint}:${item.status}:${item.reason}`));
    // The forge-resolved discussion settled without a verifier spend.
    expect(verifierCalls.verifier).toBe(before);
    const row = store.getFinding("acme/widgets", 7, otherFp, { provider: "gitlab", instance: "127.0.0.1" });
    expect(row?.status).toBe("resolved");
  });
});
