import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { MergeModeSettingsStore } from "./settings.js";

describe("MergeModeSettingsStore", () => {
  it("defaults to manual, prefers exact repository rules, and audits changes", () => {
    const db = openDb(":memory:");
    const store = new MergeModeSettingsStore(db);
    expect(store.effective({ provider: "github", instance: "github.com", repoFullName: "acme/widgets" })).toBe("manual");
    expect(store.save({ mergeMode: "disabled", actor: "octocat" })).toEqual({ ok: true });
    expect(store.effective({ provider: "github", instance: "github.com", repoFullName: "acme/widgets" })).toBe("disabled");
    expect(store.save({ provider: "github", providerInstance: "github.com", repoFullName: "acme/widgets", mergeMode: "github_native_queue", actor: "octocat" })).toEqual({ ok: true });
    expect(store.effective({ provider: "github", instance: "github.com", repoFullName: "Acme/Widgets" })).toBe("github_native_queue");
    expect(store.effective({ provider: "forgejo", instance: "forgejo.example.com", repoFullName: "acme/widgets" })).toBe("disabled");
    expect((db.prepare("SELECT COUNT(*) AS count FROM config_audit").get() as { count: number }).count).toBe(2);
  });

  it("validates scope and mode without storing partial rules", () => {
    const store = new MergeModeSettingsStore(openDb(":memory:"));
    expect(store.save({ provider: "github", mergeMode: "manual" })).toMatchObject({ ok: false });
    expect(store.save({ provider: "github", providerInstance: "github.com", repoFullName: "bad", mergeMode: "manual" })).toMatchObject({ ok: false });
    expect(store.save({ mergeMode: "sometimes" })).toMatchObject({ ok: false });
    expect(store.save({ mergeMode: "github_native_queue" })).toMatchObject({ ok: false });
    expect(store.save({ provider: "forgejo", providerInstance: "forgejo.example.com", repoFullName: "acme/widgets", mergeMode: "github_native_queue" })).toMatchObject({ ok: false });
    expect(store.list()).toEqual([]);
  });

  it("updates and clears rules with audit rows", () => {
    const db = openDb(":memory:");
    const store = new MergeModeSettingsStore(db);
    store.save({ mergeMode: "manual", actor: "a" });
    store.save({ mergeMode: "disabled", actor: "b" });
    const rule = store.list()[0];
    expect(rule).toMatchObject({ mergeMode: "disabled", updatedBy: "b" });
    expect(store.clear(rule!.id, "b")).toEqual({ removed: true });
    expect(store.effective({})).toBe("manual");
    const actions = db.prepare("SELECT action, actor FROM config_audit ORDER BY id").all() as Array<{ action: string; actor: string }>;
    expect(actions.map((row) => row.action)).toEqual(["merge_mode_saved", "merge_mode_saved", "merge_mode_cleared"]);
  });
});
