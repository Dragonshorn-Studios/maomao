import { describe, expect, it, vi } from "vitest";
import { sseDataEvents } from "./sse.js";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const event of sseDataEvents(body)) out.push(event);
  return out;
}

describe("sseDataEvents", () => {
  it("parses events split across chunks", async () => {
    const events = await collect(streamFrom(['data: {"delta":"hel', 'lo"}\n\ndata: {"done":true}\n\n']));
    expect(events).toEqual([{ delta: "hello" }, { done: true }]);
  });

  it("parses multiple events within one chunk", async () => {
    const events = await collect(
      streamFrom(['data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\ndata: {"delta":"c"}\n\n']),
    );
    expect(events).toHaveLength(3);
  });

  it("skips malformed data lines without losing the stream", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = await collect(streamFrom(['data: {broken\n\ndata: {"delta":"ok"}\n\n']));
    expect(events).toEqual([{ delta: "ok" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("ignores non-data lines", async () => {
    const events = await collect(streamFrom([": keepalive\n\nevent: x\ndata: {\"done\":true}\n\n"]));
    expect(events).toEqual([{ done: true }]);
  });

  it("drops a trailing frame without the blank-line terminator (pinned behavior)", async () => {
    const events = await collect(streamFrom(['data: {"delta":"x"}']));
    expect(events).toEqual([]);
  });
});
