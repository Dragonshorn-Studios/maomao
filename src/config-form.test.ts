import { describe, expect, it } from "vitest";
import {
  applyProfileAction,
  decodeProfileAction,
  decodeProfileForm,
  initialProfileFormValues,
  profileFormToDefinition,
  profileFormValuesFromDefinition,
} from "./config-form.js";

function formBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    editor: "structured",
    action: "save",
    name: "default",
    note: "",
    reviewer_count: "1",
    reviewer_role_0: "correctness",
    reviewer_model_0: "",
    reviewer_timeout_0: "",
    router_model: "",
    min_severity: "info",
    max_cost_usd: "",
    max_tokens: "",
    ...overrides,
  };
}

describe("decodeProfileForm", () => {
  it("reads indexed reviewer rows and scalar fields", () => {
    const values = decodeProfileForm(
      formBody({
        reviewer_count: "2",
        reviewer_role_1: "security",
        reviewer_model_1: "test/model",
        reviewer_timeout_1: "120",
      }),
    );
    expect(values.name).toBe("default");
    expect(values.reviewers).toEqual([
      { role: "correctness", model: "", timeoutSeconds: "" },
      { role: "security", model: "test/model", timeoutSeconds: "120" },
    ]);
  });

  it("clamps hostile row counts and ignores non-numeric values", () => {
    const values = decodeProfileForm(formBody({ reviewer_count: "999", name: ["x"] }));
    // Clamped to PROFILE_MAX_REVIEWERS; non-string scalars read as empty.
    expect(values.reviewers).toHaveLength(12);
    expect(values.name).toBe("");
  });
});

describe("decodeProfileAction", () => {
  it("parses every action button encoding", () => {
    expect(decodeProfileAction(formBody({ action: "save" }))).toEqual({ kind: "save" });
    expect(decodeProfileAction(formBody({ action: "add" }))).toEqual({ kind: "add" });
    expect(decodeProfileAction(formBody({ action: "remove:1" }))).toEqual({ kind: "remove", index: 1 });
    expect(decodeProfileAction(formBody({ action: "up:2" }))).toEqual({ kind: "up", index: 2 });
    expect(decodeProfileAction(formBody({ action: "down:0" }))).toEqual({ kind: "down", index: 0 });
    // Malformed indexes fall back to save (no crash, no misapplied row edit).
    // Out-of-range and malformed actions are noops, never saves.
    expect(decodeProfileAction(formBody({ action: "remove:x" }))).toEqual({ kind: "noop" });
    expect(decodeProfileAction(formBody({ action: "remove" }))).toEqual({ kind: "noop" });
    expect(decodeProfileAction(formBody({ action: "up:0" }))).toEqual({ kind: "noop" });
    expect(decodeProfileAction({})).toEqual({ kind: "save" });
  });
});

describe("applyProfileAction", () => {
  it("add preselects an unused known role", () => {
    const values = applyProfileAction(
      { ...initialProfileFormValues(), reviewers: [{ role: "correctness", model: "", timeoutSeconds: "" }] },
      { kind: "add" },
      ["correctness", "security", "tests"],
    );
    expect(values.reviewers.map((row) => row.role)).toEqual(["correctness", "security"]);
  });

  it("add caps at 12 rows", () => {
    let values = initialProfileFormValues();
    values = { ...values, reviewers: Array.from({ length: 12 }, (_, index) => ({ role: `r${index}`, model: "", timeoutSeconds: "" })) };
    const capped = applyProfileAction(values, { kind: "add" }, ["extra"]);
    expect(capped.reviewers).toHaveLength(12);
  });

  it("remove and reorder mutate only the targeted rows", () => {
    const values = {
      ...initialProfileFormValues(),
      reviewers: [
        { role: "a", model: "", timeoutSeconds: "" },
        { role: "b", model: "", timeoutSeconds: "" },
        { role: "c", model: "", timeoutSeconds: "" },
      ],
    };
    const roles = ["correctness", "security", "tests"];
    expect(applyProfileAction(values, { kind: "remove", index: 1 }, roles).reviewers.map((row) => row.role)).toEqual(["a", "c"]);
    expect(applyProfileAction(values, { kind: "down", index: 0 }, roles).reviewers.map((row) => row.role)).toEqual(["b", "a", "c"]);
    expect(applyProfileAction(values, { kind: "up", index: 2 }, roles).reviewers.map((row) => row.role)).toEqual(["a", "c", "b"]);
    // Out-of-bounds moves are no-ops.
    expect(applyProfileAction(values, { kind: "down", index: 2 }, roles).reviewers.map((row) => row.role)).toEqual(["a", "b", "c"]);
  });
});

describe("profileFormToDefinition", () => {
  it("round-trips the full schema: reviewers with model and timeout seconds → ms", () => {
    const values = decodeProfileForm(
      formBody({
        name: "strict",
        note: "tightened",
        reviewer_count: "2",
        reviewer_role_0: "correctness",
        reviewer_model_0: "test/model",
        reviewer_timeout_0: "120",
        reviewer_role_1: "security",
        router_model: "test/router",
        min_severity: "low",
        max_cost_usd: "1.5",
        max_tokens: "500000",
      }),
    );
    const result = profileFormToDefinition(values);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.definition).toEqual({
      name: "strict",
      reviewers: [
        { role: "correctness", model: "test/model", timeoutMs: 120000 },
        { role: "security" },
      ],
      minPublishableSeverity: "low",
      routerModel: "test/router",
      maxTotalCostUsd: 1.5,
      maxTotalTokens: 500000,
      onBudgetExceeded: "degrade",
    });
  });

  it("drops fully empty reviewer rows and omits blank optionals", () => {
    const result = profileFormToDefinition(
      decodeProfileForm(
        formBody({
          reviewer_count: "2",
          reviewer_role_0: "correctness",
          reviewer_role_1: "",
          reviewer_model_1: "",
          reviewer_timeout_1: "",
        }),
      ),
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.definition).toEqual({
      name: "default",
      reviewers: [{ role: "correctness" }],
      minPublishableSeverity: "info",
      onBudgetExceeded: "degrade",
    });
  });

  it("maps zod issues back to field keys, including indexed reviewer rows", () => {
    const result = profileFormToDefinition(
      decodeProfileForm(
        formBody({
          name: "Invalid Name",
          reviewer_count: "2",
          reviewer_role_0: "correctness",
          reviewer_model_0: "no slash model",
          reviewer_timeout_0: "-5",
          reviewer_role_1: "nobody",
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.name).toContain("lowercase");
    expect(result.errors.reviewer_model_0).toContain("provider/model");
    expect(result.errors.reviewer_role_1).toContain("unknown specialist role");
    expect(result.errors.reviewer_timeout_0).toContain("positive number of seconds");
    expect(result.errors.form).toBeTruthy();
  });

  it("accepts a timeout at the schema maximum but not beyond it", () => {
    const maxOk = profileFormToDefinition(decodeProfileForm(formBody({ reviewer_timeout_0: "1800" })));
    expect(maxOk).toMatchObject({ ok: true });
    const tooBig = profileFormToDefinition(decodeProfileForm(formBody({ reviewer_timeout_0: "1801" })));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.errors.reviewer_timeout_0).toBeTruthy();
  });

  it("maps the budget behavior select onto the schema (unknown values degrade)", () => {
    const fail = profileFormToDefinition(decodeProfileForm(formBody({ budget_behavior: "fail" })));
    expect(fail).toMatchObject({ ok: true });
    if (fail.ok) expect(fail.definition).toMatchObject({ onBudgetExceeded: "fail" });
    const unknown = decodeProfileForm(formBody({ budget_behavior: "explode" }));
    expect(unknown.budgetBehavior).toBe("degrade");
  });
});

describe("review-pass fixes", () => {
  it("maps zod errors through blank-row compaction to the row the operator sees", () => {
    const result = profileFormToDefinition(
      decodeProfileForm(
        formBody({
          reviewer_count: "3",
          reviewer_role_0: "",
          reviewer_role_1: "nobody",
          reviewer_model_1: "no slash model",
          reviewer_role_2: "correctness",
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Errors land on form rows 1 and 2 — not shifted onto the blank row 0.
    expect(result.errors.reviewer_role_1).toContain("unknown specialist role");
    expect(result.errors.reviewer_model_1).toContain("provider/model");
    expect(result.errors.reviewer_role_0).toBeUndefined();
  });

  it("keeps invalid cost/token inputs as field errors instead of silently dropping them", () => {
    const result = profileFormToDefinition(
      decodeProfileForm(formBody({ max_cost_usd: "abc", max_tokens: "1.5" })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.max_cost_usd).toContain("positive number");
    expect(result.errors.max_tokens).toContain("positive whole number");
  });

  it("round-trips non-second-aligned timeouts exactly (definition → form → definition)", () => {
    const definition = {
      name: "default",
      reviewers: [{ role: "correctness", timeoutMs: 901234 }],
      minPublishableSeverity: "info",
      onBudgetExceeded: "degrade",
    };
    const form = profileFormValuesFromDefinition(definition, null);
    // Exact decimal seconds, never rounded.
    expect(form.reviewers[0]?.timeoutSeconds).toBe("901.234");
    const back = profileFormToDefinition(form);
    expect(back).toMatchObject({ ok: true });
    if (!back.ok) return;
    expect(back.definition).toEqual(definition);
  });
});

describe("review-bot round-2 medium fixes", () => {
  it("rejects a save whose only reviewer row is fully blank (no reviewers: [] drafts)", () => {
    const result = profileFormToDefinition(
      decodeProfileForm(formBody({ reviewer_count: "1", reviewer_role_0: "" })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.form).toContain("At least one reviewer row is required");
  });

  it("treats an out-of-range move as a no-op, never an undefined swap", () => {
    const oneRow = {
      ...initialProfileFormValues(),
      reviewers: [{ role: "correctness", model: "", timeoutSeconds: "" }],
    };
    const moved = applyProfileAction(oneRow, { kind: "up", index: 1 }, ["correctness"]);
    expect(moved).toEqual(oneRow);
    const movedDown = applyProfileAction(oneRow, { kind: "down", index: 5 }, ["correctness"]);
    expect(movedDown).toEqual(oneRow);
    // Every row stays a real value — a render would never see undefined.
    expect(moved.reviewers.every((row) => row != null && typeof row.role === "string")).toBe(true);
  });
});
