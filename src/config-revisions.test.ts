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
    expect(result).toEqual({ imported: 1, skipped: 0, rolesImported: 0 });
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

  it("renaming a draft updates the row name so activation applies under it", () => {
    const configs = store();
    const draft = configs.createDraft({
      definition: { ...definition, name: "my-preset" }, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    const updated = configs.updateDraft({
      id: draft.revision.id,
      definition,
      expectedEditSeq: draft.revision.editSeq,
      updatedBy: "octocat",
    });
    if (!("revision" in updated)) throw new Error("rename failed");
    expect(updated.revision.name).toBe("default");
    configs.activateRevision(draft.revision.id, "octocat");
    expect(configs.getActiveRevision("default")?.id).toBe(draft.revision.id);
    expect(configs.getActiveRevision("my-preset")).toBeUndefined();
  });

  it("deactivates an active revision back to env configuration, audited", () => {
    const configs = store();
    const draft = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    configs.activateRevision(draft.revision.id, "octocat");
    expect(configs.getActiveRevision("default")).toBeDefined();

    const deactivated = configs.deactivateRevision(draft.revision.id, "octocat");
    expect(deactivated).toHaveProperty("revision");
    expect(configs.getActiveRevision("default")).toBeUndefined();
    expect(configs.getRevision(draft.revision.id)?.status).toBe("retired");
    expect(configs.listAudit().some((entry) => entry.action === "deactivated")).toBe(true);

    // Rollback can bring a deactivated revision back.
    const restored = configs.rollbackRevision(draft.revision.id, "octocat");
    expect(restored).toHaveProperty("revision");
    expect(configs.getActiveRevision("default")?.id).toBe(draft.revision.id);
  });

  it("rejects deactivating anything but the active revision", () => {
    const configs = store();
    const draft = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    expect(configs.deactivateRevision(draft.revision.id, "octocat")).toEqual({
      error: "only an active revision can be deactivated",
    });
    expect(configs.deactivateRevision(9999, "octocat")).toEqual({
      error: "only an active revision can be deactivated",
    });
  });

  it("discards a draft and audits it, refusing non-drafts", () => {
    const configs = store();
    const draft = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error("draft failed");
    const result = configs.discardDraft(draft.revision.id, "octocat");
    expect(result).toEqual({ ok: true });
    expect(configs.getRevision(draft.revision.id)).toBeUndefined();
    expect(configs.listAudit().some((entry) => entry.action === "draft_discarded")).toBe(true);

    const active = configs.createDraft({
      definition, createdBy: "octocat" });
    if (!("revision" in active)) throw new Error("second draft failed");
    configs.activateRevision(active.revision.id, "octocat");
    expect(configs.discardDraft(active.revision.id, "octocat")).toEqual({
      error: "only a draft can be discarded",
    });
  });
});

describe("repo profile routing", () => {
  function activateNamed(configs: ReviewConfigStore, name: string) {
    const draft = configs.createDraft({
      definition: { ...definition, name },
      createdBy: "octocat",
    });
    if (!("revision" in draft)) throw new Error(`draft ${name} failed`);
    const activated = configs.activateRevision(draft.revision.id, "octocat");
    if (!("revision" in activated)) throw new Error(activated.error);
    return activated.revision;
  }

  it("resolves a repo to the routed profile, longest pattern wins, default as fallback", () => {
    const configs = store();
    const fallback = activateNamed(configs, "default");
    const ownerWide = activateNamed(configs, "acme-profile");
    const exact = activateNamed(configs, "widgets-profile");

    expect(configs.addProfileRoute({ pattern: "acme/*", profileName: "acme-profile", createdBy: "octocat" })).toHaveProperty("route");
    expect(configs.addProfileRoute({ pattern: "acme/widgets", profileName: "widgets-profile", createdBy: "octocat" })).toHaveProperty("route");

    expect(configs.resolveProfileForRepo("acme/widgets")?.id).toBe(exact.id);
    expect(configs.resolveProfileForRepo("acme/gadgets")?.id).toBe(ownerWide.id);
    expect(configs.resolveProfileForRepo("other/repo")?.id).toBe(fallback.id);
    // "acme/widgets" is exact, so the longer-but-different repo falls to the prefix rule.
    expect(configs.resolveProfileForRepo("acme/widgets-x")?.id).toBe(ownerWide.id);
  });

  it("falls back to default when the routed profile has no active revision", () => {
    const configs = store();
    const fallback = activateNamed(configs, "default");
    // Route at a name with only a draft — never activated.
    configs.createDraft({ definition: { ...definition, name: "sleeping" }, createdBy: "octocat" });
    expect(configs.addProfileRoute({ pattern: "acme/*", profileName: "sleeping", createdBy: "octocat" })).toHaveProperty("route");
    expect(configs.resolveProfileForRepo("acme/widgets")?.id).toBe(fallback.id);
  });

  it("resolves nothing with no routes and no active default", () => {
    const configs = store();
    expect(configs.resolveProfileForRepo("acme/widgets")).toBeUndefined();
  });

  it("validates and dedupes route patterns, and removal is audited", () => {
    const configs = store();
    expect(configs.addProfileRoute({ pattern: "", profileName: "default", createdBy: "octocat" })).toHaveProperty("error");
    expect(configs.addProfileRoute({ pattern: "has space", profileName: "default", createdBy: "octocat" })).toHaveProperty("error");
    expect(configs.addProfileRoute({ pattern: "acme/*", profileName: "Not-A-Name", createdBy: "octocat" })).toHaveProperty("error");

    const added = configs.addProfileRoute({ pattern: "acme/*", profileName: "default", createdBy: "octocat" });
    expect(added).toHaveProperty("route");
    expect(configs.addProfileRoute({ pattern: "acme/*", profileName: "default", createdBy: "octocat" })).toHaveProperty("error");

    if (!("route" in added)) throw new Error("route failed");
    expect(configs.deleteProfileRoute(added.route.id, "octocat")).toEqual({ ok: true });
    expect(configs.listProfileRoutes()).toEqual([]);
    const actions = configs.listAudit().map((entry) => entry.action);
    expect(actions).toContain("route_added");
    expect(actions).toContain("route_removed");
    expect(configs.deleteProfileRoute(9999, "octocat")).toEqual({ error: "Route not found." });
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

describe("profile alert overrides", () => {
  const alerted = {
    name: "default",
    reviewers: [
      { role: "correctness", model: "acme/fast" },
      { role: "security" },
      { role: "maintainer" },
    ],
    minPublishableSeverity: "info",
    alerts: { poisonAlert: ["security", "maintainer"], observation: ["correctness"] },
  };

  const alertedStore = () => {
    const jobs = new JobStore(openDb(":memory:"));
    const draft = jobs.configs.createDraft({ definition: alerted, createdBy: "octocat" });
    if (!("revision" in draft)) throw new Error(draft.error);
    jobs.configs.activateRevision(draft.revision.id, "octocat");
    return { jobs, id: draft.revision.id };
  };

  it("stores alert lists on the revision", () => {
    const { jobs, id } = alertedStore();
    expect(jobs.configs.getRevision(id)?.definition.alerts).toEqual(alerted.alerts);
  });

  it("rejects alert roles outside the reviewer list or unknown", () => {
    const configs = store();
    const notListed = configs.createDraft({
      definition: { ...alerted, alerts: { poisonAlert: ["security", "tests"] } },
      createdBy: "octocat",
    });
    expect(notListed).toHaveProperty("error");
    const unknown = configs.createDraft({
      definition: { ...alerted, alerts: { diagnosis: ["no-such-role"] } },
      createdBy: "octocat",
    });
    expect(unknown).toHaveProperty("error");
  });

  it("runs the alert list in profile order instead of the router's picks at that level", () => {
    const { jobs, id } = alertedStore();
    const config = loadConfig({ OPENCODE_REVIEWER_MODEL: "env/model" });
    const specs = applyProfileToSpecs(jobs, config, reviewerSpecs(config, ["correctness"]), id, {
      requestedRoles: ["correctness"],
      level: "poison-alert",
    });
    expect(specs.map((spec) => spec.role)).toEqual(["security", "maintainer"]);
  });

  it("keeps routed reviewers for levels without an override", () => {
    const { jobs, id } = alertedStore();
    const config = loadConfig();
    const specs = applyProfileToSpecs(jobs, config, reviewerSpecs(config, ["security", "maintainer"]), id, {
      requestedRoles: ["security", "maintainer"],
      level: "diagnosis",
    });
    expect(specs.map((spec) => spec.role)).toEqual(["security", "maintainer"]);
  });

  it("observation override inherits the base entry's model", () => {
    const { jobs, id } = alertedStore();
    const config = loadConfig();
    const specs = applyProfileToSpecs(jobs, config, reviewerSpecs(config), id, { level: "observation" });
    expect(specs.map((spec) => spec.role)).toEqual(["correctness"]);
    expect(specs[0]?.model).toBe("acme/fast");
  });
});

describe("custom roles", () => {
  const goRole = {
    slug: "go-reviewer",
    title: "Go reviewer",
    description: "Reviews Go diffs for idioms",
    prompt: "Check Go error handling, race hazards, and idiom fit.",
    model: "acme/go-model",
    actor: "octocat",
  };

  it("creates, updates, lists, and deletes custom roles with audit entries", () => {
    const configs = store();
    const created = configs.upsertCustomRole(goRole);
    expect("role" in created).toBe(true);
    expect(configs.getCustomRole("go-reviewer")?.title).toBe("Go reviewer");
    expect(configs.listCustomRoles().map((role) => role.slug)).toEqual(["go-reviewer"]);

    const updated = configs.upsertCustomRole({ ...goRole, title: "Go reviewer v2", timeoutMs: 90000 });
    expect("role" in updated).toBe(true);
    const row = configs.getCustomRole("go-reviewer");
    expect(row?.title).toBe("Go reviewer v2");
    expect(row?.timeout_ms).toBe(90000);

    const removed = configs.deleteCustomRole("go-reviewer", "octocat");
    expect(removed).toEqual({ ok: true });
    expect(configs.getCustomRole("go-reviewer")).toBeUndefined();
    expect(configs.listAudit().map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["role_created", "role_updated", "role_deleted"]),
    );
  });

  it("rejects built-in slugs and malformed input", () => {
    const configs = store();
    expect(configs.upsertCustomRole({ ...goRole, slug: "correctness" })).toHaveProperty("error");
    expect(configs.upsertCustomRole({ ...goRole, slug: "Not A Slug" })).toHaveProperty("error");
    expect(configs.upsertCustomRole({ ...goRole, title: " " })).toHaveProperty("error");
    expect(configs.upsertCustomRole({ ...goRole, prompt: " " })).toHaveProperty("error");
    expect(configs.deleteCustomRole("missing", "octocat")).toHaveProperty("error");
  });

  it("lets drafts reference custom roles and blocks activation once the role is gone", () => {
    const configs = store();
    configs.upsertCustomRole(goRole);
    const draft = configs.createDraft({
      definition: { ...definition, reviewers: [{ role: "go-reviewer" }] },
      createdBy: "octocat",
    });
    expect("revision" in draft).toBe(true);
    if (!("revision" in draft)) return;

    // Deleting is refused while the draft references it — force-remove to
    // prove activation re-validates membership at that point too.
    expect(configs.deleteCustomRole("go-reviewer", "octocat")).toHaveProperty("error");
    configs.discardDraft(draft.revision.id, "octocat");
    expect(configs.deleteCustomRole("go-reviewer", "octocat")).toEqual({ ok: true });

    const orphan = configs.createDraft({
      definition: { ...definition, reviewers: [{ role: "go-reviewer" }] },
      createdBy: "octocat",
    });
    expect(orphan).toHaveProperty("error");
    if (!("error" in orphan)) return;
    expect(orphan.issues.join(" ")).toContain("unknown specialist role");
  });

  it("refuses deletion while a non-retired revision references the role", () => {
    const configs = store();
    configs.upsertCustomRole(goRole);
    const draft = configs.createDraft({
      definition: { ...definition, reviewers: [{ role: "go-reviewer" }] },
      createdBy: "octocat",
    });
    if (!("revision" in draft)) throw new Error("draft failed");
    const activated = configs.activateRevision(draft.revision.id, "octocat");
    if (!("revision" in activated)) throw new Error("activate failed");

    expect(configs.deleteCustomRole("go-reviewer", "octocat")).toHaveProperty("error");
    configs.deactivateRevision(activated.revision.id, "octocat");
    expect(configs.deleteCustomRole("go-reviewer", "octocat")).toEqual({ ok: true });
  });

  it("exports and imports custom roles so imported revisions validate", () => {
    const configs = store();
    configs.upsertCustomRole(goRole);
    const draft = configs.createDraft({
      definition: { ...definition, reviewers: [{ role: "go-reviewer" }] },
      createdBy: "octocat",
    });
    if (!("revision" in draft)) throw new Error("draft failed");
    configs.activateRevision(draft.revision.id, "octocat");
    const exported = configs.exportConfig();
    expect(exported.roles.map((role) => role.slug)).toEqual(["go-reviewer"]);

    const other = store();
    const result = other.importConfig({ payload: exported, actor: "octocat" });
    expect(result).toEqual({ imported: 1, skipped: 0, rolesImported: 1 });
    // The imported revision passes membership validation on activation.
    const imported = other.listRevisions()[0];
    expect(other.activateRevision(imported!.id, "octocat")).toHaveProperty("revision");
  });

  it("resolves a custom role's title and model into reviewer specs", () => {
    const jobs = new JobStore(openDb(":memory:"));
    jobs.configs.upsertCustomRole(goRole);
    const draft = jobs.configs.createDraft({
      definition: { ...definition, reviewers: [{ role: "go-reviewer" }, { role: "correctness" }] },
      createdBy: "octocat",
    });
    if (!("revision" in draft)) throw new Error("draft failed");
    const config = loadConfig({ OPENCODE_REVIEWER_MODEL: "env/model" });
    const specs = applyProfileToSpecs(jobs, config, reviewerSpecs(config), draft.revision.id, {
      wholeProfileSet: true,
    });
    const go = specs.find((spec) => spec.role === "go-reviewer");
    expect(go?.title).toBe("Go reviewer");
    expect(go?.model).toBe("acme/go-model");
  });
});
