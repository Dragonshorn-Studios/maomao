import type { SqliteDb } from "../db.js";
import { THEME_PACKS, UI_FLAVORS, type StoredInstanceBranding, type UiFlavor, type UiThemePack } from "../branding.js";
import { nowIso } from "../util.js";

interface Row {
  theme_pack: string;
  copy_flavor: string;
  name: string;
  tagline: string;
  description: string;
  updated_at: string;
}

function clean(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/[\r\n]/.test(text)) throw new Error("Branding text must be a single line.");
  if (text.length > maxLength) throw new Error(`Branding text must be at most ${maxLength} characters.`);
  return text;
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase() as T;
  if (!(choices as readonly string[]).includes(normalized)) throw new Error(`Choose a valid ${label}.`);
  return normalized;
}

/** Instance-wide operator branding. Environment variables remain authoritative field-by-field. */
export class UiSettingsStore {
  constructor(private readonly db: SqliteDb) {}

  stored(): StoredInstanceBranding {
    const row = this.db.prepare("SELECT * FROM ui_settings WHERE id = 1").get() as Row | undefined;
    if (!row) return {};
    return {
      themePack: (THEME_PACKS as readonly string[]).includes(row.theme_pack) ? (row.theme_pack as UiThemePack) : undefined,
      copyFlavor: (UI_FLAVORS as readonly string[]).includes(row.copy_flavor) ? (row.copy_flavor as UiFlavor) : undefined,
      name: row.name || undefined,
      tagline: row.tagline || undefined,
      description: row.description || undefined,
    };
  }

  hasStored(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM ui_settings WHERE id = 1").get());
  }

  save(input: StoredInstanceBranding): { ok: true } | { ok: false; error: string } {
    try {
      const themePack = choice(input.themePack, THEME_PACKS, "theme pack") ?? "";
      const copyFlavor = choice(input.copyFlavor, UI_FLAVORS, "copy flavor") ?? "";
      const name = clean(input.name, 80) ?? "";
      const tagline = clean(input.tagline, 120) ?? "";
      const description = clean(input.description, 240) ?? "";
      this.db.prepare(
        `INSERT INTO ui_settings (id, theme_pack, copy_flavor, name, tagline, description, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           theme_pack = excluded.theme_pack,
           copy_flavor = excluded.copy_flavor,
           name = excluded.name,
           tagline = excluded.tagline,
           description = excluded.description,
           updated_at = excluded.updated_at`,
      ).run(themePack, copyFlavor, name, tagline, description, nowIso());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  clear(): { removed: boolean } {
    const result = this.db.prepare("DELETE FROM ui_settings WHERE id = 1").run();
    return { removed: result.changes > 0 };
  }
}
