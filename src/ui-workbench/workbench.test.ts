import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { openDb } from "../db.js";
import { JobStore } from "../jobs/store.js";
import type { JobQueue } from "../jobs/queue.js";
import { createApp } from "../server.js";
import { FAVICON_PNG_BASE64 } from "../ui/icons.js";
import { catalogSchema, SLUG_PATTERN, VIEWPORTS } from "./contract.js";
import { isLoopback, normalizeAddress, workbenchAvailable } from "./gate.js";
import { createWorkbenchApp } from "./app.js";
import { mountWorkbench } from "./mount.js";
import { WorkbenchRegistry, resolveViewport } from "./registry.js";
import { FRAME_SANDBOX_JS, frameUrl, storyUrl } from "./render.js";
import { designTokens } from "./tokens.js";
import { runValidation } from "./validate.js";
import { STORIES } from "./stories.js";
import type { WorkbenchStory } from "./contract.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The workbench without the gate, for rendering and catalog assertions. */
function openWorkbench(): Hono {
  const app = new Hono();
  app.route("/dev/ui", createWorkbenchApp());
  return app;
}

/** The workbench behind the gate, with an injectable peer address. */
function gatedWorkbench(options: {
  enabled?: boolean;
  production?: boolean;
  peer?: string;
}): Hono {
  const app = new Hono();
  mountWorkbench(app, {
    enabled: options.enabled ?? true,
    production: options.production ?? false,
    peerAddress: () => options.peer ?? "127.0.0.1",
  });
  return app;
}

/** The production server, so the workbench gate can be checked in place. */
function productionApp(env: Record<string, string>, peerAddress?: (c: unknown) => string | undefined) {
  const config = loadConfig({
    GITHUB_WEBHOOK_SECRET: "s3cret",
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "k",
    REVIEWER_ROLES: "correctness",
    ...env,
  });
  const store = new JobStore(openDb(":memory:"));
  const queue = { enqueue() {}, abortMany() {} } as unknown as JobQueue;
  return createApp({
    config,
    store,
    queue,
    startedAt: Date.now(),
    env: { ...env },
    workbenchPeerAddress: peerAddress as never,
  });
}

describe("story registry", () => {
  const registry = new WorkbenchRegistry(STORIES);

  it("registers Maomao's stories without problems", () => {
    expect(registry.problems()).toEqual([]);
    expect(registry.all().length).toBeGreaterThanOrEqual(6);
  });

  it("uses lowercase slug ids for stories and variants", () => {
    for (const story of registry.all()) {
      expect(story.id).toMatch(SLUG_PATTERN);
      for (const variant of story.variants) {
        expect(variant.id).toMatch(SLUG_PATTERN);
      }
    }
  });

  it("only resolves registered ids", () => {
    expect(registry.find("job-card")?.title).toBe("Job / status card");
    expect(registry.find("not-a-story")).toBeUndefined();
    expect(registry.find("../../etc/passwd")).toBeUndefined();
  });

  it("falls back to the first variant and rejects unknown ones", () => {
    const story = registry.find("job-card");
    expect(story).toBeDefined();
    if (!story) return;
    expect(registry.variant(story, undefined)?.id).toBe(story.variants[0].id);
    expect(registry.variant(story, "failed")?.id).toBe("failed");
    expect(registry.variant(story, "nope")).toBeUndefined();
  });

  it("reports duplicate ids, malformed slugs, and empty variant sets", () => {
    const broken: WorkbenchStory = {
      id: "Bad Id",
      title: "",
      category: "",
      family: "ssr",
      variants: [],
      sourceFiles: [],
      defaultViewport: "desktop",
      preview: () => "",
    };
    const problems = new WorkbenchRegistry([broken, broken]).problems();
    expect(problems.some((problem) => problem.includes("Duplicate story id"))).toBe(true);
    expect(problems.some((problem) => problem.includes("lowercase slug"))).toBe(true);
    expect(problems.some((problem) => problem.includes("no title"))).toBe(true);
    expect(problems.some((problem) => problem.includes("no category"))).toBe(true);
    expect(problems.some((problem) => problem.includes("no variants"))).toBe(true);
  });

  it("reports source files that do not resolve inside the repository", () => {
    const missing: WorkbenchStory = {
      id: "missing-source",
      title: "Missing source",
      category: "Jobs",
      family: "ssr",
      variants: [{ id: "one", title: "One" }],
      sourceFiles: ["src/does-not-exist.ts"],
      defaultViewport: "desktop",
      preview: () => "<p>x</p>",
    };
    const escaping: WorkbenchStory = {
      ...missing,
      id: "escaping-source",
      sourceFiles: ["../../etc/passwd"],
    };
    const problems = new WorkbenchRegistry([missing, escaping]).problems();
    expect(problems.some((problem) => problem.includes("missing file"))).toBe(true);
    expect(problems.some((problem) => problem.includes("outside the repository"))).toBe(true);
  });

  it("points every story at files that exist", () => {
    for (const story of registry.all()) {
      expect(story.sourceFiles.length).toBeGreaterThan(0);
    }
  });
});

describe("catalog", () => {
  it("matches the published schema", async () => {
    const response = await openWorkbench().request("/dev/ui/catalog.json");
    expect(response.status).toBe(200);
    const catalog = await response.json();
    const parsed = catalogSchema.safeParse(catalog);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.generatedBy).toBe("maomao-ui-workbench");
    expect(parsed.data.viewports).toEqual({
      mobile: { width: 390, height: 844 },
      tablet: { width: 834, height: 1112 },
      desktop: { width: 1440, height: 900 },
    });
    expect(parsed.data.stories.length).toBe(STORIES.length);
  });

  it("uses the Sumomo-compatible url shape", async () => {
    const response = await openWorkbench().request("/dev/ui/catalog.json");
    const catalog = catalogSchema.parse(await response.json());
    for (const story of catalog.stories) {
      for (const variant of story.variants) {
        expect(variant.url).toBe(`/dev/ui/${story.id}/${variant.id}`);
        expect(variant.frameUrl).toBe(`/dev/ui/${story.id}/${variant.id}/frame`);
      }
    }
  });

  it("is stable across requests", async () => {
    const app = openWorkbench();
    const first = await (await app.request("/dev/ui/catalog.json")).text();
    const second = await (await app.request("/dev/ui/catalog.json")).text();
    expect(first).toBe(second);
  });

  it("opens every catalog url", async () => {
    const app = openWorkbench();
    const catalog = catalogSchema.parse(await (await app.request("/dev/ui/catalog.json")).json());
    for (const story of catalog.stories) {
      for (const variant of story.variants) {
        expect((await app.request(variant.url)).status).toBe(200);
        expect((await app.request(variant.frameUrl)).status).toBe(200);
      }
    }
  });

  it("keeps the viewport presets in the catalog", () => {
    expect(Object.keys(VIEWPORTS)).toEqual(["mobile", "tablet", "desktop"]);
  });
});

describe("gating", () => {
  const paths = ["/dev/ui", "/dev/ui/catalog.json", "/dev/ui/job-card/completed/frame"];

  it("answers 404 when the flag is off", async () => {
    const app = gatedWorkbench({ enabled: false });
    for (const path of paths) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  it("answers 404 in production even when the flag is on", async () => {
    const app = gatedWorkbench({ enabled: true, production: true });
    for (const path of paths) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  it("answers 404 for a peer outside the loopback interface", async () => {
    const app = gatedWorkbench({ enabled: true, peer: "203.0.113.7" });
    for (const path of paths) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  it("answers 404 when the peer address is unknown", async () => {
    const app = gatedWorkbench({ enabled: true, peer: "" });
    expect((await app.request("/dev/ui")).status).toBe(404);
  });

  it("serves the workbench for a loopback peer when the flag is on", async () => {
    const app = gatedWorkbench({ enabled: true });
    expect((await app.request("/dev/ui")).status).toBe(200);
    expect((await app.request("/dev/ui/catalog.json")).status).toBe(200);
    expect((await app.request("/dev/ui/job-card/completed/frame")).status).toBe(200);
  });

  it("is fail-closed in the production server", async () => {
    const off = productionApp({});
    expect((await off.request("/dev/ui")).status).toBe(404);
    expect((await off.request("/dev/ui/catalog.json")).status).toBe(404);

    const on = productionApp({ MAOMAO_UI_WORKBENCH_ENABLED: "1" }, () => "127.0.0.1");
    expect((await on.request("/dev/ui")).status).toBe(200);

    const production = productionApp(
      { MAOMAO_UI_WORKBENCH_ENABLED: "1", NODE_ENV: "production" },
      () => "127.0.0.1",
    );
    expect((await production.request("/dev/ui")).status).toBe(404);
  });

  it("leaves the rest of the production server untouched", async () => {
    const app = productionApp({});
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/")).status).toBe(200);
  });
});

describe("gate rules", () => {
  it("accepts loopback addresses in their usual spellings", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.1.2.3")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("203.0.113.7")).toBe(false);
    expect(normalizeAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
  });

  it("rejects an inherited property name as a viewport", () => {
    expect(resolveViewport("toString", "mobile")).toEqual({
      name: "mobile",
      width: 390,
      height: 844,
    });
    expect(resolveViewport("constructor", "desktop").name).toBe("desktop");
    expect(resolveViewport(undefined, "tablet").name).toBe("tablet");
    expect(resolveViewport("mobile", "desktop").name).toBe("mobile");
  });

  it("requires every condition", () => {
    expect(workbenchAvailable({ enabled: true, production: false, remoteAddr: "127.0.0.1" })).toBe(true);
    expect(workbenchAvailable({ enabled: false, production: false, remoteAddr: "127.0.0.1" })).toBe(false);
    expect(workbenchAvailable({ enabled: true, production: true, remoteAddr: "127.0.0.1" })).toBe(false);
    expect(workbenchAvailable({ enabled: true, production: false, remoteAddr: undefined })).toBe(false);
    expect(
      workbenchAvailable({ enabled: true, production: false, remoteAddr: "10.0.0.5", allowedIps: ["10.0.0.5"] }),
    ).toBe(true);
  });
});

describe("fake I/O", () => {
  it("blocks every network call except the workbench's own endpoint", async () => {
    const response = await openWorkbench().request("/dev/ui/chat/conversation/frame");
    const html = await response.text();
    expect(html).toContain("network access is blocked");
    expect(html).toContain("/dev/ui/fake/chat/stream");
  });

  it("points the chat island at the fake endpoint instead of a model route", async () => {
    const response = await openWorkbench().request("/dev/ui/chat/conversation/frame");
    const html = await response.text();
    expect(html).toContain('"streamUrl":"/dev/ui/fake/chat/stream"');
    expect(html).not.toContain('"streamUrl":"/jobs/');
  });

  it("answers the fake chat endpoint with a deterministic event stream", async () => {
    const app = openWorkbench();
    const first = await app.request("/dev/ui/fake/chat/stream", { method: "POST", body: "question=hi" });
    const second = await app.request("/dev/ui/fake/chat/stream", { method: "POST", body: "question=hi" });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");
    const firstBody = await first.text();
    const secondBody = await second.text();
    expect(firstBody).toBe(secondBody);
    expect(firstBody).toContain('"done":true');
  });

  it("never points a story at a github or model endpoint", () => {
    for (const story of STORIES) {
      for (const variant of story.variants) {
        const fragment = story.preview(variant);
        expect(fragment).not.toContain("api.github.com");
        expect(fragment).not.toContain("api.openai.com");
        expect(fragment).not.toContain("api.anthropic.com");
      }
    }
  });
});

describe("rendering", () => {
  const app = openWorkbench();

  it("renders every variant with production markup", async () => {
    for (const story of STORIES) {
      for (const variant of story.variants) {
        const response = await app.request(frameUrl(story.id, variant.id));
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(`data-workbench-story="${story.id}"`);
        expect(html).toContain(`data-workbench-variant="${variant.id}"`);
        expect(html).toContain('<main id="main">');
        expect(html).not.toContain("<main id=\"main\"></main>");
      }
    }
  });

  it("shows the real job card with its state", async () => {
    const html = await (await app.request("/dev/ui/job-card/completed/frame")).text();
    expect(html).toContain("Harden session cookie flags on /api");
    expect(html).toContain("state-completed");
    expect(html).toContain('class="queue"');
  });

  it("shows the live and failed job states", async () => {
    const live = await (await app.request("/dev/ui/job-card/reviewing/frame")).text();
    expect(live).toContain("state-reviewing");
    const failed = await (await app.request("/dev/ui/job-card/failed/frame")).text();
    expect(failed).toContain("state-failed");
  });

  it("shows findings on the job detail page", async () => {
    const html = await (await app.request("/dev/ui/job-detail/completed-with-findings/frame")).text();
    expect(html).toContain("Session cookie is written without the Secure flag");
    expect(html).toContain("sev-high");
  });

  it("shows the reviewer board rows", async () => {
    const html = await (await app.request("/dev/ui/reviewer-board/mixed/frame")).text();
    expect(html).toContain("run-board");
    expect(html).toContain("correctness");
    const empty = await (await app.request("/dev/ui/reviewer-board/empty/frame")).text();
    expect(empty).toContain("No reviewer runs");
  });

  it("shows the configuration form and its field errors", async () => {
    const valid = await (await app.request("/dev/ui/config-form/valid/frame")).text();
    expect(valid).toContain("workbench-profile");
    expect(valid).not.toContain("Pick a model from the catalog.");
    const invalid = await (await app.request("/dev/ui/config-form/invalid/frame")).text();
    expect(invalid).toContain("Pick a model from the catalog.");
    expect(invalid).toContain('aria-invalid="true"');
  });

  it("shows the empty and error states", async () => {
    const empty = await (await app.request("/dev/ui/empty-state/empty-queue/frame")).text();
    expect(empty).toContain("empty");
    const error = await (await app.request("/dev/ui/empty-state/error-notice/frame")).text();
    expect(error).toContain("Could not load the job list");
  });

  it("mounts the chat island", async () => {
    const html = await (await app.request("/dev/ui/chat/empty/frame")).text();
    expect(html).toContain('id="maomao-chat-root"');
    expect(html).toContain('src="/assets/chat.js"');
  });

  it("freezes animations when asked", async () => {
    const frozen = await (await app.request("/dev/ui/job-card/completed/frame?frozen=1")).text();
    expect(frozen).toContain("data-workbench-frozen");
    expect(frozen).toContain("animation-play-state: paused");
    const live = await (await app.request("/dev/ui/job-card/completed/frame")).text();
    expect(live).not.toContain("animation-play-state: paused");
  });

  it("falls back to the default for an unknown viewport", async () => {
    const response = await app.request("/dev/ui/job-card/completed/frame?viewport=toString");
    const html = await response.text();
    expect(html).toContain('data-workbench-viewport="desktop"');
    expect(html).not.toContain('width="undefined"');
  });

  it("honours the viewport and theme parameters", async () => {
    const html = await (await app.request("/dev/ui/job-card/completed/frame?viewport=mobile&theme=dark")).text();
    expect(html).toContain('data-workbench-viewport="mobile"');
    expect(html).toContain('data-theme="dark"');
  });

  it("serves the gallery and the story chrome", async () => {
    const gallery = await (await app.request("/dev/ui")).text();
    expect(gallery).toContain("Maomao UI workbench");
    expect(gallery).toContain("job-card");
    expect(gallery).toContain("workbench-search");

    const story = await (await app.request("/dev/ui/job-card")).text();
    expect(story).toContain("iframe");
    expect(story).toContain("/dev/ui/job-card/completed/frame");
  });

  it("answers 404 for unknown stories and variants", async () => {
    expect((await app.request("/dev/ui/nope")).status).toBe(404);
    expect((await app.request("/dev/ui/job-card/nope")).status).toBe(404);
    expect((await app.request("/dev/ui/job-card/nope/frame")).status).toBe(404);
  });

  it("builds the documented urls", () => {
    expect(storyUrl("job-card")).toBe("/dev/ui/job-card");
    expect(storyUrl("job-card", "failed")).toBe("/dev/ui/job-card/failed");
    expect(frameUrl("job-card", "failed")).toBe("/dev/ui/job-card/failed/frame");
  });
});

describe("design tokens", () => {
  const tokens = designTokens();

  it("reads both token sets from the theme", () => {
    const paper = tokens.groups
      .find((group) => group.title === "Colors")
      ?.tokens.find((token) => token.name === "paper");
    expect(paper).toBeDefined();
    expect(paper?.light).toBe("#f3efe3");
    expect(paper?.dark).toBe("#121612");
  });

  it("resolves var() aliases to the value of the theme they sit in", () => {
    const thought = tokens.groups
      .find((group) => group.title === "Colors")
      ?.tokens.find((token) => token.name === "chat-thought");
    expect(thought?.light).toBe("var(--plum)");
    expect(thought?.resolvedLight).toBe("#6b3a58");
    expect(thought?.resolvedDark).toBe("#d4a8c2");
  });

  it("keeps a token that the dark set does not redeclare", () => {
    const radius = tokens.groups
      .find((group) => group.title === "Spacing & sizing")
      ?.tokens.find((token) => token.name === "radius");
    expect(radius?.light).toBe("3px");
    expect(radius?.dark).toBe("3px");
  });

  it("groups colors, typography, spacing, and the rest", () => {
    expect(tokens.groups.map((group) => group.title)).toEqual([
      "Colors",
      "Typography",
      "Spacing & sizing",
      "Effects & other",
    ]);
    const fonts = tokens.groups.find((group) => group.title === "Typography");
    expect(fonts?.tokens.map((token) => token.name).sort()).toEqual([
      "font-display",
      "font-mono",
      "font-ui",
    ]);
  });

  it("parses deterministically", () => {
    expect(JSON.stringify(designTokens())).toBe(JSON.stringify(designTokens()));
  });

  it("renders the tokens page with a swatch per theme", async () => {
    const response = await openWorkbench().request("/dev/ui/tokens");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Design tokens");
    expect(html).toContain("--paper");
    expect(html).toContain("workbench-token-light");
    expect(html).toContain("workbench-token-dark");
    expect(html).toContain("--paper: #f3efe3;");
    expect(html).toContain("--paper: #121612;");
  });

  it("themes the tokens page", async () => {
    const light = await (await openWorkbench().request("/dev/ui/tokens")).text();
    expect(light).toContain('data-theme="light"');
    const dark = await (await openWorkbench().request("/dev/ui/tokens?theme=dark")).text();
    expect(dark).toContain('data-theme="dark"');
  });

  it("links the tokens page from the gallery", async () => {
    const html = await (await openWorkbench().request("/dev/ui")).text();
    expect(html).toContain("/dev/ui/tokens");
  });
});

describe("composition", () => {
  const registry = new WorkbenchRegistry(STORIES);

  it("declares edges that point at registered stories", () => {
    const ids = new Set(registry.all().map((story) => story.id));
    for (const story of registry.all()) {
      for (const used of story.uses ?? []) {
        expect(ids.has(used)).toBe(true);
      }
    }
  });

  it("keeps uses and used-by inverse to each other", () => {
    for (const story of registry.all()) {
      for (const used of registry.uses(story)) {
        expect(registry.usedBy(used).map((candidate) => candidate.id)).toContain(story.id);
      }
    }
  });

  it("publishes the edges in the catalog", async () => {
    const catalog = catalogSchema.parse(await (await openWorkbench().request("/dev/ui/catalog.json")).json());
    for (const story of catalog.stories) {
      expect(story.uses).toEqual(STORIES.find((candidate) => candidate.id === story.id)?.uses ?? []);
    }
  });

  it("shows the edges on the story page", async () => {
    const story = registry.all().find((candidate) => (candidate.uses ?? []).length > 0);
    expect(story).toBeDefined();
    if (!story) return;

    const html = await (await openWorkbench().request(storyUrl(story.id))).text();
    expect(html).toContain("Uses");
    const used = registry.uses(story)[0];
    expect(html).toContain(used.title);
  });

  it("reports a dangling edge and a self-reference", () => {
    const dangling: WorkbenchStory = {
      id: "dangling",
      title: "Dangling",
      category: "Jobs",
      family: "ssr",
      variants: [{ id: "one", title: "One" }],
      sourceFiles: [],
      defaultViewport: "desktop",
      uses: ["not-a-story"],
      preview: () => "<p>x</p>",
    };
    const selfReferencing: WorkbenchStory = { ...dangling, id: "self", uses: ["self"] };
    const problems = new WorkbenchRegistry([dangling, selfReferencing]).problems();
    expect(problems.some((problem) => problem.includes("composes unknown story"))).toBe(true);
    expect(problems.some((problem) => problem.includes("cannot compose itself"))).toBe(true);
  });
});

describe("the frame sandbox", () => {
  /**
   * Runs the shipped sandbox script against a minimal DOM.
   *
   * The script is what makes "previews never touch the network" true, so it
   * is executed here rather than only matched as a substring of the frame.
   */
  function runSandbox() {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const captures = new Map<string, boolean>();
    const calls: string[] = [];

    const windowStub = {
      fetch: (url: string) => {
        calls.push(url);
        return Promise.resolve("original");
      },
    };

    const documentStub = {
      addEventListener(type: string, handler: (event: unknown) => void, capture?: boolean) {
        const bucket = listeners.get(type) ?? [];
        bucket.push(handler);
        listeners.set(type, bucket);
        captures.set(type, capture === true);
      },
    };

    new Function("window", "document", FRAME_SANDBOX_JS)(windowStub, documentStub);

    return {
      window: windowStub,
      calls,
      capture: (type: string) => captures.get(type),
      dispatch(type: string, event: unknown) {
        for (const handler of listeners.get(type) ?? []) handler(event);
      },
    };
  }

  it("lets the fake endpoint through and rejects every other request", async () => {
    const sandbox = runSandbox();
    expect(sandbox.calls).toEqual([]);

    await expect(sandbox.window.fetch("/dev/ui/fake/chat/stream")).resolves.toBe("original");
    expect(sandbox.calls).toEqual(["/dev/ui/fake/chat/stream"]);

    await expect(sandbox.window.fetch("/api/jobs")).rejects.toThrow(/network access is blocked/);
    await expect(sandbox.window.fetch("https://api.github.com/repos")).rejects.toThrow(
      /network access is blocked/,
    );
    expect(sandbox.calls).toEqual(["/dev/ui/fake/chat/stream"]);
  });

  it("blocks form submissions before any handler runs", () => {
    const sandbox = runSandbox();
    expect(sandbox.capture("submit")).toBe(true);

    let prevented = false;
    sandbox.dispatch("submit", {
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });

  it("blocks navigation away from the preview", () => {
    const sandbox = runSandbox();

    const anchor = { getAttribute: (name: string) => (name === "href" ? "/jobs/412" : null) };
    let prevented = false;
    sandbox.dispatch("click", {
      target: { closest: (selector: string) => (selector === "a" ? anchor : null) },
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);

    // A fragment link stays inside the frame and is left alone.
    let fragmentPrevented = false;
    sandbox.dispatch("click", {
      target: {
        closest: (selector: string) =>
          selector === "a" ? { getAttribute: (name: string) => (name === "href" ? "#section" : null) } : null,
      },
      preventDefault() {
        fragmentPrevented = true;
      },
    });
    expect(fragmentPrevented).toBe(false);
  });
});

describe("the standalone dev server", () => {
  it("refuses to start in production", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/ui-workbench/dev.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refuses to start");
  });

  it("serves the brand PNGs as decoded bytes", async () => {
    const app = new Hono();
    app.get("/assets/favicon.png", (c) =>
      c.newResponse(new Uint8Array(Buffer.from(FAVICON_PNG_BASE64, "base64")), 200, {
        "content-type": "image/png",
      }),
    );
    // The dev server mirrors the production route; this pins the decoding.
    const bytes = Buffer.from(FAVICON_PNG_BASE64, "base64");
    const response = await app.request("/assets/favicon.png");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
    expect(body.subarray(1, 4).toString("ascii")).toBe("PNG");
  });
});

describe("the peer address", () => {
  it("reads the real socket address of a live server", async () => {
    const app = new Hono();
    mountWorkbench(app, { enabled: true, production: false });

    let announce: (port: number) => void = () => {};
    const listening = new Promise<number>((resolve) => {
      announce = resolve;
    });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      announce(info.port),
    );
    const port = await listening;

    try {
      const direct = await fetch(`http://127.0.0.1:${port}/dev/ui/catalog.json`);
      expect(direct.status).toBe(200);

      // A forwarded header means the peer is a proxy, not the client: the
      // loopback rule proves nothing, so the request is refused.
      const proxied = await fetch(`http://127.0.0.1:${port}/dev/ui/catalog.json`, {
        headers: { "X-Forwarded-For": "127.0.0.1" },
      });
      expect(proxied.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("refuses a spoofed forwarding header from a remote peer", async () => {
    const app = productionApp({ MAOMAO_UI_WORKBENCH_ENABLED: "1" }, () => "203.0.113.7");
    const response = await app.request("/dev/ui/catalog.json", {
      headers: { "X-Forwarded-For": "127.0.0.1" },
    });
    expect(response.status).toBe(404);
  });
});

describe("the validation CLI", () => {
  it("reports a valid story set", () => {
    const result = runValidation(STORIES);
    expect(result.problems).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.stories).toBe(STORIES.length);
  });

  it("reports problems and a failing exit code", () => {
    const broken: WorkbenchStory = {
      id: "broken",
      title: "",
      category: "",
      family: "ssr",
      variants: [],
      sourceFiles: ["src/does-not-exist.ts"],
      defaultViewport: "desktop",
      uses: ["missing-story"],
      preview: () => "   ",
    };
    const result = runValidation([broken]);
    expect(result.exitCode).toBe(1);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("exits nonzero when the story set is malformed", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/ui-workbench/validate-cli.ts"],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("story registry is valid");
  });
});
