import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { ReviewConfigStore, validateModelCatalog, validateProfileDefinition } from "./config-revisions.js";

function store() {
  return new ReviewConfigStore(openDb(":memory:"));
}

const definition = {
  name: "default",
  reviewers: [{ role: "correctness" }, { role: "security" }],
  minPublishableSeverity: "medium",
};

describe("profile revision lifecycle", () => {
  it("creates a validated draft, activates it, and retires the previous active", () => {
    const configs = store();
    const first = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in first)) throw new Error("draft creation failed");
    const activated = configs.activateRevision(first.revision.id, "octocat");
    if (!("revision" in activated)) throw new Error(activated.error);
    expect(activated.revision.status).toBe("active");

    const second = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in second)) throw new Error("second draft failed");
    const activated2 = configs.activateRevision(second.revision.id, "octocat");
    if (!("revision" in activated2)) throw new Error(activated2.error);
    expect(configs.getRevision(first.revision.id)?.status).toBe("retired");
    expect(configs.getActiveRevision("default")?.id).toBe(second.revision.id);
  });

  it("cannot activate a retired revision directly except via rollback", () => {
    const configs = store();
    const first = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in first)) throw new Error("draft failed");
    configs.activateRevision(first.revision.id, "octocat");
    const second = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in second)) throw new Error("second draft failed");
    configs.activateRevision(second.revision.id, "octocat");
    const rollback = configs.rollbackRevision(first.revision.id, "octocat");
    expect(rollback).toHaveProperty("revision");
    expect(configs.getActiveRevision("default")?.id).toBe(first.revision.id);
  });

  it("rejects activation of an invalid revision", () => {
    const configs = store();
    const bad = { ...definition, reviewers: [] };
    const draft = configs.createDraft({
      definition: bad, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    const result = configs.activateRevision(draft.revision.id, "octocat");
    expect("error" in result).toBe(true);
  });

  it("records audit entries for lifecycle transitions", () => {
    const configs = store();
    const draft = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    configs.activateRevision(draft.revision.id, "octocat");
    const audit = configs.listAudit();
    expect(audit.map((entry) => entry.action)).toEqual(["activated", "draft_created"]);
    expect(audit[0]?.actor).toBe("octocat");
  });

  it("exports and imports definitions without secrets and as drafts only", () => {
    const configs = store();
    const draft = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    configs.activateRevision(draft.revision.id, "octocat");
    const exported = configs.exportConfig();
    expect(exported.schema_version).toBe(1);
    expect(exported.revisions).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toContain("secret");

    const other = store();
    const result = other.importConfig({ payload: exported, actor: "octocat" });
    expect(result).toEqual({ imported: 1, skipped: 0 });
    // Imported revisions are drafts: activation stays explicit.
    expect(other.getActiveRevision("default")).toBeUndefined();
    expect(other.listRevisions()[0]?.status).toBe("draft");
  });
});

describe("draft editing and conflicts", () => {
  it("detects concurrent edits via the expected edit sequence", () => {
    const configs = store();
    const draft = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    const first = configs.updateDraft({
      id: draft.revision.id,
      definition,
      expectedEditSeq: draft.revision.editSeq,
      updatedBy: "alice",
    });
    expect(first).toHaveProperty("revision");
    // Bob saved first; Alice's stale save conflicts.
    const second = configs.updateDraft({
      id: draft.revision.id,
      definition,
      expectedEditSeq: draft.revision.editSeq,
      updatedBy: "bob",
    });
    expect(second).toEqual({ error: "conflict" });
  });

  it("refuses to update a revision that is not a draft", () => {
    const configs = store();
    const draft = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    configs.activateRevision(draft.revision.id, "octocat");
    const result = configs.updateDraft({
      id: draft.revision.id,
      definition,
      expectedEditSeq: draft.revision.editSeq,
      updatedBy: "octocat",
    });
    expect(result).toEqual({ error: "not_found" });
  });
});

describe("profile validation and caps", () => {
  it("rejects unknown roles, oversized caps, and malformed models", () => {
    const configs = store();
    const bad = configs.createDraft({
      definition: {
        name: "default",
        reviewers: [{ role: "not-a-role" }],
        maxTotalCostUsd: 999,
      },
      createdBy: "octocat",
    });
    expect("error" in bad && bad.error === "invalid").toBe(true);
    if (!("error" in bad)) return;
    expect(bad.issues.join(" ")).toContain("unknown specialist role");
    expect(bad.issues.join(" ")).toContain("maxTotalCostUsd");
  });

  it("requires at least one specialist role", () => {
    const issues = validateProfileDefinition({
      name: "default",
      reviewers: [],
      minPublishableSeverity: "info",
      onBudgetExceeded: "degrade",
    });
    expect(issues).toContain("at least one specialist role is required");
  });

  it("enforces the model catalog when one is configured", () => {
    const definition = {
      name: "default",
      reviewers: [{ role: "correctness", model: "openai/gpt-4.1" }],
      minPublishableSeverity: "info" as const,
      onBudgetExceeded: "degrade" as const,
    };
    expect(validateModelCatalog(definition, ["anthropic/claude-sonnet-4-5"])).toHaveLength(1);
    expect(validateModelCatalog(definition, ["openai/gpt-4.1"])).toHaveLength(0);
    expect(validateModelCatalog(definition, [])).toHaveLength(0);
  });

  it("rejects an invalid severity", () => {
    const configs = store();
    const bad = configs.createDraft({
      definition: { ...definition, minPublishableSeverity: "catastrophic" },
      createdBy: "octocat",
    });
    expect("error" in bad && bad.error === "invalid").toBe(true);
  });
});
