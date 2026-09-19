import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_BUNDLE_HREF } from "./paths.js";

/**
 * Pins the jsx-transform fix: the chat bundle must use the automatic jsx
 * runtime (no free `React.createElement` references). The classic transform
 * compiles cleanly but dies in the browser with "React is not defined" —
 * after deleting the no-JS form, so nothing would work.
 */
describe("chat bundle build gate", () => {
  const bundlePath = resolve(process.cwd(), "dist", "assets", "chat.js");

  it("is built by the test run (build:vendor precedes vitest)", () => {
    expect(existsSync(bundlePath)).toBe(true);
  });

  it("uses the automatic jsx runtime and never emits free React.createElement", () => {
    const bundle = readFileSync(bundlePath, "utf8");
    expect((bundle.match(/[^.\w]React\.createElement/g) ?? []).length).toBe(0);
    expect(/jsx-runtime|jsxDEV|jsx\(/.test(bundle)).toBe(true);
    expect(bundle.includes("maomao-chat-config")).toBe(true);
  });

  it("keeps the bundle href and file name in sync", () => {
    expect(CHAT_BUNDLE_HREF).toBe("/assets/chat.js");
    expect(bundlePath.endsWith(joinPath("assets", "chat.js"))).toBe(true);
  });
});

function joinPath(...parts: string[]): string {
  return parts.join("/");
}
