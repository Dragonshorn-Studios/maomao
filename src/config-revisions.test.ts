import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { loadConfig } from "./config.js";
import {
  ReviewConfigStore,
  envProfileDefinition,
  seedDefaultProfileRevision,
  validateModelCatalog,
  validateProfileDefinition,
} from "./config-revisions.js";
import { JobStore } from "./jobs/store.js";
import { applyProfileToSpecs, reviewerSpecs } from "./jobs/enqueue.js";

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

describe("default profile seed", () => {
  it("seeds a `default` draft mirroring the env configuration, audited as system", () => {
    const configs = store();
    const config = loadConfig({ OPENCODE_REVIEWER_MODEL: "env/model" });
    expect(seedDefaultProfileRevision(configs, config)).toBe(true);
    const draft = configs.listRevisions().find((row) => row.name === "default");
    expect(draft?.status).toBe("draft");
    expect(draft?.created_by).toBe("system");
    expect(draft?.definition.minPublishableSeverity).toBe("info");
    expect(draft?.definition.onBudgetExceeded).toBe("degrade");
    expect(draft?.definition.routerModel).toBe("env/model");
    expect(draft?.definition.reviewers).toHaveLength(config.reviewers.length);
    for (const reviewer of draft?.definition.reviewers ?? []) {
      expect(reviewer.model).toBe("env/model");
    }
    const seededAudit = configs.listAudit().find((entry) => entry.action === "draft_created");
    expect(seededAudit?.actor).toBe("system");
    expect(seededAudit?.revision_id).toBe(draft?.id);
  });

  it("is idempotent — an existing `default` revision is never touched", () => {
    const configs = store();
    const config = loadConfig({});
    expect(seedDefaultProfileRevision(configs, config)).toBe(true);
    expect(seedDefaultProfileRevision(configs, config)).toBe(false);
    expect(configs.listRevisions()).toHaveLength(1);
    // Even when the earlier default was activated or deleted by an operator,
    // the name is enough: seeding never revives a second revision.
    expect(configs.listRevisions()[0]?.status).toBe("draft");
  });

  it("omits models entirely when the env has none (specs fall through like env)", () => {
    const def = envProfileDefinition(loadConfig({}));
    expect(def.reviewers.length).toBeGreaterThan(0);
    expect(def.reviewers.every((reviewer) => reviewer.model === undefined)).toBe(true);
    expect(def.routerModel).toBeUndefined();
  });

  it("activating the untouched v0 revision leaves reviewer specs unchanged", () => {
    const jobs = new JobStore(openDb(":memory:"));
    const config = loadConfig({ OPENCODE_REVIEWER_MODEL: "env/model" });
    expect(seedDefaultProfileRevision(jobs.configs, config)).toBe(true);
    const draft = jobs.configs.listRevisions()[0];
    const activated = jobs.configs.activateRevision(draft.id, "system");
    if (!("revision" in activated)) throw new Error("activate failed");
    const envSpecs = reviewerSpecs(config);
    expect(envSpecs.length).toBeGreaterThan(0);
    expect(applyProfileToSpecs(jobs, config, envSpecs, draft.id)).toEqual(envSpecs);
  });
});
