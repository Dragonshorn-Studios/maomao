/** Instance branding is operator-facing identity; Maomao remains the software/protocol name. */

export type UiThemePack = "apothecary" | "mergehenna";
export type UiFlavor = "apothecary" | "mergehenna" | "plain";

export interface InstanceBranding {
  /** User-visible instance name. */
  name: string;
  tagline: string;
  description: string;
  /** Visual token/icon pack. Independent from the copy flavor. */
  themePack: UiThemePack;
  /** Flavored copy pack, or plain low-flavor copy. */
  copyFlavor: UiFlavor;
}

export const THEME_PACKS: readonly UiThemePack[] = ["apothecary", "mergehenna"];
export const UI_FLAVORS: readonly UiFlavor[] = ["apothecary", "mergehenna", "plain"];

const PACK_DEFAULTS: Record<UiThemePack, { name: string; tagline: string; description: string }> = {
  apothecary: {
    name: "Maomao",
    tagline: "PR examination console",
    description: "Self-hosted multi-agent pull request review powered by OpenCode.",
  },
  mergehenna: {
    name: "Mergehenna",
    tagline: "Merge gate review console",
    description: "Self-hosted multi-agent pull request review, operated by Maomao and powered by OpenCode.",
  },
};

export const DEFAULT_INSTANCE_BRANDING: InstanceBranding = {
  ...PACK_DEFAULTS.apothecary,
  themePack: "apothecary",
  copyFlavor: "apothecary",
};

function parseChoice<T extends string>(raw: string | undefined, choices: readonly T[], fallback: T, envKey: string): T {
  const value = raw?.trim().toLowerCase() ?? "";
  if (!value) return fallback;
  if ((choices as readonly string[]).includes(value)) return value as T;
  throw new Error(`${envKey} must be ${choices.join(", ")}`);
}

function textSetting(raw: string | undefined, fallback: string, envKey: string, maxLength: number): string {
  const value = raw?.trim();
  if (!value) return fallback;
  if (/[\r\n]/.test(value)) throw new Error(`${envKey} must be a single line`);
  if (value.length > maxLength) throw new Error(`${envKey} must be at most ${maxLength} characters`);
  return value;
}

/**
 * Resolves the operator-facing instance identity from environment input.
 * Selecting a theme pack also selects that pack's flavor copy by default;
 * UI_FLAVOR can independently override copy without changing the visual pack.
 */
export function loadInstanceBranding(env: NodeJS.ProcessEnv): InstanceBranding {
  const themePack = parseChoice(env.UI_THEME_PACK, THEME_PACKS, "apothecary", "UI_THEME_PACK");
  const copyFlavor = parseChoice(env.UI_FLAVOR, UI_FLAVORS, themePack, "UI_FLAVOR");
  const defaults = PACK_DEFAULTS[themePack];
  return {
    name: textSetting(env.UI_INSTANCE_NAME, defaults.name, "UI_INSTANCE_NAME", 80),
    tagline: textSetting(env.UI_INSTANCE_TAGLINE, defaults.tagline, "UI_INSTANCE_TAGLINE", 120),
    description: textSetting(env.UI_INSTANCE_DESCRIPTION, defaults.description, "UI_INSTANCE_DESCRIPTION", 240),
    themePack,
    copyFlavor,
  };
}

/** Optional software attribution shown when an instance uses its own persona. */
export function softwareAttribution(brand: InstanceBranding): string {
  return brand.name.trim().toLowerCase() === "maomao" ? "" : "powered by Maomao";
}
