import { serve } from "@hono/node-server";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import type { JobQueue } from "../jobs/queue.js";
import { createApp } from "../server.js";
import { seedDemoJobs } from "./fixtures.js";

/**
 * UI-only preview with fixture jobs. Does not run the review pipeline.
 *
 *   npm run demo
 *   MAOMAO_DEMO_EMPTY=1 npm run demo   # empty queue
 */
const openUi = process.env.MAOMAO_DEMO_OPEN === "1";
const config = loadConfig({
  GITHUB_APP_ID: process.env.GITHUB_APP_ID || "1",
  GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY || "demo-key",
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || "demo-webhook",
  UI_PASSWORD: openUi ? "" : process.env.UI_PASSWORD || "demo",
  UI_SESSION_SECRET: openUi ? "" : process.env.UI_SESSION_SECRET || "demo-session-secret-not-for-production",
  HOST: process.env.HOST || "127.0.0.1",
  PORT: process.env.PORT || "3000",
  DATABASE_PATH: process.env.DATABASE_PATH || ":memory:",
});

const db = openDb(config.databasePath);
const store = new JobStore(db);
if (process.env.MAOMAO_DEMO_EMPTY !== "1") {
  seedDemoJobs(store);
}

const queue = {
  enqueue() {},
  abort() {},
  abortMany() {},
  start() {},
} as unknown as JobQueue;

const app = createApp({ config, store, queue, startedAt: Date.now() });

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`Maomao demo UI on http://${info.address}:${info.port}`);
  console.log(`Password: ${config.uiPassword ? "(set via UI_PASSWORD, default demo)" : "open"}`);
  if (process.env.MAOMAO_DEMO_EMPTY === "1") {
    console.log("Empty queue fixture");
  } else {
    console.log(`Seeded ${store.listJobs(50).length} demo jobs`);
  }
});
