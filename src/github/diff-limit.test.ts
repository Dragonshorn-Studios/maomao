import { describe, expect, it, vi } from "vitest";
import {
  DiffTooLargeError,
  limitedGithubFetch,
  readBodyWithByteLimit,
  unwrapDiffTooLarge,
} from "./diff-limit.js";

describe("readBodyWithByteLimit", () => {
  it("returns the body when Content-Length and size are within the cap", async () => {
    const response = new Response("abcd", { headers: { "content-length": "4" } });
    await expect(readBodyWithByteLimit(response, 4)).resolves.toBe("abcd");
  });

  it("aborts before reading when Content-Length exceeds the cap", async () => {
    const response = new Response("abcdefgh", { headers: { "content-length": "64" } });
    await expect(readBodyWithByteLimit(response, 8)).rejects.toMatchObject({
      name: "DiffTooLargeError",
      actualBytes: 64,
      maxBytes: 8,
    });
  });

  it("aborts a streamed body once the running total exceeds the cap", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("abcd"));
        controller.enqueue(encoder.encode("efgh"));
        controller.close();
      },
    });
    await expect(readBodyWithByteLimit(new Response(stream), 5)).rejects.toBeInstanceOf(DiffTooLargeError);
  });

  it("disables the cap when maxBytes is 0", async () => {
    await expect(readBodyWithByteLimit(new Response("huge-diff-body"), 0)).resolves.toBe("huge-diff-body");
  });
});

describe("limitedGithubFetch", () => {
  it("replaces a successful body after applying the byte limit", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("ok-diff", {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": "7" },
        }),
    );
    try {
      const response = await limitedGithubFetch(16)("https://example.test/diff");
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("ok-diff");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves non-OK GitHub error bodies untouched", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    try {
      const response = await limitedGithubFetch(1)("https://example.test/diff");
      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("nope");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("unwrapDiffTooLarge", () => {
  it("walks Error.cause to recover DiffTooLargeError", () => {
    const inner = new DiffTooLargeError(9, 1);
    const wrapped = new Error("request failed", { cause: inner });
    expect(unwrapDiffTooLarge(wrapped)).toBe(inner);
    expect(unwrapDiffTooLarge(new Error("other"))).toBeUndefined();
  });
});
