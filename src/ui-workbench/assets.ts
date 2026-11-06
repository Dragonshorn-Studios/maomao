/**
 * Which built bundles exist on disk.
 *
 * The workbench serves the app's real assets, but a fresh checkout may not
 * have run `npm run build:vendor` yet. The frame therefore only references a
 * bundle when the file is there — a missing script tag would show up as a
 * console error in the browser smoke tests.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./registry.js";

const ASSETS_DIR = resolve(REPO_ROOT, "dist/assets");

export function chatBundlePath(): string {
  return resolve(ASSETS_DIR, "chat.js");
}

export function pierreBundlePath(): string {
  return resolve(ASSETS_DIR, "vendor/pierre-diffs.js");
}

export function chatBundleAvailable(): boolean {
  return existsSync(chatBundlePath());
}

export function pierreBundleAvailable(): boolean {
  return existsSync(pierreBundlePath());
}

/**
 * Script tags for the frame head.
 *
 * The @pierre/diffs bundle is several megabytes, so it is only referenced
 * when the story's markup actually contains a diff container to upgrade.
 */
export function frameHeadScripts(fragment: string): string[] {
  if (fragment.includes("data-pierre-diff") && pierreBundleAvailable()) {
    return ['<script src="/assets/vendor/pierre-diffs.js" defer></script>'];
  }
  return [];
}
