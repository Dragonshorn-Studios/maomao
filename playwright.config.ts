import { defineConfig } from "@playwright/test";

/**
 * Playwright configuration for Maomao's dev-only UI workbench.
 *
 * The workbench is a standalone server (`npm run ui:dev`) that needs no
 * credentials, no database, no GitHub and no OpenCode — it renders the real
 * production markup from deterministic fixtures. The first boot is slow
 * because the script builds the React chat bundle first, hence the generous
 * web server timeout.
 *
 * Two projects run the same suite at the two viewport presets the catalog
 * publishes: `desktop` (1440x900) and `mobile` (390x844). Screenshots are
 * artifacts only — there are no pixel or snapshot comparisons.
 */

/**
 * The suite uses its own port so it never collides with a workbench the
 * developer has open in another terminal. A port whose listener just closed
 * can refuse connections for a while on some hosts, and the suite must not
 * wait on a stale socket.
 */
const PORT = process.env.MAOMAO_UI_WORKBENCH_PORT ?? "4311";
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 1,
  reporter: "list",
  // The server is started here rather than through `webServer`: Playwright
  // probes the URL before it starts anything, and probing a port that has no
  // listener can wait for a TCP timeout on some hosts. The setup binds first
  // and waits for the server's own readiness line.
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
  ],
});
