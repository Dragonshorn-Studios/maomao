import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { resolveInstanceBranding } from "../branding.js";
import { UiSettingsStore } from "./settings.js";

describe("UiSettingsStore", () => {
  it("persists and clears instance-wide branding", () => {
    const store = new UiSettingsStore(openDb(":memory:"));
    expect(store.save({
      themePack: "mergehenna",
      copyFlavor: "plain",
      name: "Review Desk",
      tagline: "Operator console",
      description: "Instance-local review frontend",
    })).toEqual({ ok: true });
    expect(store.stored()).toEqual({
      themePack: "mergehenna",
      copyFlavor: "plain",
      name: "Review Desk",
      tagline: "Operator console",
      description: "Instance-local review frontend",
    });
    expect(store.hasStored()).toBe(true);
    expect(store.clear()).toEqual({ removed: true });
    expect(store.stored()).toEqual({});
  });

  it("rejects invalid choices and multi-line text", () => {
    const store = new UiSettingsStore(openDb(":memory:"));
    expect(store.save({ themePack: "neon" as never })).toMatchObject({ ok: false });
    expect(store.save({ name: "one\ntwo" })).toMatchObject({ ok: false });
    expect(store.hasStored()).toBe(false);
  });
});

describe("resolveInstanceBranding", () => {
  it("uses stored branding and derives unset copy/text defaults from its theme", () => {
    expect(resolveInstanceBranding({}, {
      themePack: "mergehenna",
      name: "Review Desk",
    })).toMatchObject({
      themePack: "mergehenna",
      copyFlavor: "mergehenna",
      name: "Review Desk",
      tagline: "Merge gate review console",
    });
  });

  it("keeps environment variables authoritative field-by-field", () => {
    expect(resolveInstanceBranding({
      UI_THEME_PACK: "apothecary",
      UI_INSTANCE_NAME: "Env Console",
      UI_FLAVOR: "plain",
    }, {
      themePack: "mergehenna",
      copyFlavor: "mergehenna",
      name: "Stored Console",
      tagline: "Stored tagline",
    })).toMatchObject({
      themePack: "apothecary",
      copyFlavor: "plain",
      name: "Env Console",
      tagline: "Stored tagline",
    });
  });
});
