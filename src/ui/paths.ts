import { createHash } from "node:crypto";

/**
 * The esbuild-bundled @pierre/diffs viewer. One constant because the path is
 * repeated across the asset route, the auth whitelist, the page head, and
 * tests — missing the whitelist copy yields a redirect-to-login.
 */
export const PIERRE_DIFFS_HREF = "/assets/vendor/pierre-diffs.js";
export const CHAT_BUNDLE_HREF = "/assets/chat.js";
export const GUIDED_BUNDLE_HREF = "/assets/guided.js";

/** Short content fingerprint for cache-busting asset URLs. Assets are served
 * at stable paths with the fingerprint in the query string — a deploy that
 * changes the content changes the URL, so no cache (browser, Cloudflare edge,
 * corporate proxy) can ever serve a stale copy, and responses can carry
 * immutable year-long caching instead of revalidating every load. */
export function assetVersion(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 10);
}

/** The embedding URL for an in-memory asset: stable path + content fingerprint. */
export function versionedUrl(path: string, body: string | Uint8Array): string {
  return `${path}?v=${assetVersion(body)}`;
}

/* Disk-built vendor bundles (pierre, chat) are not importable at module load —
 * the server hashes them at startup and primes these holders before any page
 * renders. Unprimed (a dev server started before build:vendor) the embedding
 * falls back to the bare path. */
const diskVersions = new Map<string, string>();
export function primeDiskAssetVersion(path: string, body: string): void {
  diskVersions.set(path, assetVersion(body));
}
export function diskAssetUrl(path: string): string {
  const version = diskVersions.get(path);
  return version ? `${path}?v=${version}` : path;
}
