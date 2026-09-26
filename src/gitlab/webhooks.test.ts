import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import { loadConfig } from "../config.js";
import { RepoRateLimiter } from "../github/rate-limit.js";
import { ForgeConnectionStore } from "../forge/connections.js";
import { generateForgeKeyHex } from "../forge/secretbox.js";
import type { GitLabDiscussion } from "./client.js";
import { computeSignature } from "./signature.js";
import { handleGitLabWebhook, parseMergeRequestEvent, shouldHandleMergeRequest, withinScope, type GitLabWebhookRequest } from "./webhooks.js";
import { accessLevelToPermission, toForgeDiscussions } from "./client.js";
import { decodeSigningSecret } from "./signature.js";

const WHSEC_SECRET = `whsec_${Buffer.from(randomBytes(32)).toString("base64")}`;
const LEGACY_SECRET = "legacy-shared-token";

function newConnections(): ForgeConnectionStore {
  return new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
}

function createConnection(
  store: ForgeConnectionStore,
  overrides: Record<string, unknown> = {},
): { id: string; secret: string } {
  const secret = overrides.webhookSecret === LEGACY_SECRET ? LEGACY_SECRET : WHSEC_SECRET;
  const row = store.create({
    provider: "gitlab",
    label: "acme",
    instanceUrl: "https://gitlab.com",
    token: "glpat-connection-token",
    tokenType: "group",
    scopeType: "group",
    scopePath: "acme",
    webhookSecret: secret,
    allowPrivateNetwork: false,
    allowInsecureHttp: false,
    allowApprove: false,
    ...(overrides as { webhookSecret?: string }),
  });
  return { id: row.id, secret };
}

function signedRequest(
  secret: string,
  event: string,
  rawBody: string,
  overrides: Partial<GitLabWebhookRequest> = {},
): GitLabWebhookRequest {
  const webhookId = `whid-${randomBytes(8).toString("hex")}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = computeSignature(
    Buffer.from(secret.replace(/^whsec_/, ""), "base64"),
    webhookId,
    timestamp,
    rawBody,
  );
  return {
    event,
    rawBody,
    webhookId,
    webhookTimestamp: timestamp,
    webhookSignature: signature,
    ...overrides,
  };
}

function legacyRequest(event: string, rawBody: string, overrides: Partial<GitLabWebhookRequest> = {}): GitLabWebhookRequest {
  return { event, rawBody, legacyToken: LEGACY_SECRET, ...overrides };
}

function mrPayload(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: "merge_request",
    user: { id: 111, username: "octocat" },
    project: { id: 42, path_with_namespace: "acme/widgets" },
    object_attributes: {
      iid: 7,
      title: "Add frob",
      url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
      source_branch: "feature",
      target_branch: "main",
      state: "opened",
      action: "open",
      last_commit: { id: "head222" },
      work_in_progress: false,
      ...overrides,
    },
    ...overrides,
  };
}

function notePayload(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: "note",
    user: { id: 222, username: "maintainer" },
    project: { id: 42, path_with_namespace: "acme/widgets" },
    object_attributes: {
      id: 9001,
      note: "@maomao bury",
      noteable_type: "MergeRequest",
      action: "created",
    },
    merge_request: { iid: 7 },
    ...overrides,
  };
}

function maomaoDiscussions(): GitLabDiscussion[] {
  return [
    {
      id: "disc-1",
      notes: [
        {
          id: 8000,
          body: "<!-- maomao-finding id=fp123 sha=abc -->\n**high**: bug",
          author: { id: 999, username: "maomao-bot" },
          resolvable: true,
          resolved: false,
        },
        {
          id: 9001,
          body: "@maomao bury",
          author: { id: 222, username: "maintainer" },
          resolvable: false,
        },
      ],
    },
  ];
}

function discussionPage(discussions: GitLabDiscussion[]) {
  return { discussions, truncated: false };
}

function gitlabFactory(overrides: { accessLevel?: number; discussions?: GitLabDiscussion[] } = {}) {
  return () => ({
    listDiscussions: async () => discussionPage(overrides.discussions ?? maomaoDiscussions()),
    getAccessLevel: async () => overrides.accessLevel ?? 40,
    resolveDiscussion: async () => {},
  });
}

function baseInput(connections: ForgeConnectionStore, connectionId: string, request: GitLabWebhookRequest) {
  const config = loadConfig({
    GITHUB_WEBHOOK_SECRET: "s3cret",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    REVIEWER_ROLES: "correctness,security",
    MAOMAO_FORGE_KEY: generateForgeKeyHex(),
  });
  return {
    config,
    store: new JobStore(openDb(":memory:")),
    connections,
    rateLimiter: new RepoRateLimiter(),
    connectionId,
    request,
  };
}

describe("GitLab webhook verification", () => {
  it("rejects unknown connections with 404", async () => {
    const connections = newConnections();
    const result = await handleGitLabWebhook({
      ...baseInput(connections, "nope", signedRequest(WHSEC_SECRET, "ping", "{}")),
    });
    expect(result.status).toBe(404);
  });

  it("rejects bad signatures with 401", async () => {
    const connections = newConnections();
    const { id } = createConnection(connections);
    const result = await handleGitLabWebhook({
      ...baseInput(connections, id, {
        event: "merge_request",
        rawBody: JSON.stringify(mrPayload()),
        webhookId: "whid-1",
        webhookTimestamp: String(Math.floor(Date.now() / 1000)),
        webhookSignature: "v1,garbage",
      }),
    });
    expect(result.status).toBe(401);
  });

  it("rejects signatures outside the replay window", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const rawBody = JSON.stringify(mrPayload());
    const webhookId = "whid-old";
    const timestamp = String(Math.floor(Date.now() / 1000) - 3600);
    const result = await handleGitLabWebhook({
      ...baseInput(connections, id, {
        event: "merge_request",
        rawBody,
        webhookId,
        webhookTimestamp: timestamp,
        webhookSignature: computeSignature(
          Buffer.from(secret.replace(/^whsec_/, ""), "base64"),
          webhookId,
          timestamp,
          rawBody,
        ),
      }),
    });
    expect(result.status).toBe(401);
    expect(result.body.error).toMatch(/replay window/);
  });

  it("verifies the legacy token path", async () => {
    const connections = newConnections();
    const { id } = createConnection(connections, { webhookSecret: LEGACY_SECRET });
    const ok = await handleGitLabWebhook({
      ...baseInput(connections, id, legacyRequest("ping", "{}")),
    });
    expect(ok.status).toBe(200);
    const bad = await handleGitLabWebhook({
      ...baseInput(connections, id, legacyRequest("ping", "{}", { legacyToken: "wrong" })),
    });
    expect(bad.status).toBe(401);
  });

  it("answers pings", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const result = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "ping", "{}")),
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, event: "ping" });
  });

  it("ignores disabled connections and out-of-scope projects", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    connections.update(id, { enabled: false });
    const disabled = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(mrPayload()))),
    });
    expect(disabled.status).toBe(202);
    expect(disabled.body.reason).toMatch(/disabled/);

    connections.update(id, { enabled: true });
    const outOfScope = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(mrPayload({
        project: { id: 43, path_with_namespace: "other/widgets" },
      })))),
    });
    expect(outOfScope.status).toBe(202);
    expect(outOfScope.body.reason).toMatch(/outside the connection scope/);
  });
});

describe("GitLab merge_request events", () => {
  it("enqueues one review per head SHA and stales older SHAs", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(mrPayload())));
    const first = await handleGitLabWebhook(input);
    expect(first.status).toBe(202);
    expect(first.enqueue?.created).toBe(true);
    expect(first.enqueue?.job.head_sha).toBe("head222");
    expect(first.enqueue?.job.provider).toBe("gitlab");
    expect(first.enqueue?.job.provider_instance).toBe("gitlab.com");
    expect(first.enqueue?.job.forge_connection_id).toBe(id);
    expect(first.enqueue?.job.installation_id).toBe(42);

    // Same head redelivered: duplicate delivery, then a distinct delivery is a no-op enqueue.
    const sameDelivery = await handleGitLabWebhook(input);
    expect(sameDelivery.body.duplicate).toBe(true);

    const push = mrPayload({ object_attributes: { ...mrPayload().object_attributes, action: "update", oldrev: "old1", last_commit: { id: "head333" } } });
    const second = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "merge_request", JSON.stringify(push)),
    });
    expect(second.enqueue?.created).toBe(true);
    expect(second.enqueue?.staleJobIds).toEqual([first.enqueue?.job.id]);
  });

  it("ignores updates that did not change the source revision", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const titleEdit = mrPayload({ object_attributes: { ...mrPayload().object_attributes, action: "update", oldrev: null } });
    const result = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(titleEdit))),
    });
    expect(result.status).toBe(202);
    expect(result.body.reason).toMatch(/did not change the source revision/);
  });

  it("ignores drafts unless REVIEW_DRAFTS is enabled", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const draft = mrPayload({ object_attributes: { ...mrPayload().object_attributes, work_in_progress: true } });
    const result = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(draft))),
    });
    expect(result.body.reason).toMatch(/draft/);
  });

  it("skips merge_request deliveries while the global pause switch is on", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(mrPayload())));
    input.store.setGlobalPause("alice");

    const paused = await handleGitLabWebhook(input);
    expect(paused.body.ignored).toBe(true);
    expect(String(paused.body.reason)).toMatch(/paused globally/);
    expect(input.store.listJobs(10)).toHaveLength(0);

    input.store.endGlobalPause("alice");
    const resumed = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "merge_request", JSON.stringify(mrPayload())),
    });
    expect(resumed.enqueue?.created).toBe(true);
  });

  it("cancels and permanently marks merged merge requests", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(mrPayload())));
    const opened = await handleGitLabWebhook(input);
    expect(opened.enqueue?.created).toBe(true);

    const merged = mrPayload({
      object_attributes: { ...mrPayload().object_attributes, action: "merge", state: "merged", oldrev: null },
    });
    const result = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "merge_request", JSON.stringify(merged)),
    });
    expect(result.status).toBe(200);
    expect(result.body.cancelled).toBe(1);
    expect(input.store.hasMergedPull("acme/widgets", 7, { provider: "gitlab", instance: "gitlab.com" })).toBe(true);

    // The merged gate is permanent: a later open does not enqueue.
    const reopened = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "merge_request", JSON.stringify(mrPayload({ object_attributes: { ...mrPayload().object_attributes, action: "open", last_commit: { id: "head999" } } }))),
    });
    expect(reopened.body.reason).toMatch(/already merged/);
  });

  it("drops bot-authored events before doing any work", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const botId = 4242;
    const row = connections.get(id)!;
    connections.recordProbe(id, { botUserId: botId, botUsername: "maomao-bot" });
    void row;
    const result = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(mrPayload({ user: { id: botId, username: "maomao-bot" } })))),
    });
    expect(result.status).toBe(202);
    expect(result.body.reason).toMatch(/bot/);
  });

  it("applies the per-connection rate limit by project scope", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(mrPayload())));
    input.rateLimiter.recordKey("gitlab:gitlab.com:42", 6, 3_600_000);
    for (let index = 1; index < 6; index += 1) {
      input.rateLimiter.recordKey("gitlab:gitlab.com:42", 6, 3_600_000);
    }
    const result = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "merge_request", JSON.stringify(mrPayload({ object_attributes: { ...mrPayload().object_attributes, iid: 8, last_commit: { id: "head-rate" } } }))),
    });
    expect(result.body.reason).toMatch(/rate limited/);
  });
});

describe("GitLab note events", () => {
  it("dismisses a finding from an authorized maintainer reply and resolves the discussion", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "note", JSON.stringify(notePayload())));
    let capturedResolved: string | undefined;
    input.connections = connections;
    const result = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "note", JSON.stringify(notePayload())),
      gitlabFactory: () => ({
        listDiscussions: async () => discussionPage(maomaoDiscussions()),
        getAccessLevel: async () => 40,
        resolveDiscussion: async (_projectId: number, _iid: number, discussionId: string, nowResolved: boolean) => {
          if (nowResolved) capturedResolved = discussionId;
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("dismissed");
    expect(capturedResolved).toBe("disc-1");
    const finding = input.store.listFindings("acme/widgets", 7, { provider: "gitlab", instance: "gitlab.com" })[0];
    expect(finding?.status).toBe("dismissed");
    expect(finding?.dismissed_by).toBe("maintainer");
  });

  it("refuses unauthorized actors without touching the finding", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "note", JSON.stringify(notePayload())));
    // Seed a finding so the refusal is observable against the same store.
    input.store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: "fp123",
      scope: { provider: "gitlab", instance: "gitlab.com" },
      status: "open",
      reviewedSha: "abc",
      summary: "bug",
    });
    const result = await handleGitLabWebhook({
      ...input,
      gitlabFactory: () => ({
        listDiscussions: async () => discussionPage(maomaoDiscussions()),
        getAccessLevel: async () => 10,
        resolveDiscussion: async () => {},
      }),
    });
    expect(result.status).toBe(202);
    expect(result.body.reason).toMatch(/not authorized/);
    const finding = input.store.listFindings("acme/widgets", 7, { provider: "gitlab", instance: "gitlab.com" })[0];
    expect(finding?.status).toBe("open");
    // The unauthorized outcome is claimed so redeliveries do not retry authz.
    expect(input.store.hasWebhookDelivery(input.request.webhookId!, { provider: "gitlab", instance: "gitlab.com" })).toBe(true);
  });

  it("reopens a finding and unresolves the discussion", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "note", JSON.stringify(notePayload())));
    input.store.upsertFinding({
      repoFullName: "acme/widgets",
      prNumber: 7,
      fingerprint: "fp123",
      scope: { provider: "gitlab", instance: "gitlab.com" },
      status: "dismissed",
      reviewedSha: "abc",
      summary: "bug",
      dismissedBy: "someone",
    });
    const resolutions: Array<{ id: string; resolved: boolean }> = [];
    const result = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "note", JSON.stringify(notePayload({
        object_attributes: { id: 9001, note: "@maomao reopen", noteable_type: "MergeRequest", action: "created" },
      }))),
      gitlabFactory: () => ({
        listDiscussions: async () => discussionPage(maomaoDiscussions()),
        getAccessLevel: async () => 40,
        resolveDiscussion: async (_projectId: number, _iid: number, discussionId: string, resolved: boolean) => {
          resolutions.push({ id: discussionId, resolved });
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("open");
    expect(resolutions).toEqual([{ id: "disc-1", resolved: false }]);
    const finding = input.store.listFindings("acme/widgets", 7, { provider: "gitlab", instance: "gitlab.com" })[0];
    expect(finding?.status).toBe("open");
    expect(finding?.reopened_by).toBe("maintainer");
  });

  it("accepts the seedling reply as a bury", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "note", JSON.stringify(notePayload())));
    const result = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "note", JSON.stringify(notePayload({
        object_attributes: { id: 9001, note: "🌱", noteable_type: "MergeRequest", action: "created" },
      }))),
      gitlabFactory: () => ({
        listDiscussions: async () => discussionPage(maomaoDiscussions()),
        getAccessLevel: async () => 40,
        resolveDiscussion: async () => {},
      }),
    });
    expect(result.body.command).toBe("seedling");
    expect(result.body.status).toBe("dismissed");
  });

  it("ignores non-MR notes and edited notes", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const issueNote = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "note", JSON.stringify(notePayload({
        object_attributes: { id: 1, note: "@maomao bury", noteable_type: "Issue", action: "created" },
        merge_request: undefined,
      })))),
    });
    expect(issueNote.body.reason).toMatch(/not on a merge request/);
    const edited = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "note", JSON.stringify(notePayload({
        object_attributes: { id: 9001, note: "@maomao bury", noteable_type: "MergeRequest", action: "edited" },
      })))),
    });
    expect(edited.body.reason).toMatch(/ignored note action edited/);
  });

  it("answers a truncated discussion listing with an unclaimed warning", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "note", JSON.stringify(notePayload())));
    const result = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "note", JSON.stringify(notePayload())),
      gitlabFactory: () => ({
        listDiscussions: async () => ({ discussions: maomaoDiscussions(), truncated: true }),
        getAccessLevel: async () => 40,
        resolveDiscussion: async () => {},
      }),
    });
    expect(result.status).toBe(200);
    expect(result.body.warning).toMatch(/processing cap/);
    // Unclaimed: a redelivery can try again once the listing fits.
    expect(input.store.hasWebhookDelivery(input.request.webhookId!, { provider: "gitlab", instance: "gitlab.com" })).toBe(false);
  });

  it("never fetches discussions for escalate commands", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(mrPayload())));
    const opened = await handleGitLabWebhook(input);
    expect(opened.enqueue?.created).toBe(true);
    const result = await handleGitLabWebhook({
      ...input,
      request: signedRequest(secret, "note", JSON.stringify(notePayload({
        object_attributes: { id: 9002, note: "@maomao escalate", noteable_type: "MergeRequest", action: "created" },
      }))),
      gitlabFactory: () => ({
        listDiscussions: async () => {
          throw new Error("escalate must not list discussions");
        },
        getAccessLevel: async () => 40,
        resolveDiscussion: async () => {},
      }),
    });
    expect(result.dispatchJobId).toBe(opened.enqueue?.job.id);
  });

  it("drops Maomao marker comments even without a probed bot identity", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const result = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "note", JSON.stringify(notePayload({
        object_attributes: {
          id: 9003,
          note: "<!-- maomao-finding id=abc sha=def -->\n**high**: quoted finding body containing @maomao escalate",
          noteable_type: "MergeRequest",
          action: "created",
        },
      })))),
      gitlabFactory: () => ({
        listDiscussions: async () => {
          throw new Error("must not reach the API for marker comments");
        },
        getAccessLevel: async () => {
          throw new Error("must not reach the API for marker comments");
        },
        resolveDiscussion: async () => {},
      }),
    });
    expect(result.status).toBe(202);
    expect(result.body.reason).toMatch(/marker comment/);
  });

  it("deduplicates unsigned legacy deliveries via the deterministic fallback", async () => {
    const connections = newConnections();
    const { id } = createConnection(connections, { webhookSecret: LEGACY_SECRET });
    const input = baseInput(connections, id, legacyRequest("merge_request", JSON.stringify(mrPayload())));
    const rawBody = JSON.stringify(mrPayload());
    const first = await handleGitLabWebhook({
      ...input,
      request: legacyRequest("merge_request", rawBody),
    });
    expect(first.enqueue?.created).toBe(true);
    const redelivered = await handleGitLabWebhook({
      ...input,
      request: legacyRequest("merge_request", rawBody),
    });
    expect(redelivered.body.duplicate).toBe(true);
  });

  it("ignores notes outside Maomao discussions", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const result = await handleGitLabWebhook({
      ...baseInput(connections, id, signedRequest(secret, "note", JSON.stringify(notePayload()))),
      gitlabFactory: () => ({
        listDiscussions: async () => discussionPage([]),
        getAccessLevel: async () => 40,
        resolveDiscussion: async () => {},
      }),
    });
    expect(result.status).toBe(202);
    expect(result.body.reason).toMatch(/not inside a Maomao finding discussion/);
  });

  it("routes escalate commands to the latest job", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(connections, id, signedRequest(secret, "merge_request", JSON.stringify(mrPayload())));
    const opened = await handleGitLabWebhook(input);
    expect(opened.enqueue?.created).toBe(true);

    const config = loadConfig({
      GITHUB_WEBHOOK_SECRET: "s3cret",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      REVIEWER_ROLES: "correctness",
      MAOMAO_FORGE_KEY: generateForgeKeyHex(),
      POISON_ALERT_ESCALATE_COMMAND: "escalate",
      MAOMAO_MENTION: "maomao",
    });
    const result = await handleGitLabWebhook({
      config,
      store: input.store,
      connections,
      connectionId: id,
      request: signedRequest(secret, "note", JSON.stringify(notePayload({
        object_attributes: {
          id: 9002,
          note: "@maomao escalate",
          noteable_type: "MergeRequest",
          action: "created",
        },
      }))),
      gitlabFactory: () => ({
        listDiscussions: async () => discussionPage([]),
        getAccessLevel: async () => 40,
        resolveDiscussion: async () => {},
      }),
    });
    expect(result.dispatchJobId).toBe(opened.enqueue?.job.id);
    const job = input.store.getJob(result.dispatchJobId!);
    expect(job?.manual_escalate_requested).toBe(1);
  });
});

describe("parseMergeRequestEvent / shouldHandleMergeRequest", () => {
  it("rejects payloads missing the anchoring head SHA", () => {
    const raw = JSON.stringify(mrPayload({ object_attributes: { ...mrPayload().object_attributes, last_commit: {} } }));
    expect(() => parseMergeRequestEvent(raw)).toThrow(/last_commit id/);
  });

  it("treats non-source updates and closes as non-events", () => {
    const config = loadConfig({});
    const update = parseMergeRequestEvent(JSON.stringify(mrPayload({ object_attributes: { ...mrPayload().object_attributes, action: "update", oldrev: null } })));
    expect(shouldHandleMergeRequest(config, update)).toEqual({ handle: false, reason: expect.stringContaining("source revision") });
    const close = parseMergeRequestEvent(JSON.stringify(mrPayload({ object_attributes: { ...mrPayload().object_attributes, action: "close", state: "closed" } })));
    expect(shouldHandleMergeRequest(config, close).handle).toBe(false);
    const merged = parseMergeRequestEvent(JSON.stringify(mrPayload({ object_attributes: { ...mrPayload().object_attributes, action: "merge", state: "merged" } })));
    expect(shouldHandleMergeRequest(config, merged).handle).toBe(false);
  });

  it("accepts source-revision updates", () => {
    const config = loadConfig({});
    const update = parseMergeRequestEvent(JSON.stringify(mrPayload({ object_attributes: { ...mrPayload().object_attributes, action: "update", oldrev: "old1" } })));
    expect(shouldHandleMergeRequest(config, update).handle).toBe(true);
  });
});
describe("withinScope", () => {
  function connection(scopeType: "instance" | "group" | "project", scopePath: string) {
    return {
      row: { scope_type: scopeType, scope_path: scopePath, enabled: 1 },
    } as unknown as Parameters<typeof withinScope>[0];
  }

  it("matches group scopes on exact or slash-boundary prefixes only", () => {
    const group = connection("group", "acme");
    expect(withinScope(group, { path_with_namespace: "acme" })).toBe(true);
    expect(withinScope(group, { path_with_namespace: "acme/widgets" })).toBe(true);
    expect(withinScope(group, { path_with_namespace: "Acme/Widgets" })).toBe(true);
    expect(withinScope(group, { path_with_namespace: "acme-team/widgets" })).toBe(false);
    expect(withinScope(group, { path_with_namespace: "other/acme" })).toBe(false);
    expect(withinScope(group, {})).toBe(false);
  });

  it("instance scopes accept any project; project scopes require exact paths", () => {
    const instance = connection("instance", "");
    expect(withinScope(instance, { path_with_namespace: "anything/at/all" })).toBe(true);
    const project = connection("project", "acme/widgets");
    expect(withinScope(project, { path_with_namespace: "acme/widgets" })).toBe(true);
    expect(withinScope(project, { path_with_namespace: "acme/other" })).toBe(false);
  });
});

describe("accessLevelToPermission / decodeSigningSecret / toForgeDiscussions", () => {
  it("maps GitLab access levels onto the neutral vocabulary", () => {
    expect(accessLevelToPermission(undefined)).toBe("none");
    expect(accessLevelToPermission(0)).toBe("none");
    expect(accessLevelToPermission(10)).toBe("read");
    expect(accessLevelToPermission(20)).toBe("triage");
    expect(accessLevelToPermission(30)).toBe("write");
    expect(accessLevelToPermission(40)).toBe("maintain");
    expect(accessLevelToPermission(49)).toBe("maintain");
    expect(accessLevelToPermission(50)).toBe("admin");
  });

  it("decodes only well-formed whsec_ signing secrets", () => {
    const secret = `whsec_${Buffer.from("sixteen-byte-key").toString("base64")}`;
    expect(decodeSigningSecret(secret)?.toString()).toBe("sixteen-byte-key");
    expect(decodeSigningSecret("whsec_")).toBeUndefined();
    expect(decodeSigningSecret("plain-legacy-token")).toBeUndefined();
  });

  it("maps GitLab discussions onto the neutral shape", () => {
    const mapped = toForgeDiscussions(maomaoDiscussions());
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.id).toBe("disc-1");
    expect(mapped[0]?.isResolved).toBe(false);
    expect(mapped[0]?.comments[0]?.databaseId).toBe(8000);
    expect(mapped[0]?.comments[0]?.authorLogin).toBe("maomao-bot");
    const resolved = toForgeDiscussions([
      { id: "d2", notes: [{ id: 1, body: "x", author: {}, resolvable: true, resolved: true }] },
    ]);
    expect(resolved[0]?.isResolved).toBe(true);
  });
});

describe("GitLab delivery log", () => {
  it("records ignored note actions with reason and payload context", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(
      connections,
      id,
      signedRequest(
        secret,
        "note",
        JSON.stringify(
          notePayload({
            object_attributes: { id: 9001, note: "@maomao bury", noteable_type: "MergeRequest", action: "edited" },
          }),
        ),
      ),
    );
    const result = await handleGitLabWebhook(input);
    expect(result.body.ignored).toBe(true);

    const row = input.store
      .listWebhookDeliveries({ limit: 10 })
      .find((entry) => entry.delivery_id === input.request.webhookId);
    expect(row?.provider).toBe("gitlab");
    expect(row?.provider_instance).toBe("gitlab.com");
    expect(row?.result).toBe("ignored: ignored note action edited");
    expect(row?.repo_full_name).toBe("acme/widgets");
    expect(row?.action).toBe("edited");
    expect(row?.actor).toBe("maintainer");
  });

  it("records deliveries ignored before dispatch (unsupported object kinds)", async () => {
    const connections = newConnections();
    const { id, secret } = createConnection(connections);
    const input = baseInput(
      connections,
      id,
      signedRequest(
        secret,
        "issue",
        JSON.stringify({ object_kind: "issue", project: { path_with_namespace: "acme/widgets" }, user: { username: "maintainer" } }),
      ),
    );
    const result = await handleGitLabWebhook(input);
    expect(result.body.ignored).toBe(true);

    const row = input.store
      .listWebhookDeliveries({ limit: 10 })
      .find((entry) => entry.delivery_id === input.request.webhookId);
    expect(row?.result).toBe("ignored: event issue");
    expect(row?.repo_full_name).toBe("acme/widgets");
    expect(row?.actor).toBe("maintainer");
  });

  it("does not record failed verifications", async () => {
    const connections = newConnections();
    const { id } = createConnection(connections);
    const input = baseInput(connections, id, {
      event: "merge_request",
      rawBody: JSON.stringify(mrPayload()),
      webhookId: "whid-bad",
      webhookTimestamp: String(Math.floor(Date.now() / 1000)),
      webhookSignature: "v1,garbage",
    });
    const result = await handleGitLabWebhook(input);
    expect(result.status).toBe(401);
    expect(input.store.listWebhookDeliveries({})).toHaveLength(0);
  });
});
