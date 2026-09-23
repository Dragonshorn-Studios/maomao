import { escapeHtml } from "../util.js";

export interface ModelPickerEntry {
  /** `provider/model` id; ids without a slash land in the "other" group. */
  id: string;
  /** Provenance note rendered after the id (e.g. "key configured"). */
  hint?: string;
}

/**
 * Provider-grouped `<select>` for choosing a model id — used by every model
 * edit field (profile reviewer overrides, router model, prompt evaluation).
 * `provider/model` entries group under an `<optgroup>` per provider in
 * first-seen order; a saved value not present in `models` stays selectable as
 * a marked "custom" option so existing profiles remain editable.
 *
 * When `models` is empty the control degrades to a plain text input — a
 * select with no choices would make the field impossible to set (e.g. no
 * MODEL_CATALOG and live discovery unavailable).
 */
export function modelPicker(options: {
  name: string;
  value: string;
  models: ModelPickerEntry[];
  /** Empty-option label for optional fields; omit it for required ones. */
  emptyLabel?: string;
  /** Placeholder for the text-input fallback. */
  placeholder?: string;
  /** Extra attributes on the control, already escaped (e.g. aria-invalid). */
  attrs?: string;
}): string {
  const attrs = options.attrs ? ` ${options.attrs}` : "";
  if (options.models.length === 0) {
    return `<input name="${escapeHtml(options.name)}" value="${escapeHtml(options.value)}" placeholder="${escapeHtml(options.placeholder ?? "provider/model")}"${attrs}/>`;
  }
  const known = new Set(options.models.map((entry) => entry.id));
  const groups = new Map<string, ModelPickerEntry[]>();
  for (const entry of options.models) {
    const slash = entry.id.indexOf("/");
    const provider = slash > 0 ? entry.id.slice(0, slash) : "other";
    const list = groups.get(provider) ?? [];
    list.push(entry);
    groups.set(provider, list);
  }
  const emptyOption =
    options.emptyLabel !== undefined ? `<option value="">${escapeHtml(options.emptyLabel)}</option>` : "";
  const customOption =
    options.value !== "" && !known.has(options.value)
      ? `<option value="${escapeHtml(options.value)}" selected>${escapeHtml(options.value)} (custom)</option>`
      : "";
  const groupHtml = [...groups.entries()]
    .map(
      ([provider, list]) =>
        `<optgroup label="${escapeHtml(provider)}">${list
          .map(
            (entry) =>
              `<option value="${escapeHtml(entry.id)}"${entry.id === options.value ? " selected" : ""}>${escapeHtml(entry.id)}${entry.hint ? ` (${escapeHtml(entry.hint)})` : ""}</option>`,
          )
          .join("")}</optgroup>`,
    )
    .join("");
  return `<select name="${escapeHtml(options.name)}"${attrs}>${emptyOption}${customOption}${groupHtml}</select>`;
}
