import { describe, expect, it } from "vitest";
import {
  applyProfileAction,
  decodeProfileAction,
  decodeProfileForm,
  emptyProfileForm,
  profileFormToDefinition,
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
    expect(decodeProfileAction(formBody({ action: "remove:x" }))).toEqual({ kind: "save" });
    expect(decodeProfileAction(formBody({ action: "up:0" }))).toEqual({ kind: "save" });
    expect(decodeProfileAction({})).toEqual({ kind: "save" });
  });
});

describe("applyProfileAction", () => {
  it("add preselects an unused known role", () => {
    const values = applyProfileAction(
      { ...emptyProfileForm(), reviewers: [{ role: "correctness", model: "", timeoutSeconds: "" }] },
      { kind: "add" },
      ["correctness", "security", "tests"],
    );
    expect(values.reviewers.map((row) => row.role)).toEqual(["correctness", "security"]);
  });

  it("add caps at 12 rows", () => {
    let values = emptyProfileForm();
    values = { ...values, reviewers: Array.from({ length: 12 }, (_, index) => ({ role: `r${index}`, model: "", timeoutSeconds: "" })) };
    const capped = applyProfileAction(values, { kind: "add" }, ["extra"]);
    expect(capped.reviewers).toHaveLength(12);
  });

  it("remove and reorder mutate only the targeted rows", () => {
    const values = {
      ...emptyProfileForm(),
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
    expect(result.errors.reviewer_timeout_0).toContain("positive whole number");
    expect(result.errors.form).toBeTruthy();
  });

  it("accepts a timeout at the schema maximum but not beyond it", () => {
    const maxOk = profileFormToDefinition(decodeProfileForm(formBody({ reviewer_timeout_0: "1800" })));
    expect(maxOk).toMatchObject({ ok: true });
    const tooBig = profileFormToDefinition(decodeProfileForm(formBody({ reviewer_timeout_0: "1801" })));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.errors.reviewer_timeout_0).toBeTruthy();
  });
});
