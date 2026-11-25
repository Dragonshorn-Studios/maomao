import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import { ForgeConnectionStore } from "../forge/connections.js";
import { generateForgeKeyHex } from "../forge/secretbox.js";
import { JobStore } from "../jobs/store.js";
import { verifyForgejoWebhook } from "./signature.js";
import { handleForgejoWebhook, parseForgejoPullEvent, shouldHandleForgejoPull, withinForgejoScope, type ForgejoWebhookRequest } from "./webhooks.js";

const SECRET = "forgejo-webhook-secret";

function connections() {
  return new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
}

function createConnection(store: ForgeConnectionStore) {
  return store.create({
    provider: "forgejo",
    label: "forgejo-acme",
    instanceUrl: "https://forgejo.example",
    token: "forgejo-token-value",
    tokenType: "pat",
    scopeType: "group",
    scopePath: "acme",
    webhookSecret: SECRET,
    allowPrivateNetwork: false,
    allowInsecureHttp: false,
    allowApprove: false,
  });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    number: 7,
    pull_request: {
      number: 7,
      title: "Add frob",
      body: "body",
      html_url: "https://forgejo.example/acme/widgets/pulls/7",
      user: { login: "octocat" },
      merged: false,
      draft: false,
      base: { sha: "base111", ref: "main" },
      head: { sha: "head222", ref: "feature" },
    },
    repository: { id: 42, full_name: "acme/widgets" },
    sender: { login: "octocat" },
    ...overrides,
  };
}

function signed(body: string, overrides: Partial<ForgejoWebhookRequest> = {}): ForgejoWebhookRequest {
  return {
    event: "pull_request",
    rawBody: body,
    deliveryId: `delivery-${Math.random().toString(16).slice(2)}`,
    forgejoSignature: createHmac("sha256", SECRET).update(body).digest("hex"),
    ...overrides,
  };
}

function input(store: ForgeConnectionStore, connectionId: string, request: ForgejoWebhookRequest) {
  return {
    config: loadConfig({ REVIEWER_ROLES: "correctness" }),
    store: new JobStore(openDb(":memory:")),
    connections: store,
    connectionId,
    request,
  };
}

describe("Forgejo webhook verification and parsing", () => {
  it("accepts native bare-hex and GitHub-compatible signatures", () => {
    const digest = createHmac("sha256", SECRET).update("body").digest("hex");
    expect(verifyForgejoWebhook(SECRET, "body", { forgejoSignature: digest })).toBe(true);
    expect(verifyForgejoWebhook(SECRET, "body", { hubSignature256: `sha256=${digest}` })).toBe(true);
    expect(verifyForgejoWebhook(SECRET, "body", { forgejoSignature: "bad" })).toBe(false);
  });

  it("parses pull payloads and applies review actions", () => {
    const parsed = parseForgejoPullEvent(JSON.stringify(payload()));
    expect(parsed).toMatchObject({ repoFullName: "acme/widgets", prNumber: 7, headSha: "head222", baseSha: "base111" });
    expect(shouldHandleForgejoPull(loadConfig({ REVIEWER_ROLES: "correctness" }), parsed).handle).toBe(true);
    expect(shouldHandleForgejoPull(loadConfig({ REVIEWER_ROLES: "correctness" }), { ...parsed, action: "edited" }).handle).toBe(false);
  });

  it("scopes group connections to the Forgejo owner", () => {
    const store = connections();
    const row = createConnection(store);
    const opened = store.open(row.id);
    expect(withinForgejoScope(opened, "acme/widgets")).toBe(true);
    expect(withinForgejoScope(opened, "other/widgets")).toBe(false);
  });
});

describe("Forgejo pull_request handling", () => {
  it("enqueues an opened pull request at its exact head SHA", async () => {
    const store = connections();
    const row = createConnection(store);
    const deps = input(store, row.id, signed(JSON.stringify(payload())));
    const result = await handleForgejoWebhook(deps);
    expect(result.status).toBe(202);
    expect(result.enqueue?.created).toBe(true);
    expect(deps.store.getJob(result.enqueue!.job.id)).toMatchObject({
      provider: "forgejo",
      provider_instance: "forgejo.example",
      forge_connection_id: row.id,
      repo_full_name: "acme/widgets",
      pr_number: 7,
      head_sha: "head222",
      installation_id: 42,
    });
  });

  it("rejects bad signatures and ignores out-of-scope repositories", async () => {
    const store = connections();
    const row = createConnection(store);
    const bad = await handleForgejoWebhook(input(store, row.id, { ...signed(JSON.stringify(payload())), forgejoSignature: "bad" }));
    expect(bad.status).toBe(401);
    const outsideBody = JSON.stringify(payload({ repository: { id: 42, full_name: "other/widgets" } }));
    const outside = await handleForgejoWebhook(input(store, row.id, signed(outsideBody)));
    expect(outside.status).toBe(202);
    expect(outside.body.ignored).toBe(true);
  });

  it("cancels active jobs when the pull request is merged", async () => {
    const store = connections();
    const row = createConnection(store);
    const openedDeps = input(store, row.id, signed(JSON.stringify(payload())));
    const opened = await handleForgejoWebhook(openedDeps);
    const closedBody = JSON.stringify(payload({ action: "closed", pull_request: { ...payload().pull_request, merged: true } }));
    const closedDeps = { ...input(store, row.id, signed(closedBody)), store: openedDeps.store };
    const closed = await handleForgejoWebhook(closedDeps);
    expect(closed.status).toBe(200);
    expect(closed.body.cancelled).toBe(1);
    expect(openedDeps.store.getJob(opened.enqueue!.job.id)?.state).toBe("cancelled");
  });
});
