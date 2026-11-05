/**
 * The workbench Hono app.
 *
 * The routes are relative so the same app can be mounted at `/dev/ui` in the
 * production server (behind the dev-only gate) and at `/dev/ui` in the
 * standalone dev server — the URLs a browser agent sees are identical either
 * way.
 */
import { Hono } from "hono";
import { VIEWPORTS, type Catalog, type ViewportName } from "./contract.js";
import { WorkbenchRegistry, resolveViewport } from "./registry.js";
import { frameUrl, renderFrame, renderGallery, renderStoryPage, renderTokensPage, storyUrl } from "./render.js";
import { frameHeadScripts } from "./assets.js";
import { designTokens } from "./tokens.js";
import { STORIES } from "./stories.js";
import { FAKE_CHAT_STREAM_URL } from "./stories.js";

/** The theme a request asks for. Anything but `dark` is the light theme. */
function themeOf(requested: string | undefined): "light" | "dark" {
  return requested === "dark" ? "dark" : "light";
}

export interface WorkbenchAppOptions {
  /** The story registry to serve. Defaults to Maomao's own story book. */
  registry?: WorkbenchRegistry;
}

/** The story id the fake chat endpoint answers for. */
const FAKE_CHAT_JOB = 415;

function buildCatalog(registry: WorkbenchRegistry): Catalog {
  return {
    generatedBy: "maomao-ui-workbench",
    viewports: {
      mobile: { ...VIEWPORTS.mobile },
      tablet: { ...VIEWPORTS.tablet },
      desktop: { ...VIEWPORTS.desktop },
    },
    stories: registry.all().map((story) => ({
      id: story.id,
      title: story.title,
      category: story.category,
      family: story.family,
      defaultViewport: story.defaultViewport,
      sourceFiles: [...story.sourceFiles],
      // Maomao declares its composition edges: the renderers are plain
      // functions, so only the story knows which components it renders.
      uses: [...(story.uses ?? [])],
      notes: story.notes ?? null,
      variants: story.variants.map((variant) => ({
        id: variant.id,
        title: variant.title,
        url: storyUrl(story.id, variant.id),
        frameUrl: frameUrl(story.id, variant.id),
      })),
    })),
  };
}

/**
 * The fake chat endpoint: a deterministic in-process SSE responder.
 *
 * It never calls a model and never reads the filesystem. The island's
 * adapter expects `text/event-stream` frames shaped like the production
 * stream, so the preview exercises the real client code path.
 */
function fakeChatStream(): Response {
  const encoder = new TextEncoder();
  const frames = [
    { reasoning: "Reading the reviewed commit and Maomao's findings." },
    { tool: { id: "tool-1", name: "read", status: "done" } },
    {
      delta:
        "This change tightens the session cookie flags on the login route: the cookie now carries Secure, HttpOnly, and SameSite=Lax, and the refresh path reuses the same helper.",
    },
    { done: true },
  ];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function createWorkbenchApp(options: WorkbenchAppOptions = {}): Hono {
  const registry = options.registry ?? new WorkbenchRegistry(STORIES);
  const app = new Hono();

  app.get("/", (c) => c.html(renderGallery(registry.all(), themeOf(c.req.query("theme")))));

  app.get("/catalog.json", (c) => c.json(buildCatalog(registry)));

  app.post("/fake/chat/stream", (c) => fakeChatStream());

  // Registered before `/:story` so the tokens page is never read as a story.
  app.get("/tokens", (c) => c.html(renderTokensPage(designTokens(), themeOf(c.req.query("theme")))));

  app.get("/:story/:variant/frame", (c) => {
    const story = registry.find(c.req.param("story"));
    if (!story) return c.notFound();
    const variant = registry.variant(story, c.req.param("variant"));
    if (!variant) return c.notFound();

    const viewport = resolveViewport(c.req.query("viewport"), story.defaultViewport);
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const frozen = c.req.query("frozen") === "1";
    const fragment = story.preview(variant);

    return c.html(
      renderFrame(story, variant, fragment, {
        frozen,
        theme,
        viewport: viewport.name,
        headScripts: frameHeadScripts(fragment),
      }),
    );
  });

  app.get("/:story/:variant", (c) => {
    const story = registry.find(c.req.param("story"));
    if (!story) return c.notFound();
    const variant = registry.variant(story, c.req.param("variant"));
    if (!variant) return c.notFound();

    const viewport = resolveViewport(c.req.query("viewport"), story.defaultViewport);
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const frozen = c.req.query("frozen") === "1";

    return c.html(
      renderStoryPage(story, variant, viewport.name, theme, frozen, {
        uses: registry.uses(story),
        usedBy: registry.usedBy(story),
      }),
    );
  });

  app.get("/:story", (c) => {
    const story = registry.find(c.req.param("story"));
    if (!story) return c.notFound();
    const variant = registry.variant(story, undefined);
    if (!variant) return c.notFound();

    const viewport = resolveViewport(c.req.query("viewport"), story.defaultViewport);
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const frozen = c.req.query("frozen") === "1";

    return c.html(
      renderStoryPage(story, variant, viewport.name, theme, frozen, {
        uses: registry.uses(story),
        usedBy: registry.usedBy(story),
      }),
    );
  });

  return app;
}

export { FAKE_CHAT_JOB, FAKE_CHAT_STREAM_URL };
export type { ViewportName };
