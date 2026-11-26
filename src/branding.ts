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

export const PACK_DEFAULTS: Record<UiThemePack, { name: string; tagline: string; description: string }> = {
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

function firstText(envValue: string | undefined, storedValue: string | undefined, fallback: string, envKey: string, maxLength: number): string {
  if (envValue?.trim()) return textSetting(envValue, fallback, envKey, maxLength);
  if (storedValue?.trim()) return textSetting(storedValue, fallback, envKey, maxLength);
  return fallback;
}

/** Stored operator branding fields; undefined means the theme-pack default applies. */
export type StoredInstanceBranding = Partial<InstanceBranding>;

/**
 * Resolve instance branding with env authoritative over stored operator settings.
 * Env parsing stays strict because loadConfig validates it at boot; stored values
 * are validated before they reach this resolver.
 */
export function resolveInstanceBranding(env: NodeJS.ProcessEnv, stored: StoredInstanceBranding = {}): InstanceBranding {
  const themePack = parseChoice(env.UI_THEME_PACK, THEME_PACKS, stored.themePack ?? "apothecary", "UI_THEME_PACK");
  const copyFlavor = parseChoice(env.UI_FLAVOR, UI_FLAVORS, stored.copyFlavor ?? themePack, "UI_FLAVOR");
  const defaults = PACK_DEFAULTS[themePack];
  return {
    name: firstText(env.UI_INSTANCE_NAME, stored.name, defaults.name, "UI_INSTANCE_NAME", 80),
    tagline: firstText(env.UI_INSTANCE_TAGLINE, stored.tagline, defaults.tagline, "UI_INSTANCE_TAGLINE", 120),
    description: firstText(env.UI_INSTANCE_DESCRIPTION, stored.description, defaults.description, "UI_INSTANCE_DESCRIPTION", 240),
    themePack,
    copyFlavor,
  };
}

/**
 * Resolves the operator-facing instance identity from environment input.
 * Selecting a theme pack also selects that pack's flavor copy by default;
 * UI_FLAVOR can independently override copy without changing the visual pack.
 */
export function loadInstanceBranding(env: NodeJS.ProcessEnv): InstanceBranding {
  return resolveInstanceBranding(env);
}

/** Optional software attribution shown when an instance uses its own persona. */
export function softwareAttribution(brand: InstanceBranding): string {
  return brand.name.trim().toLowerCase() === "maomao" ? "" : "powered by Maomao";
}
