import { describe, expect, it } from "vitest";
import { PIPELINE_PROMPT_STAGES } from "./prompts.js";
import { PROMPT_TEMPLATE_PLACEHOLDERS, composedPipelineStages } from "./prompt-previews.js";

describe("composed pipeline stage templates", () => {
  const stages = composedPipelineStages();
  const byId = Object.fromEntries(stages.map((stage) => [stage.id, stage]));

  it("covers every inventoried stage with the real builder text and placeholders", () => {
    expect(stages.map((stage) => stage.id)).toEqual(PIPELINE_PROMPT_STAGES.map((stage) => stage.id));
    for (const stage of stages) {
      expect(stage.text.length).toBeGreaterThan(200);
      expect(stage.text).toContain("{{");
      expect(stage.text).not.toMatch(/sk-[a-zA-Z0-9]{8,}/);
      expect(stage.text).not.toContain("GITHUB_TOKEN");
    }
  });

  it("shows untrusted fences with placeholder payloads instead of live job evidence", () => {
    expect(byId.aggregator?.text).toContain("You are Maomao's aggregator");
    expect(byId.aggregator?.text).toContain("UNTRUSTED_REVIEWER_EVIDENCE");
    expect(byId.aggregator?.text).toContain(PROMPT_TEMPLATE_PLACEHOLDERS.reviewerEvidence);
    expect(byId.aggregator?.text).toContain("UNTRUSTED_GITHUB_DISCUSSION");
    expect(byId.aggregator?.text).toContain(PROMPT_TEMPLATE_PLACEHOLDERS.humanDiscussion);

    expect(byId.verifier?.text).toContain("You are Maomao's finding verifier");
    expect(byId.verifier?.text).toContain("UNTRUSTED_PRIOR_FINDINGS");
    expect(byId.verifier?.text).toContain(PROMPT_TEMPLATE_PLACEHOLDERS.priorFindings);

    expect(byId["poison-alert"]?.text).toContain("poison-alert laboratory re-check");
    expect(byId["poison-alert"]?.text).toContain("UNTRUSTED_FIRST_PASS_FINDINGS");
    expect(byId["poison-alert"]?.text).toContain("UNTRUSTED_DIFF_HUNKS");
    expect(byId["poison-alert"]?.text).toContain(PROMPT_TEMPLATE_PLACEHOLDERS.hunks);

    expect(byId.router?.text).toContain("You are Maomao's pre-review router");
    expect(byId.router?.text).toContain("UNTRUSTED_PULL_REQUEST_DATA");
    expect(byId.router?.text).toContain(PROMPT_TEMPLATE_PLACEHOLDERS.diff);

    expect(byId.stack_cumulative?.text).toContain("You are Maomao's stack reviewer");
    expect(byId.stack_cumulative?.text).toContain(PROMPT_TEMPLATE_PLACEHOLDERS.memberDiff);
    expect(byId.stack_cumulative?.text).toContain(PROMPT_TEMPLATE_PLACEHOLDERS.stackId);

    expect(byId["repo-brief"]?.text).toContain("You are Maomao's repo briefer");
    expect(byId["repo-brief"]?.text).toContain(PROMPT_TEMPLATE_PLACEHOLDERS.sha);

    expect(byId.explainer?.text).toContain("You are Maomao's code explainer");
    expect(byId.explainer?.text).toContain("UNTRUSTED_REVIEW_FINDINGS");
    expect(byId.explainer?.text).toContain(PROMPT_TEMPLATE_PLACEHOLDERS.operatorQuestion);
  });
});
