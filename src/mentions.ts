/** Command mention persona parsing. This is operator-facing command input, not
 * the GitHub App's actual bot login; bot-login detection stays in github/client. */

export interface MentionConfigShape {
  mentionName: string;
  mentionAliases?: readonly string[];
}

const MENTION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

export function normalizeMentionName(raw: string | undefined, fallback = "maomao", envKey = "MAOMAO_MENTION"): string {
  const value = raw?.trim().replace(/^@+/, "").replace(/\[bot\]$/i, "") || fallback;
  if (!MENTION_RE.test(value)) {
    throw new Error(`${envKey} must be a single mention name using letters, numbers, hyphens, or underscores`);
  }
  return value.toLowerCase();
}

export function parseMentionAliases(raw: string | undefined, primary: string): string[] {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.toLowerCase() === "none" || (raw != null && trimmed === "")) return [];
  const values = trimmed
    ? trimmed.split(",").map((value) => value.trim()).filter(Boolean)
    : primary === "maomao"
      ? []
      : ["maomao"];
  const aliases: string[] = [];
  for (const value of values) {
    const alias = normalizeMentionName(value, "", "MAOMAO_MENTION_ALIASES");
    if (alias !== primary && !aliases.includes(alias)) aliases.push(alias);
  }
  return aliases;
}

export function commandMentionNames(config: MentionConfigShape): string[] {
  const names = [config.mentionName];
  for (const alias of config.mentionAliases ?? []) {
    if (!names.includes(alias)) names.push(alias);
  }
  return names;
}

export function mentionAlternation(mentions: string | readonly string[]): string {
  const names = (Array.isArray(mentions) ? mentions : [mentions])
    .map((mention) => mention.replace(/^@+/, "").replace(/\[bot\]$/i, ""))
    .filter(Boolean);
  if (names.length === 0) return "(?!)";
  return names.map(escapeRegExp).join("|");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
