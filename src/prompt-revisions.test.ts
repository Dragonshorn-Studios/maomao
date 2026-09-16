import { describe, expect, it, vi } from "vitest";
import { openDb } from "./db.js";
import { composeReviewerPrompt, evaluationSignals, PromptRevisionStore } from "./prompt-revisions.js";
import { REVIEWER_GUARDRAILS, promptBodyFromRolePrompt } from "./prompts.js";

function store() {
  return new PromptRevisionStore(openDb(":memory:"));
}

function failingOpencode(message = "opencode exploded") {
  return {
    async run() {
      throw new Error(message);
    },
  };
}

describe("prompt revision lifecycle", () => {
  it("creates, activates, and retires the previous active revision per role", () => {
    const prompts = store();
    const first = prompts.createDraft({ roleId: "correctness", body: "Focus: regressions.", createdBy: "octocat" });
    if (!("revision" in first)) throw new Error("draft failed");
    const activated = prompts.activatePromptRevision(first.revision.id, "octocat");
    expect(activated).toHaveProperty("revision");
    expect(prompts.getActivePrompt("correctness")?.id).toBe(first.revision.id);

    const second = prompts.createDraft({ roleId: "correctness", body: "Focus: regressions harder.", createdBy: "octocat" });
    if (!("revision" in second)) throw new Error("second draft failed");
    prompts.activatePromptRevision(second.revision.id, "octocat");
    expect(prompts.getActivePrompt("correctness")?.id).toBe(second.revision.id);
    expect(prompts.getPromptRevision(first.revision.id)?.status).toBe("retired");
  });

  it("rejects empty bodies and detects concurrent draft edits", () => {
    const prompts = store();
    const empty = prompts.createDraft({ roleId: "security", body: "   ", createdBy: "octocat" });
    expect(empty).toHaveProperty("error");

    const draft = prompts.createDraft({ roleId: "security", body: "Focus: authz.", createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    const first = prompts.updatePromptDraft({
      id: draft.revision.id,
      body: "Focus: authz v2.",
      expectedEditSeq: draft.revision.edit_seq,
      updatedBy: "alice",
    });
    expect(first).toHaveProperty("revision");
    const stale = prompts.updatePromptDraft({
      id: draft.revision.id,
      body: "Focus: authz v3.",
      expectedEditSeq: draft.revision.edit_seq,
      updatedBy: "bob",
    });
    expect(stale).toEqual({ error: "conflict" });
  });

  it("refuses activation of retired revisions outside rollback", () => {
    const prompts = store();
    const first = prompts.createDraft({ roleId: "tests", body: "Focus: tests.", createdBy: "octocat" });
    if (!("revision" in first)) throw new Error("draft failed");
    prompts.activatePromptRevision(first.revision.id, "octocat");
    const second = prompts.createDraft({ roleId: "tests", body: "Focus: tests v2.", createdBy: "octocat" });
    if (!("revision" in second)) throw new Error("second failed");
    prompts.activatePromptRevision(second.revision.id, "octocat");
    expect(prompts.activatePromptRevision(first.revision.id, "octocat")).toHaveProperty("error");
    expect(prompts.rollbackPromptRevision(first.revision.id, "octocat")).toHaveProperty("revision");
  });
});

describe("fixtures and evaluation", () => {
  const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,2 +1,3 @@
+console.log(secret);`;

  it("requires an explicit provenance acknowledgement and a bounded diff", () => {
    const prompts = store();
    const noAck = prompts.saveFixture({
      name: "leak",
      prMeta: { repo: "acme/widgets" },
      diff,
      savedBy: "octocat",
      acknowledged: false,
    });
    expect(noAck).toHaveProperty("error");
    const ok = prompts.saveFixture({
      name: "leak",
      prMeta: { repo: "acme/widgets" },
      diff,
      savedBy: "octocat",
      acknowledged: true,
    });
    expect(ok).toHaveProperty("fixture");
  });

  it("evaluates offline, records schema-validated findings, and never publishes", async () => {
    const prompts = store();
    const draft = prompts.createDraft({ roleId: "correctness", body: "Focus: leaked secrets in logs.", createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    const fixture = prompts.saveFixture({
      name: "leak",
      prMeta: { repo: "acme/widgets", prNumber: 1 },
      diff,
      expectations: [{ severity: "high", category: "correctness" }],
      savedBy: "octocat",
      acknowledged: true,
    });
    if (!("fixture" in fixture)) throw new Error("fixture failed");

    const opencode = {
      async run() {
        return {
          stdout: JSON.stringify({
            schema_version: 1,
            reviewer: "correctness",
            verdict: "findings",
            findings: [
              { severity: "high", confidence: 0.9, category: "correctness", file: "src/auth.ts", line: 1, summary: "secret logged", reason: "console.log of a secret" },
            ],
            summary: "leak found",
          }),
          stderr: "",
          exitCode: 0,
          text: "",
          usage: { cost: 0.01, totalTokens: 100, complete: true },
        };
      },
    };
    const result = await prompts.evaluatePrompt({
      promptRevisionId: draft.revision.id,
      fixtureId: fixture.fixture.id,
      model: "test/model",
      maxCostUsd: 0.05,
      opencode,
    });
    if (!("evaluation" in result)) throw new Error(result.error);
    if (result.evaluation.status !== "completed") {
      throw new Error(`eval failed: ${result.evaluation.error}`);
    }
    expect(result.evaluation.status).toBe("completed");
    const findings = JSON.parse(result.evaluation.findings_json ?? "[]") as Array<{ severity: string }>;
    expect(findings[0]?.severity).toBe("high");
    const signals = evaluationSignals(findings, [{ severity: "high", category: "correctness" }]);
    expect(signals).toEqual({ matched: 1, missed: 0, unexpected: 0 });
  });

  it("records failures for runner errors, budget breaches, and invalid output", async () => {
    const prompts = store();
    const draft = prompts.createDraft({ roleId: "correctness", body: "Focus: anything.", createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    const fixture = prompts.saveFixture({
      name: "f", prMeta: {}, diff, savedBy: "octocat", acknowledged: true,
    });
    if (!("fixture" in fixture)) throw new Error("fixture failed");

    const failing = await prompts.evaluatePrompt({
      promptRevisionId: draft.revision.id,
      fixtureId: fixture.fixture.id,
      model: "test/model",
      opencode: failingOpencode(),
    });
    expect("evaluation" in failing && failing.evaluation.status).toBe("failed");

    const budget = await prompts.evaluatePrompt({
      promptRevisionId: draft.revision.id,
      fixtureId: fixture.fixture.id,
      model: "test/model",
      maxCostUsd: 0.01,
      opencode: {
        async run() {
          return { stdout: "", stderr: "", exitCode: 0, text: "ok", usage: { cost: 1, totalTokens: 1, complete: true } };
        },
      },
    });
    expect("evaluation" in budget && budget.evaluation.error).toContain("budget");

    const invalid = await prompts.evaluatePrompt({
      promptRevisionId: draft.revision.id,
      fixtureId: fixture.fixture.id,
      model: "test/model",
      opencode: { async run() { return { stdout: "not json", stderr: "", exitCode: 0, text: "not json", usage: {} }; } },
    });
    expect("evaluation" in invalid && invalid.evaluation.error).toContain("schema validation");
  });
});

describe("guardrail composition", () => {
  it("keeps guardrails outside editable bodies and composes them at runtime", () => {
    const rolePrompt = `${REVIEWER_GUARDRAILS}\n\nRole id: correctness\nFocus: bugs.`;
    const body = promptBodyFromRolePrompt(rolePrompt);
    expect(body).not.toContain("Do not modify files");
    expect(body).toContain("Role id: correctness");
    expect(composeReviewerPrompt(body)).toBe(rolePrompt);
  });
});
