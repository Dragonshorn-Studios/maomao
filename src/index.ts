import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { JobStore } from "./jobs/store.js";
import { JobQueue } from "./jobs/queue.js";
import { createPipeline } from "./jobs/pipeline.js";
import { createApp } from "./server.js";
import { GithubClient } from "./github/client.js";
import { chatWorkspaceRoot, createCheckout, sweepWorkspaces } from "./checkout.js";
import { createOpenCodeRunner } from "./opencode/spawn.js";
import { ModelDiscovery } from "./opencode/models.js";
import { ChatService } from "./chat/service.js";
import { ChatStore } from "./chat/store.js";
import { oauthCallbackUrl, oauthEnabled } from "./oauth.js";
import { ForgeConnectionStore, countConnections } from "./forge/connections.js";
import { ensureEnvGitLabConnection } from "./forge/bootstrap.js";
import { ForgeRegistry } from "./forge/registry.js";

const config = loadConfig();
mkdirSync(config.workspaceRoot, { recursive: true });
void sweepWorkspaces(config.workspaceRoot, config.workspaceRetentionHours).then((removed) => {
  if (removed > 0) console.log(`Removed ${removed} expired workspace(s)`);
});

const db = openDb(config.databasePath);
const forgeConnections = config.forgeKey
  ? new ForgeConnectionStore(db, config.forgeKey)
  : undefined;
// Persisted connections must exist before boot validation so a GitLab-only
// deployment can boot without GitHub credentials.
let bootstrapped: ReturnType<typeof ensureEnvGitLabConnection>;
if (forgeConnections) {
  bootstrapped = ensureEnvGitLabConnection(forgeConnections, config);
  if (bootstrapped?.created) {
    console.log(`Seeded GitLab connection from environment: ${bootstrapped.id}`);
  } else if (bootstrapped?.updated) {
    console.log(`Rotated GitLab connection from environment: ${bootstrapped.id}`);
  }
}
// Counted without the key so a connection present but unopenable still
// produces the right diagnosis (MAOMAO_FORGE_KEY missing), never a GitHub one.
assertRuntimeConfig(config, {
  gitlabConnections: countConnections(db, "gitlab"),
  gitlabBootstrap: Boolean(config.gitlabBootstrap),
});
const store = new JobStore(db, config.modelCatalog);
// A crash mid-creation can leave pending scan-issue claims (issue_number 0);
// no loop is in flight at boot, so anything left over is orphaned.
const orphanedClaims = store.clearOrphanedScanIssueClaims();
if (orphanedClaims > 0) {
  console.log(`Cleared ${orphanedClaims} orphaned scan-issue claim(s) from a previous run`);
}
const github = new GithubClient(config);
const opencode = createOpenCodeRunner(config.opencode.bin);
// Discover the model list once at boot so the profile editor's datalist is
// populated before the first visit; operators can re-run it from the UI.
const modelDiscovery = new ModelDiscovery(config.opencode.bin);
void modelDiscovery.refresh().then((snap) => {
  if (snap.error) {
    console.warn(`Model discovery failed (${snap.error}); the profile editor falls back to MODEL_CATALOG.`);
  } else {
    console.log(`Discovered ${snap.models.length} model(s) via opencode models`);
  }
});
const getInstallationToken = (installationId: number) => github.getInstallationToken(installationId);
const forge = new ForgeRegistry(github, config.github.appSlug, getInstallationToken, forgeConnections);
const pipeline = createPipeline({
  config,
  store,
  github,
  forge,
  connections: forgeConnections,
  checkout: createCheckout(config.workspaceRoot),
  opencode,
  getInstallationToken,
});
const queue = new JobQueue(store, config.jobConcurrency, (jobId) => pipeline.run(jobId));
queue.start();

const chatStore = config.chat.enabled ? new ChatStore(db) : undefined;
const chat = chatStore
  ? {
      store: chatStore,
      service: new ChatService({
        config,
        chatStore,
        jobStore: store,
        forge,
        checkout: createCheckout(chatWorkspaceRoot(config.workspaceRoot)),
        opencode,
      }),
    }
  : undefined;

const app = createApp({
  config,
  store,
  queue,
  github,
  opencode,
  forgeConnections,
  chat,
  modelDiscovery,
  startedAt: Date.now(),
  env: process.env,
});

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Maomao listening on http://${info.address}:${info.port}`);
  console.log(`Webhook: POST /webhooks/github`);
  if (oauthEnabled(config)) {
    console.log(`OAuth operator login enabled; callback URL: ${oauthCallbackUrl(config)}`);
  }
  const passwordOn = Boolean(config.uiPassword && config.uiSessionSecret);
  if (!oauthEnabled(config) && !passwordOn) {
    console.warn(
      "No operator login is configured (OAuth or UI_PASSWORD + UI_SESSION_SECRET); / , /jobs, /api, and /events are open. Configure one before exposing Maomao.",
    );
  }
  if (config.allowedGithubAccountIds.length === 0 && config.allowedGithubRepositoryIds.length === 0) {
    console.warn(
      "ALLOWED_GITHUB_ACCOUNT_IDS and ALLOWED_GITHUB_REPOSITORY_IDS are empty; any reachable GitHub App installation can enqueue reviews. Set numeric account and/or repository IDs before exposing Maomao.",
    );
  }
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, exiting`);
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
