import { describe, expect, it } from "vitest";
import { parseOpenCodeOutput } from "./parse.js";

describe("parseOpenCodeOutput", () => {
  it("joins json text events", () => {
    const stdout = [
      JSON.stringify({ type: "text", part: { text: '{"reviewer":"x"' } }),
      JSON.stringify({ type: "text", part: { text: ',"verdict":"clean","findings":[]}' } }),
      JSON.stringify({ type: "step_finish", part: { tokens: { input: 10, output: 4 }, cost: 0.01 } }),
    ].join("\n");
    const parsed = parseOpenCodeOutput(stdout);
    expect(parsed.text).toContain('"verdict":"clean"');
    expect(parsed.usage.promptTokens).toBe(10);
    expect(parsed.usage.completionTokens).toBe(4);
    expect(parsed.usage.cost).toBe(0.01);
  });

  it("falls back to raw stdout when events are absent", () => {
    expect(parseOpenCodeOutput('{"reviewer":"tests","verdict":"clean","findings":[]}').text).toContain("tests");
  });
});
