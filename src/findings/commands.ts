export type DismissToken = "ignore" | "bury" | "seedling";
export type OverrideVerb = DismissToken | "reopen";

export interface ParsedOverrideCommand {
  command: "dismiss" | "reopen";
  token: OverrideVerb;
}

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export function hasOverridePermission(permission: string | undefined): boolean {
  return WRITE_PERMISSIONS.has((permission ?? "").trim().toLowerCase());
}

export function parseOverrideCommand(raw: string): ParsedOverrideCommand | undefined {
  const collapsed = normalizeCommentBody(raw);
  if (!collapsed) return undefined;
  if (isSeedlingOnly(collapsed)) {
    return { command: "dismiss", token: "seedling" };
  }
  const mention = collapsed.match(/^@maomao(?:\[bot\])?\s+(ignore|bury|reopen)\s*[.!?]?\s*$/i);
  if (!mention?.[1]) return undefined;
  const verb = mention[1].toLowerCase() as OverrideVerb;
  if (verb === "reopen") return { command: "reopen", token: "reopen" };
  return { command: "dismiss", token: verb };
}

export function normalizeCommentBody(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/^>\s?/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSeedlingOnly(value: string): boolean {
  return value.replace(/\uFE0F/g, "").trim() === "🌱";
}
