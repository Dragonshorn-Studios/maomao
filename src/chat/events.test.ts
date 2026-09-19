import { describe, expect, it } from "vitest";
import { ExplainerEventParser } from "./events.js";

function events(chunk: string) {
  return new ExplainerEventParser().feed(chunk);
}

describe("ExplainerEventParser", () => {
  it("extracts the session id from step_start", () => {
    const result = events(
      `{"type":"step_start","sessionID":"ses_abc","part":{"type":"step-start"}}\n`,
    );
    expect(result.sessionId).toBe("ses_abc");
  });

  it("extracts assistant text parts in order", () => {
    const result = events(
      [
        `{"type":"step_start","sessionID":"ses_1","part":{"id":"p0","type":"step-start"}}`,
        `{"type":"text","part":{"id":"p1","type":"text","text":"first "}}`,
        `{"type":"text","part":{"id":"p2","type":"text","text":"second"}}`,
        `{"type":"step_finish","part":{"id":"p3","reason":"stop","tokens":{"total":10},"cost":0.01}}`,
      ].join("\n") + "\n",
    );
    expect(result.textParts).toEqual(["first ", "second"]);
  });

  it("holds partial lines across chunks and flushes on completion", () => {
    const parser = new ExplainerEventParser();
    const first = parser.feed('{"type":"text","part":{"id":"p1","text":"hel');
    expect(first.textParts).toEqual([]);
    const second = parser.feed('lo"}}\n');
    expect(second.textParts).toEqual(["hello"]);
  });

  it("ignores non-JSON lines and non-text events", () => {
    const result = events("not json\n{\"type\":\"step_finish\"}\n{}\n");
    expect(result.textParts).toEqual([]);
  });

  it("keeps the first session id when a run reports several", () => {
    const result = events(
      [
        `{"type":"step_start","sessionID":"ses_first","part":{}}`,
        `{"type":"step_start","sessionID":"ses_second","part":{}}`,
      ].join("\n") + "\n",
    );
    expect(result.sessionId).toBe("ses_first");
  });

  it("dedupes an identical re-emitted part but keeps distinct parts", () => {
    const result = events(
      [
        `{"type":"text","part":{"id":"p1","text":"same"}}`,
        `{"type":"text","part":{"id":"p1","text":"same"}}`,
        `{"type":"text","part":{"id":"p2","text":"same"}}`,
      ].join("\n") + "\n",
    );
    expect(result.textParts).toEqual(["same", "same"]);
  });
});
