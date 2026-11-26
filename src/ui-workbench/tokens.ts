/**
 * The app's design tokens, parsed from the two-layer theme CSS.
 *
 * The vendored Infernal SaaS stylesheet (`src/ui/infernal.ts`) supplies the
 * base token machinery: `:root` holds dark values, blocks keyed on
 * `[data-if-theme="light"]` carry light overrides, and `[data-if-brand]`
 * blocks carry brand accents. `src/ui/theme.ts` composes the active pack (the
 * gallery documents unconfigured apothecary) and then aliases
 * its historical token names onto the `--if-*` values in a single
 * theme-independent `:root` block — an alias like `--paper: var(--if-bg)`
 * resolves to a different hex per theme because the `--if-*` token it points
 * at does. The parser therefore reads both stylesheets as one document and
 * resolves `var()` chains inside each theme's merged map.
 */
import { INFERNAL_CSS } from "../ui/infernal.js";
import { THEME_CSS } from "../ui/theme.js";

export type TokenKind = "color" | "font" | "space" | "other";

export interface DesignToken {
  /** The token name without the leading dashes, e.g. `paper`. */
  name: string;
  /** The raw CSS value in the light theme. */
  light: string;
  /** The raw CSS value in the dark theme. */
  dark: string;
  /** The light value with `var()` references resolved. */
  resolvedLight: string;
  /** The dark value with `var()` references resolved. */
  resolvedDark: string;
  kind: TokenKind;
}

export interface TokenGroup {
  title: string;
  tokens: DesignToken[];
}

export interface DesignTokens {
  groups: TokenGroup[];
  /** The light token set, as a CSS declaration block body. */
  lightCss: string;
  /** The dark token set, as a CSS declaration block body. */
  darkCss: string;
}

interface CssBlock {
  selector: string;
  body: string;
}

/** The brace that closes the block opened at `open`, or -1. */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Every block in the stylesheet, including the ones nested in at-rules.
 * The selector of a nested block is prefixed with its parent's selector.
 */
function cssBlocks(css: string, prefix = ""): CssBlock[] {
  const blocks: CssBlock[] = [];
  let index = 0;

  while (index < css.length) {
    const open = css.indexOf("{", index);
    if (open < 0) break;
    const close = matchingBrace(css, open);
    if (close < 0) break;

    const selector = css.slice(index, open).trim();
    const body = css.slice(open + 1, close);
    const full = prefix ? `${prefix} ${selector}` : selector;
    blocks.push({ selector: full, body });
    blocks.push(...cssBlocks(body, full));
    index = close + 1;
  }

  return blocks;
}

/** The custom properties declared in a block. */
function cssVars(body: string): Map<string, string> {
  const vars = new Map<string, string>();
  const pattern = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
  let match = pattern.exec(body);

  while (match !== null) {
    vars.set(match[1], match[2].trim());
    match = pattern.exec(body);
  }

  return vars;
}

/**
 * The token sets of the theme, keyed by token name (without dashes).
 *
 * Layering follows the cascade: `:root` blocks (the dark Infernal palette
 * plus the app's theme-independent aliases) first, brand blocks apply to
 * both themes, then the `[data-if-theme]` overrides split the sets. Values
 * stay as declared — `var()` resolution happens per theme afterwards.
 */
function tokenSets(rawCss: string): { light: Map<string, string>; dark: Map<string, string> } {
  // Comments only obscure selector matching (`/* … */:root` never equals
  // `:root`); nothing in a declaration body here needs them preserved.
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = cssBlocks(css);
  const light = new Map<string, string>();
  const dark = new Map<string, string>();

  const apply = (block: CssBlock, target: Map<string, string>) => {
    for (const [name, value] of cssVars(block.body)) target.set(name, value);
  };
  // Infernal declares its dark palette on `:root, [data-if-theme="dark"]` —
  // a comma selector that is also the theme-independent default — so the
  // base layer is any block mentioning a bare `:root` part, not a selector
  // that merely ends in one. Themed overrides re-apply on top of it.
  const isRoot = (selector: string) => selector.split(",").some((part) => part.trim() === ":root");
  const themed = (selector: string) => /data-if-theme="(light|dark)"/.exec(selector)?.[1];

  const rooted = new Set<CssBlock>();
  for (const block of blocks) {
    if (isRoot(block.selector)) {
      apply(block, light);
      apply(block, dark);
      rooted.add(block);
    }
  }
  // The token gallery documents the unconfigured apothecary pack: competing
  // brand blocks are unreachable in that cascade, not alternatives.
  const brandReachable = (selector: string) =>
    // :not([data-if-theme]) blocks are no-JS fallbacks, not an additional
    // cascade layer in the explicit light/dark token sets.
    !selector.includes(":not([data-if-theme])") &&
    (!selector.includes("data-if-brand") ||
      selector.includes('data-if-brand="apothecary"') ||
      (!selector.includes('data-if-brand="mergehenna"') && !selector.includes('data-if-brand="machine"')));
  for (const block of blocks) {
    // Brand blocks without a theme selector apply in both themes.
    if (brandReachable(block.selector) && block.selector.includes("data-if-brand") && !themed(block.selector)) {
      apply(block, light);
      apply(block, dark);
    }
  }
  for (const block of blocks) {
    if (rooted.has(block) || !brandReachable(block.selector)) continue;
    const theme = themed(block.selector);
    if (theme === "light") apply(block, light);
    if (theme === "dark") apply(block, dark);
  }

  return { light, dark };
}

/** Resolves a `var(--x)` chain to the literal value it stands for. */
function resolveVar(name: string, vars: Map<string, string>, seen = new Set<string>()): string {
  if (seen.has(name)) return "";
  seen.add(name);

  const raw = vars.get(name);
  if (raw === undefined) return "";

  const reference = /^var\(\s*--([a-zA-Z0-9_-]+)\s*\)$/.exec(raw);
  if (!reference) return raw;

  return resolveVar(reference[1], vars, seen);
}

const COLOR_VALUE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/i;

/** Classifies a token by what it holds, not by what it is called. */
function classify(name: string, resolved: string): TokenKind {
  if (COLOR_VALUE.test(resolved)) return "color";
  if (name.startsWith("font-")) return "font";
  if (name.startsWith("space-") || name === "radius" || name === "measure") return "space";
  return "other";
}

function declarations(vars: Map<string, string>): string {
  return [...vars.entries()].map(([name, value]) => `  --${name}: ${value};`).join("\n");
}

/**
 * Parses the theme into the tokens the workbench renders.
 *
 * The result is deterministic: the same CSS always yields the same tokens in
 * the same order.
 */
export function designTokens(css: string = `${INFERNAL_CSS}\n${THEME_CSS}`): DesignTokens {
  const { light, dark } = tokenSets(css);

  // A token the dark set does not redeclare keeps its light value.
  const mergedDark = new Map(light);
  for (const [name, value] of dark) mergedDark.set(name, value);

  const names = [...new Set([...light.keys(), ...dark.keys()])].sort();
  const groups: TokenGroup[] = [
    { title: "Colors", tokens: [] },
    { title: "Typography", tokens: [] },
    { title: "Spacing & sizing", tokens: [] },
    { title: "Effects & other", tokens: [] },
  ];

  for (const name of names) {
    const lightValue = light.get(name) ?? "";
    const darkValue = mergedDark.get(name) ?? "";
    const resolvedLight = resolveVar(name, light);
    const resolvedDark = resolveVar(name, mergedDark);
    const kind = classify(name, resolvedLight || resolvedDark);

    const token: DesignToken = { name, light: lightValue, dark: darkValue, resolvedLight, resolvedDark, kind };
    const group =
      kind === "color"
        ? groups[0]
        : kind === "font"
          ? groups[1]
          : kind === "space"
            ? groups[2]
            : groups[3];
    group.tokens.push(token);
  }

  return {
    groups: groups.filter((group) => group.tokens.length > 0),
    lightCss: declarations(light),
    darkCss: declarations(mergedDark),
  };
}
