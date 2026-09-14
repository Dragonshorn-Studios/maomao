import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { assertRuntimeConfig, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { JobStore } from "./jobs/store.js";
import { JobQueue } from "./jobs/queue.js";
import { createPipeline } from "./jobs/pipeline.js";
import { createApp } from "./server.js";
import { GithubClient } from "./github/client.js";
import { createCheckout, sweepWorkspaces } from "./checkout.js";
import { createOpenCodeRunner } from "./opencode/spawn.js";

const config = loadConfig();
assertRuntimeConfig(config);
mkdirSync(config.workspaceRoot, { recursive: true });
void sweepWorkspaces(config.workspaceRoot, config.workspaceRetentionHours).then((removed) => {
  if (removed > 0) console.log(`Removed ${removed} expired workspace(s)`);
});

const db = openDb(config.databasePath);
const store = new JobStore(db);
const github = new GithubClient(config);
const pipeline = createPipeline({
  config,
  store,
  github,
  checkout: createCheckout(config.workspaceRoot),
  opencode: createOpenCodeRunner(config.opencode.bin),
});
const queue = new JobQueue(store, config.jobConcurrency, (jobId) => pipeline.run(jobId));
queue.start();

const app = createApp({ config, store, queue, startedAt: Date.now() });

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Maomao listening on http://${info.address}:${info.port}`);
  console.log(`Webhook: POST /webhooks/github`);
  if (!config.uiPassword || !config.uiSessionSecret) {
    console.warn(
      "UI_PASSWORD and UI_SESSION_SECRET are unset; / , /jobs, /api, and /events are open. Set both before exposing Maomao.",
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
