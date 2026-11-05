import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Browser smoke tests for Maomao's dev-only UI workbench.
 *
 * The workbench is the cross-project contract: a browser agent reads
 * `/dev/ui/catalog.json`, picks a story and a variant, opens the variant's
 * `frameUrl` and screenshots the production markup inside it. These tests pin
 * that contract and the gallery, not the visual output — screenshots are
 * artifacts, never compared.
 *
 * The catalog types are declared here on purpose: the wire format is the
 * contract, so the test pins it independently of `src/`.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCREENSHOT_DIR = path.join(REPO_ROOT, "test-results", "screenshots");

/** The deterministic answer the fake SSE endpoint streams back. */
const FAKE_REPLY = "This change tightens the session cookie flags on the login route";

interface CatalogVariant {
  id: string;
  title: string;
  url: string;
  frameUrl: string;
}

interface CatalogStory {
  id: string;
  title: string;
  category: string;
  family: "ssr" | "react";
  defaultViewport: string;
  sourceFiles: string[];
  uses: string[];
  notes: string | null;
  variants: CatalogVariant[];
}

interface Catalog {
  generatedBy: string;
  viewports: Record<string, { width: number; height: number }>;
  stories: CatalogStory[];
}

/** Fetches the catalog and checks that it is the workbench's own document. */
async function fetchCatalog(request: APIRequestContext): Promise<Catalog> {
  const response = await request.get("/dev/ui/catalog.json");
  expect(response.status(), "the catalog must be served").toBe(200);
  const catalog = (await response.json()) as Catalog;
  expect(catalog.generatedBy).toBe("maomao-ui-workbench");
  expect(Array.isArray(catalog.stories)).toBe(true);
  expect(catalog.stories.length).toBeGreaterThan(0);
  return catalog;
}

/** Appends query parameters to a workbench path. */
function withQuery(pathname: string, params: Record<string, string>): string {
  const url = new URL(pathname, "http://127.0.0.1:4310");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

/** Collects console errors and uncaught page errors of a page. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/**
 * Saves a screenshot artifact under `test-results/`, named after the project
 * so the desktop and mobile runs never collide.
 */
async function saveScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<string> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${testInfo.project.name}-${name}.png`);
  await page.screenshot({ path: file, animations: "disabled", caret: "hide", scale: "css" });
  const stats = await stat(file);
  expect(stats.size, `the screenshot ${file} must not be empty`).toBeGreaterThan(0);
  return file;
}

test.describe("Maomao UI workbench", () => {
  test("the catalog drives the frame preview", async ({ page, request }) => {
    const catalog = await fetchCatalog(request);

    // The story and its variant come from the catalog, not from a hardcoded
    // URL — the first published story is the job/status card.
    const story = catalog.stories[0];
    expect(story.variants.length).toBeGreaterThan(0);
    const variant = story.variants.find((candidate) => candidate.id === "completed") ?? story.variants[0];

    await page.goto(withQuery(variant.frameUrl, { frozen: "1" }));

    // Production markers: the frame is the real markup of a real story.
    await expect(page.locator("body")).toHaveAttribute("data-workbench-story", story.id);
    await expect(page.locator("body")).toHaveAttribute("data-workbench-variant", variant.id);
    await expect(page.locator("body")).toHaveAttribute("data-workbench-family", story.family);
    await expect(page.locator("html")).toHaveAttribute("data-workbench-frozen", "1");
    await expect(page.locator("main#main")).not.toBeEmpty();

    await saveScreenshot(page, test.info(), "catalog-discovery");
  });

  test("the gallery renders and filters stories", async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto("/dev/ui", { waitUntil: "networkidle" });

    await expect(page.getByRole("heading", { level: 1, name: "Maomao UI workbench" })).toBeVisible();
    const search = page.locator("#workbench-search");
    await expect(search).toBeVisible();

    const catalog = await fetchCatalog(page.request);
    const cards = page.locator(".workbench-card");
    await expect(cards).toHaveCount(catalog.stories.length);

    const target = catalog.stories[0];
    const other = catalog.stories.find((candidate) => candidate.id !== target.id);
    expect(other, "the catalog must publish more than one story").toBeTruthy();
    await expect(page.getByRole("heading", { name: target.title, exact: true })).toBeVisible();

    // Typing filters the list: the matching story stays, the others go.
    await search.fill(target.id);
    await expect(page.getByRole("heading", { name: target.title, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: other!.title, exact: true })).toBeHidden();

    expect(errors, "the gallery must not log console errors").toEqual([]);
    await saveScreenshot(page, test.info(), "gallery-filtered");
  });

  test("the design tokens page renders a swatch per theme", async ({ page }) => {
    const errors = collectPageErrors(page);
    await page.goto("/dev/ui/tokens", { waitUntil: "networkidle" });

    await expect(page.getByRole("heading", { level: 1, name: "Design tokens" })).toBeVisible();
    await expect(page.locator(".workbench-token")).not.toHaveCount(0);

    // Every color token shows both of its values side by side.
    const swatches = page.locator(".workbench-swatch-pair");
    await expect(swatches).not.toHaveCount(0);
    await expect(page.locator(".workbench-token-light").first()).toBeVisible();
    await expect(page.locator(".workbench-token-dark").first()).toBeVisible();

    // The theme switch is the app's own token set, not a workbench palette.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.goto("/dev/ui/tokens?theme=dark", { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    expect(errors, "the tokens page must not log console errors").toEqual([]);
    await saveScreenshot(page, test.info(), "design-tokens");
  });

  test("the gallery links the tokens page", async ({ page }) => {
    await page.goto("/dev/ui", { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "design tokens" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Design tokens" })).toBeVisible();
  });

  test("the catalog publishes composition edges the story page shows", async ({ page, request }) => {
    const catalog = await fetchCatalog(request);
    const composed = catalog.stories.find((candidate) => candidate.uses.length > 0);
    expect(composed, "the catalog must publish at least one composed story").toBeTruthy();

    const story = composed!;
    const used = catalog.stories.find((candidate) => candidate.id === story.uses[0]);
    expect(used, "a composed id must point at a published story").toBeTruthy();

    await page.goto(story.variants[0].url);
    await expect(page.getByRole("heading", { name: "Uses" })).toBeVisible();
    await expect(page.getByRole("link", { name: used!.title, exact: true })).toBeVisible();
  });

  test("an ssr frame renders the production markup without console errors", async ({ page, request }) => {
    const errors = collectPageErrors(page);
    const catalog = await fetchCatalog(request);
    const story = catalog.stories.find((candidate) => candidate.family === "ssr");
    expect(story, "the catalog must publish an ssr story").toBeTruthy();
    const variant = story!.variants[0];

    await page.goto(withQuery(variant.frameUrl, { frozen: "1" }));

    await expect(page.locator("body")).toHaveAttribute("data-workbench-family", "ssr");
    await expect(page.locator("body")).toHaveAttribute("data-workbench-story", story!.id);
    await expect(page.locator("main#main")).not.toBeEmpty();
    expect((await page.locator("body").innerText()).trim().length).toBeGreaterThan(0);

    expect(errors, "the ssr frame must not log console errors").toEqual([]);
  });

  test("a react frame mounts the chat island without console errors", async ({ page, request }) => {
    const errors = collectPageErrors(page);
    const catalog = await fetchCatalog(request);
    const story = catalog.stories.find((candidate) => candidate.family === "react");
    expect(story, "the catalog must publish a react story").toBeTruthy();
    const variant = story!.variants[0];

    await page.goto(withQuery(variant.frameUrl, { frozen: "1" }));

    await expect(page.locator("body")).toHaveAttribute("data-workbench-family", "react");
    await expect(page.locator("main#main")).not.toBeEmpty();
    // The composer only exists once the island has committed.
    await expect(page.locator(".chat-composer-input")).toBeVisible();

    expect(errors, "the react frame must not log console errors").toEqual([]);
  });

  test("each project writes its own deterministic screenshot artifact", async ({ page }, testInfo) => {
    const catalog = await fetchCatalog(page.request);
    const presetName = testInfo.project.name;
    const preset = catalog.viewports[presetName];
    expect(preset, `the catalog must publish the ${presetName} viewport`).toBeTruthy();

    // The project viewport and the catalog viewport preset must agree.
    expect(page.viewportSize()).toEqual({ width: preset!.width, height: preset!.height });

    const story = catalog.stories[0];
    const variant = story.variants[0];
    await page.goto(withQuery(variant.frameUrl, { viewport: presetName, frozen: "1" }));
    await expect(page.locator("body")).toHaveAttribute("data-workbench-viewport", presetName);
    await expect(page.locator("main#main")).not.toBeEmpty();

    const file = await saveScreenshot(page, testInfo, "frame");
    expect(path.basename(file)).toBe(`${testInfo.project.name}-frame.png`);
    expect(path.dirname(file)).toBe(SCREENSHOT_DIR);
  });

  test("the chat island answers through the fake stream", async ({ page, request }) => {
    const errors = collectPageErrors(page);
    const catalog = await fetchCatalog(request);
    const story = catalog.stories.find((candidate) => candidate.family === "react");
    expect(story, "the catalog must publish a react story").toBeTruthy();
    const variant = story!.variants.find((candidate) => candidate.id === "empty");
    expect(variant, "the react story must publish an empty variant").toBeTruthy();
    expect(variant!.frameUrl).toBe("/dev/ui/chat/empty/frame");

    await page.goto(withQuery(variant!.frameUrl, { frozen: "1" }));

    const composer = page.locator(".chat-composer-input");
    await expect(composer).toBeVisible();
    await composer.fill("What does this change do overall?");
    await page.locator(".chat-send").click();

    // The reply arrives over the fake SSE endpoint.
    const reply = page.locator(".chat-bubble-assistant .chat-text").last();
    await expect(reply).toContainText(FAKE_REPLY, { timeout: 15_000 });

    expect(errors, "the chat interaction must not log console errors").toEqual([]);
    await saveScreenshot(page, test.info(), "chat-reply");
  });

  test("unknown story and variant ids fail closed", async ({ request }) => {
    const unknownStory = await request.get("/dev/ui/not-a-story");
    expect(unknownStory.status()).toBe(404);

    const unknownVariant = await request.get("/dev/ui/job-card/not-a-variant");
    expect(unknownVariant.status()).toBe(404);

    const unknownFrame = await request.get("/dev/ui/not-a-story/completed/frame");
    expect(unknownFrame.status()).toBe(404);

    // Control: a registered story still resolves, so the 404s above are the
    // gate working and not a dead server.
    const known = await request.get("/dev/ui/job-card");
    expect(known.status()).toBe(200);
  });
});
