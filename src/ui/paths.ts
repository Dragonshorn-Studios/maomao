/**
 * The esbuild-bundled @pierre/diffs viewer. One constant because the path is
 * repeated across the asset route, the auth whitelist, the page head, and
 * tests — missing the whitelist copy yields a redirect-to-login.
 */
export const PIERRE_DIFFS_HREF = "/assets/vendor/pierre-diffs.js";
export const CHAT_BUNDLE_HREF = "/assets/chat.js";
