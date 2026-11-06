/**
 * The standalone UI workbench: one command, no credentials, no services.
 *
 *   npm run ui:dev
 *
 * It boots only the workbench routes plus the app's static assets. Maomao's
 * normal service initialization (config, database, queue, workers, GitHub)
 * never runs, so no `.env` credentials are needed.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { CHAT_BUNDLE_HREF, PIERRE_DIFFS_HREF } from "../ui/paths.js";
import { THEME_CSS } from "../ui/theme.js";
import { TYPEAHEAD_JS } from "../ui/typeahead.js";
import { MODEL_PICKER_JS } from "../ui/model-picker.js";
import { FAVICON_PNG_BASE64, FAVICON_SVG, LARGE_ICON_PNG_BASE64, LARGE_ICON_SVG } from "../ui/icons.js";
import { isProduction } from "./gate.js";
import { mountWorkbench } from "./mount.js";
import { chatBundlePath, pierreBundlePath } from "./assets.js";

const HOST = process.env.MAOMAO_UI_WORKBENCH_HOST || "127.0.0.1";
const PORT = Number(process.env.MAOMAO_UI_WORKBENCH_PORT || "4310");

if (isProduction()) {
  console.error("ui:dev refuses to start with NODE_ENV=production — the workbench is dev-only.");
  process.exit(1);
}

const app = new Hono();

// The app's real assets, served at the same paths the production pages use so
// a frame looks exactly like the page it came from.
app.get("/assets/maomao.css", (c) =>
  c.newResponse(THEME_CSS, 200, {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "public, max-age=3600",
  }),
);
app.get("/assets/typeahead.js", (c) =>
  c.newResponse(TYPEAHEAD_JS, 200, { "content-type": "text/javascript; charset=utf-8" }),
);
app.get("/assets/model-picker.js", (c) =>
  c.newResponse(MODEL_PICKER_JS, 200, { "content-type": "text/javascript; charset=utf-8" }),
);
app.get(CHAT_BUNDLE_HREF, (c) => {
  try {
    return c.newResponse(readFileSync(chatBundlePath(), "utf8"), 200, {
      "content-type": "text/javascript; charset=utf-8",
    });
  } catch {
    return c.text("Not found", 404);
  }
});
app.get(PIERRE_DIFFS_HREF, (c) => {
  try {
    return c.newResponse(readFileSync(pierreBundlePath(), "utf8"), 200, {
      "content-type": "text/javascript; charset=utf-8",
    });
  } catch {
    return c.text("Not found", 404);
  }
});
app.get("/assets/favicon.svg", (c) => c.newResponse(FAVICON_SVG, 200, { "content-type": "image/svg+xml" }));
app.get("/assets/icon.svg", (c) => c.newResponse(LARGE_ICON_SVG, 200, { "content-type": "image/svg+xml" }));
// The brand PNGs are stored as base64; the production asset route decodes
// them, and so must this one — base64 text with an image content type is
// not an image.
app.get("/assets/favicon.png", (c) =>
  c.newResponse(new Uint8Array(Buffer.from(FAVICON_PNG_BASE64, "base64")), 200, {
    "content-type": "image/png",
    "cache-control": "public, max-age=86400",
  }),
);
app.get("/assets/icon.png", (c) =>
  c.newResponse(new Uint8Array(Buffer.from(LARGE_ICON_PNG_BASE64, "base64")), 200, {
    "content-type": "image/png",
    "cache-control": "public, max-age=86400",
  }),
);

// The workbench routes, behind the same gate the production server uses. The
// dev command is the explicit opt-in, so the flag is on here.
mountWorkbench(app, { enabled: true, production: isProduction(), announce: true });

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`Maomao UI workbench on http://${info.address}:${info.port}/dev/ui`);
  console.log("Catalog: http://" + `${info.address}:${info.port}/dev/ui/catalog.json`);
  console.log("No credentials, database, queue, or worker are started.");
});
