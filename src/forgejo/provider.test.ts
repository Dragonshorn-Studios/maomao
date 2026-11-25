import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import { ForgeConnectionStore } from "../forge/connections.js";
import { ForgeRegistry } from "../forge/registry.js";
import { generateForgeKeyHex } from "../forge/secretbox.js";
import type { GithubPort } from "../github/client.js";
import { createPipeline } from "../jobs/pipeline.js";
import { JobStore } from "../jobs/store.js";
import type { CheckoutPort } from "../checkout.js";
import type { OpenCodePort } from "../opencode/parse.js";
import { ForgejoProvider, forgejoStatusState } from "./provider.js";
import type { TrustedCheckRunner } from "../checks/trusted.js";

const TARGET = {
  provider: "forgejo",
  instance: "127.0.0.1",
  repoOwner: "acme",
  repoName: "widgets",
  repoFullName: "acme/widgets",
  changeNumber: 7,
};

function fixtureServer(state: { statuses: unknown[]; comments: Array<{ id: number; body: string; html_url?: string }>; requests: string[] }) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const url = req.url ?? "";
      state.requests.push(`${req.method} ${url}`);
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url === "/api/v1/repos/acme/widgets" && req.method === "GET") {
        json(200, { allow_merge_commits: true, allow_squash_merge: true, allow_rebase: false, allow_fast_forward_only_merge: false });
        return;
      }
      if (url === "/api/v1/repos/acme/widgets/branches/main" && req.method === "GET") {
        json(200, { protected: true, enable_status_check: true, status_check_contexts: ["test", "maomao/merge-readiness"], required_approvals: 2 });
        return;
      }
      if (url === "/api/v1/version" && req.method === "GET") {
        json(200, { version: "17.0.1" });
        return;
      }
      if (url === "/api/v1/repos/acme/widgets/pulls/7") {
        json(200, {
          number: 7,
          title: "Add frob",
          body: "description",
          html_url: "https://forgejo.example/acme/widgets/pulls/7",
          user: { login: "octocat" },
          base: { sha: "base111", ref: "main" },
          head: { sha: "head222", ref: "feature" },
          draft: false,
        });
        return;
      }
      if (url === "/api/v1/repos/acme/widgets/pulls/7.diff") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n");
        return;
      }
      if (url.startsWith("/api/v1/repos/acme/widgets/issues/7/comments") && req.method === "GET") {
        json(200, state.comments);
        return;
      }
      if (url === "/api/v1/repos/acme/widgets/issues/7/comments" && req.method === "POST") {
        const parsed = JSON.parse(body) as { body: string };
        state.comments.push({ id: 99, body: parsed.body, html_url: "https://forgejo.example/comments/99" });
        json(201, { id: 99, html_url: "https://forgejo.example/comments/99" });
        return;
      }
      if (url === "/api/v1/repos/acme/widgets/statuses/head222" && req.method === "POST") {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        state.statuses.push(parsed);
        json(201, { id: 123, target_url: parsed.target_url });
        return;
      }
      json(404, { message: "not found" });
    });
  });
  return server;
}

async function providerOn(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const store = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
  const row = store.create({
    provider: "forgejo",
    label: "local",
    instanceUrl: `http://127.0.0.1:${port}`,
    token: "forgejo-token-value",
    tokenType: "pat",
    scopeType: "instance",
    scopePath: "",
    webhookSecret: "webhook-secret",
    allowPrivateNetwork: true,
    allowInsecureHttp: true,
    allowApprove: false,
  });
  store.recordProbe(row.id, { botUserId: 5, botUsername: "maomao-bot" });
  return { store, provider: new ForgejoProvider(store.open(row.id)), row };
}

describe("ForgejoProvider", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it("reads pull metadata and raw diffs through the v1 API", async () => {
    const state = { statuses: [] as unknown[], comments: [] as Array<{ id: number; body: string; html_url?: string }>, requests: [] as string[] };
    server = fixtureServer(state);
    const { provider } = await providerOn(server);
    await expect(provider.getChange(TARGET)).resolves.toMatchObject({ headSha: "head222", baseSha: "base111", draft: false });
    await expect(provider.getChangeDiff(TARGET)).resolves.toContain("diff --git a/a.ts");
    expect(state.requests).toContain("GET /api/v1/repos/acme/widgets/pulls/7.diff");
  });

  it("reads merge capabilities without exposing a merge control", async () => {
    const state = { statuses: [] as unknown[], comments: [] as Array<{ id: number; body: string; html_url?: string }>, requests: [] as string[] };
    server = fixtureServer(state);
    const { provider } = await providerOn(server);
    await expect(provider.probeMergeCapabilities(TARGET)).resolves.toMatchObject({
      nativeAutoMerge: "unknown",
      githubNativeQueue: "unavailable",
      requiredStatusContexts: ["maomao/merge-readiness", "test"],
      requiredApprovals: 2,
      protectedBranch: true,
      mergeMethods: ["merge", "squash"],
      baseRef: "main",
      draft: false,
      forgeVersion: "17.0.1",
      source: "forgejo-api",
    });
    expect(state.requests).toContain("GET /api/v1/repos/acme/widgets/branches/main");
  });

  it("posts summaries with inline findings retained in the body", async () => {
    const state = { statuses: [] as unknown[], comments: [] as Array<{ id: number; body: string; html_url?: string }>, requests: [] as string[] };
    server = fixtureServer(state);
    const { provider } = await providerOn(server);
    const result = await provider.publishReview({
      target: TARGET,
      commitId: "head222",
      body: "<!-- maomao-review sha=head222 -->\nsummary",
      verdict: "COMMENT",
      comments: [{ path: "a.ts", line: 2, body: "<!-- maomao-finding id=fp -->\nhigh bug" }],
    });
    expect(result.id).toBe("99");
    expect(state.comments[0]?.body).toContain("### Findings");
    expect(state.comments[0]?.body).toContain("high bug");
    expect(result.warnings?.[0]).toContain("line anchors");
  });

  it("publishes commit statuses with Forgejo state mapping", async () => {
    const state = { statuses: [] as unknown[], comments: [] as Array<{ id: number; body: string; html_url?: string }>, requests: [] as string[] };
    server = fixtureServer(state);
    const { provider } = await providerOn(server);
    const result = await provider.publishCheck({
      target: TARGET,
      commitSha: "head222",
      name: "maomao/review",
      externalId: "external",
      status: "completed",
      conclusion: "failure",
      title: "Maomao review failed",
      summary: "summary",
      detailsUrl: "https://maomao.example/jobs/1",
    });
    expect(result.id).toBe("123");
    expect(state.statuses[0]).toMatchObject({
      context: "maomao/review",
      state: "failure",
      description: "Maomao review failed",
      target_url: "https://maomao.example/jobs/1",
    });
  });

  it("maps check conclusions without inventing GitHub-only states", () => {
    expect(forgejoStatusState({ status: "queued" } as never)).toBe("pending");
    expect(forgejoStatusState({ status: "completed", conclusion: "success" } as never)).toBe("success");
    expect(forgejoStatusState({ status: "completed", conclusion: "neutral" } as never)).toBe("warning");
    expect(forgejoStatusState({ status: "completed", conclusion: "timed_out" } as never)).toBe("error");
  });

  it("creates Forgejo connections on /api/v1 and resolves through the registry", async () => {
    server = fixtureServer({ statuses: [], comments: [], requests: [] as string[] });
    const { store, row } = await providerOn(server);
    expect(store.get(row.id)?.api_base_url).toContain("/api/v1");
    const registry = new ForgeRegistry({} as GithubPort, "maomao", undefined, store);
    const forge = registry.forJob({ provider: "forgejo", provider_instance: "127.0.0.1", forge_connection_id: row.id, installation_id: 42 });
    expect(forge).toBeInstanceOf(ForgejoProvider);
  });
});

async function fixtureCheckout(): Promise<CheckoutPort> {
  return {
    async prepare(input) {
      const dir = await mkdtemp(join(tmpdir(), "maomao-fj-ws-"));
      const repoDir = join(dir, "repo");
      await mkdir(repoDir, { recursive: true });
      await writeFile(join(repoDir, "a.ts"), "export const b = 2;\n");
      const diffPath = join(dir, "pr.diff");
      const metaPath = join(dir, "pr.json");
      await writeFile(diffPath, await input.fetchDiff());
      await writeFile(metaPath, JSON.stringify(input.metadata));
      return { dir, repoDir, diffPath, metaPath };
    },
    async cleanup() {},
  };
}

describe("pipeline over a Forgejo job (end-to-end)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it("runs the shared pipeline, posts one review comment, and publishes native statuses", async () => {
    const state = { statuses: [] as Array<Record<string, unknown>>, comments: [] as Array<{ id: number; body: string; html_url?: string }>, requests: [] as string[] };
    server = fixtureServer(state);
    const { store: connections, row } = await providerOn(server);
    const config = loadConfig({ REVIEWER_ROLES: "correctness", OPENCODE_REVIEWER_MODEL: "test/model", REVIEWER_ROUTING: "fixed", MAOMAO_PUBLIC_URL: "https://maomao.example" });
    const jobs = new JobStore(openDb(":memory:"));
    const created = jobs.enqueue({
      repoFullName: "acme/widgets",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 42,
      provider: "forgejo",
      providerInstance: "127.0.0.1",
      forgeConnectionId: row.id,
      prNumber: 7,
      prTitle: "Add frob",
      prBody: "",
      prHtmlUrl: "",
      prAuthor: "octocat",
      baseSha: "base111",
      headSha: "head222",
      baseRef: "main",
      headRef: "feature",
      reviewers: [{ role: "correctness", title: "Correctness" }],
    });
    const github = {
      getInstallationToken: async () => "t",
      getPullDiff: async () => "diff",
      listReviews: async () => [],
      createCommentReview: async () => ({ id: "1", url: "u" }),
    } as unknown as GithubPort;
    const opencode: OpenCodePort = {
      async run(input) {
        const specialist = input.prompt.includes("Role id:");
        const finding = {
          severity: "medium",
          confidence: 0.9,
          category: "correctness",
          file: "a.ts",
          line: 1,
          summary: "forgejo finding",
          body: "because the diff says so",
        };
        const text = specialist
          ? JSON.stringify({ schema_version: 1, reviewer: "correctness", verdict: "findings", findings: [{ ...finding, reason: finding.body }] })
          : JSON.stringify({ verdict: "comment", summary: "one finding", findings: [{ ...finding, reviewers_agreed: ["correctness"] }] });
        return { stdout: text, stderr: "", exitCode: 0, text, usage: { promptTokens: 3, completionTokens: 2 } };
      },
    };
    const registry = new ForgeRegistry(github, "maomao", undefined, connections);
    const trustedRunner = {
      enabled: () => true,
      enabledFor: () => true,
      async run(input: { name: "secrets" | "security" }) {
        const failure = input.name === "secrets";
        return {
          name: input.name,
          nativeName: `maomao/${input.name}`,
          status: failure ? "failure" as const : "success" as const,
          conclusion: failure ? "failure" as const : "success" as const,
          findings: failure
            ? [{ severity: "high" as const, category: "secret", file: "a.ts", line: 1, summary: "credential detected", evidence: "[redacted]" }]
            : [],
          diagnostics: "",
          scannerName: `${input.name}-fixture`,
          revision: "0123456789abcdef0123456789abcdef01234567",
          durationMs: 1,
        };
      },
    } as unknown as TrustedCheckRunner;
    await createPipeline({ config, store: jobs, github, forge: registry, checkout: await fixtureCheckout(), opencode, trustedCheckRunner: trustedRunner }).run(created.job.id);

    expect(jobs.getJob(created.job.id)?.state).toBe("completed");
    expect(state.comments.some((comment) => comment.body.includes("forgejo finding"))).toBe(true);
    expect(state.statuses.length).toBeGreaterThanOrEqual(6);
    expect(state.statuses.filter((status) => status.context === "maomao/review").at(-1)).toMatchObject({ state: "warning", target_url: expect.any(String) });
    expect(state.statuses.filter((status) => status.context === "maomao/secrets").at(-1)).toMatchObject({ state: "failure" });
    expect(state.statuses.filter((status) => status.context === "maomao/security").at(-1)).toMatchObject({ state: "success" });
    expect(state.statuses.filter((status) => status.context === "maomao/merge-readiness").at(-1)).toMatchObject({ state: "failure" });
    const storedChecks = jobs.listTrustedCheckResults(created.job.id);
    expect(storedChecks.map((row) => row.name).sort()).toEqual(["maomao/secrets", "maomao/security"]);
    expect(storedChecks.find((row) => row.name === "maomao/secrets")?.findings_json).toContain("credential detected");
  });
});
