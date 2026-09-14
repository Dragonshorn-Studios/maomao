import { describe, expect, it } from "vitest";
import { parseOpenCodeOutput, reconcileStepTotal, extractStepTokens } from "./parse.js";

function lines(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

const nestedFinish = (id: string, tokens: Record<string, unknown>, cost: number, extras: Record<string, unknown> = {}) => ({
  type: "step_finish",
  part: {
    id,
    type: "step-finish",
    cost,
    tokens,
    ...extras,
  },
});

describe("parseOpenCodeOutput", () => {
  it("joins json text events", () => {
    const stdout = lines(
      { type: "text", part: { text: '{"reviewer":"x"' } },
      { type: "text", part: { text: ',"verdict":"clean","findings":[]}' } },
      nestedFinish("prt_1", { input: 10, output: 4 }, 0.01),
    );
    const parsed = parseOpenCodeOutput(stdout);
    expect(parsed.text).toContain('"verdict":"clean"');
    expect(parsed.usage.promptTokens).toBe(10);
    expect(parsed.usage.completionTokens).toBe(4);
    expect(parsed.usage.cost).toBe(0.01);
    expect(parsed.usage.totalTokens).toBe(14);
    expect(parsed.usage.complete).toBe(true);
    expect(parsed.usage.steps).toBe(1);
  });

  it("matches a single-step tokens.total exactly", () => {
    const stdout = lines(
      nestedFinish("prt_1", { input: 100, output: 20, reasoning: 5, total: 125, cache: { read: 40, write: 2 } }, 0.04),
    );
    const parsed = parseOpenCodeOutput(stdout);
    expect(parsed.usage.totalTokens).toBe(125);
    expect(parsed.usage.promptTokens).toBe(100);
    expect(parsed.usage.completionTokens).toBe(20);
    expect(parsed.usage.reasoningTokens).toBe(5);
    expect(parsed.usage.cacheReadTokens).toBe(40);
    expect(parsed.usage.cacheWriteTokens).toBe(2);
    expect(parsed.usage.cost).toBe(0.04);
    expect(parsed.usage.complete).toBe(true);
  });

  it("sums unique multi-step costs and reconciled totals", () => {
    const stdout = lines(
      { type: "step_start", part: { id: "prt_s1", type: "step-start", messageID: "msg_1" } },
      nestedFinish("prt_f1", { input: 200, output: 10, reasoning: 0, total: 210, cache: { read: 0, write: 4 } }, 0.01, {
        messageID: "msg_1",
        reason: "tool-calls",
      }),
      { type: "step_start", part: { id: "prt_s2", type: "step-start", messageID: "msg_2" } },
      nestedFinish("prt_f2", { input: 250, output: 30, reasoning: 8, total: 288, cache: { read: 40, write: 0 } }, 0.03, {
        messageID: "msg_2",
        reason: "stop",
      }),
    );
    const parsed = parseOpenCodeOutput(stdout);
    expect(parsed.usage.steps).toBe(2);
    expect(parsed.usage.cost).toBe(0.04);
    expect(parsed.usage.promptTokens).toBe(450);
    expect(parsed.usage.completionTokens).toBe(40);
    expect(parsed.usage.reasoningTokens).toBe(8);
    expect(parsed.usage.cacheReadTokens).toBe(40);
    expect(parsed.usage.cacheWriteTokens).toBe(4);
    expect(parsed.usage.totalTokens).toBe(498);
    expect(parsed.usage.complete).toBe(true);
  });

  it("does not double-count repeated step_finish events with the same part id", () => {
    const event = nestedFinish("prt_dup", { input: 50, output: 5, total: 55 }, 0.02);
    const parsed = parseOpenCodeOutput(lines(event, event, event));
    expect(parsed.usage.steps).toBe(1);
    expect(parsed.usage.cost).toBe(0.02);
    expect(parsed.usage.totalTokens).toBe(55);
  });

  it("parses flat cache_read/cache_write token fields", () => {
    const parsed = parseOpenCodeOutput(
      lines(nestedFinish("prt_flat", { input: 10, output: 2, reasoning: 1, cache_read: 7, cache_write: 3, total: 23 }, 0.005)),
    );
    expect(parsed.usage.cacheReadTokens).toBe(7);
    expect(parsed.usage.cacheWriteTokens).toBe(3);
    expect(parsed.usage.totalTokens).toBe(23);
  });

  it("reads nested usage and numeric strings when step_finish is absent", () => {
    const stdout = JSON.stringify({
      type: "message",
      info: { usage: { prompt_tokens: "12", completion_tokens: "3", cost: "0.02" } },
    });
    const parsed = parseOpenCodeOutput(stdout);
    expect(parsed.usage.promptTokens).toBe(12);
    expect(parsed.usage.completionTokens).toBe(3);
    expect(parsed.usage.cost).toBe(0.02);
    expect(parsed.usage.complete).toBe(false);
    expect(parsed.usage.warning).toMatch(/no step_finish/i);
  });

  it("marks a stream incomplete when a step_start has no matching step_finish", () => {
    const stdout = lines(
      { type: "step_start", part: { id: "prt_s1", type: "step-start" } },
      nestedFinish("prt_f1", { input: 10, output: 2, total: 12 }, 0.01),
      { type: "step_start", part: { id: "prt_s2", type: "step-start" } },
      { type: "text", part: { text: '{"reviewer":"x","verdict":"clean","findings":[]}' } },
    );
    const parsed = parseOpenCodeOutput(stdout);
    expect(parsed.usage.complete).toBe(false);
    expect(parsed.usage.warning).toMatch(/incomplete/i);
    expect(parsed.usage.totalTokens).toBe(12);
    expect(parsed.usage.cost).toBe(0.01);
  });

  it("does not treat missing usage as a complete zero total", () => {
    const parsed = parseOpenCodeOutput(lines({ type: "text", part: { text: "hello" } }));
    expect(parsed.usage.complete).toBe(false);
    expect(parsed.usage.cost).toBeUndefined();
    expect(parsed.usage.totalTokens).toBeUndefined();
    expect(parsed.usage.warning).toMatch(/did not report/i);
  });

  it("ignores malformed JSON lines and still sums later steps", () => {
    const stdout = [
      "{not json",
      JSON.stringify(nestedFinish("prt_ok", { input: 8, output: 1, total: 9 }, 0.001)),
      "{",
    ].join("\n");
    const parsed = parseOpenCodeOutput(stdout);
    expect(parsed.usage.totalTokens).toBe(9);
    expect(parsed.usage.complete).toBe(true);
  });

  it("falls back to raw stdout when events are absent", () => {
    expect(parseOpenCodeOutput('{"reviewer":"tests","verdict":"clean","findings":[]}').text).toContain("tests");
  });
});

describe("reconcileStepTotal", () => {
  it("uses tokens.total when the provider reports it", () => {
    expect(
      reconcileStepTotal({ input: 100, output: 10, reasoning: 0, cacheRead: 80, cacheWrite: 0, reportedTotal: 110 }),
    ).toBe(110);
  });

  it("adds cache when it is reported separately from input", () => {
    expect(reconcileStepTotal({ input: 671, output: 8, reasoning: 0, cacheRead: 21415, cacheWrite: 0 })).toBe(22094);
  });

  it("does not add cache when input already includes cache reads", () => {
    expect(reconcileStepTotal({ input: 22086, output: 8, reasoning: 0, cacheRead: 21415, cacheWrite: 0 })).toBe(22094);
  });
});

describe("extractStepTokens", () => {
  it("accepts both nested and flat cache conventions", () => {
    expect(extractStepTokens({ tokens: { input: 1, output: 2, cache: { read: 3, write: 4 } }, cost: 0 })?.cacheRead).toBe(3);
    expect(extractStepTokens({ tokens: { input: 1, output: 2, cacheRead: 5, cacheWrite: 6 } })?.cacheWrite).toBe(6);
  });
});
