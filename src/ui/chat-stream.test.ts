import { describe, expect, it } from "vitest";
import { applySseEvent, emptyAssistantStream, toAssistantContent } from "./chat-stream.js";

describe("assistant-ui stream mapping", () => {
  it("treats delta and reasoning as snapshots and tools as name/status only", () => {
    let state = emptyAssistantStream();
    state = applySseEvent(state, { delta: "Hel" });
    state = applySseEvent(state, { delta: "Hello" });
    state = applySseEvent(state, { reasoning: "look at auth.ts" });
    state = applySseEvent(state, { tool: { id: "t1", name: "read", status: "running", args: { path: ".env" } } });
    state = applySseEvent(state, { tool: { id: "t1", name: "read", status: "complete" } });
    expect(state.text).toBe("Hello");
    expect(state.reasoning).toBe("look at auth.ts");
    expect(state.tools).toEqual([{ id: "t1", name: "read", status: "complete" }]);
    const content = toAssistantContent(state);
    expect(content[0]).toEqual({ type: "reasoning", text: "look at auth.ts" });
    expect(content[1]).toMatchObject({ type: "tool-call", toolName: "read", result: "complete", args: {} });
    expect(content.at(-1)).toEqual({ type: "text", text: "Hello" });
    expect(JSON.stringify(content)).not.toContain(".env");
  });
});
