import { escapeHtml } from "../util.js";

export interface ModelPickerEntry {
  /** `provider/model` id; ids without a slash land in the "other" group. */
  id: string;
  /** Provenance note rendered after the id (e.g. "key configured"). */
  hint?: string;
}

/**
 * Styled model dropdown — one shared picker for every model edit field
 * (profile reviewer overrides, router model, prompt evaluation). The markup
 * starts as a plain text `<input>`; ${MODEL_PICKER_HREF} upgrades the
 * wrapper with `is-js`, revealing a button + grouped popover that writes
 * picks into the same input. Without JS — or when `models` is empty — the
 * field is still a working free-text control, so nothing regresses.
 *
 * `provider/model` entries group under provider section headers in
 * first-seen order; a saved value not present in `models` stays selectable
 * as a marked "(custom)" option so existing profiles remain editable.
 * `allowCustom` adds a "Type a custom model…" tail option that re-shows the
 * input for arbitrary ids — omitted when a configured MODEL_CATALOG makes
 * off-catalog values unsavable anyway.
 */
export function modelPicker(options: {
  name: string;
  value: string;
  models: ModelPickerEntry[];
  /** Empty-option label for optional fields; omit it for required ones. */
  emptyLabel?: string;
  /** Placeholder for the text input. */
  placeholder?: string;
  /** Offer a "Type a custom model…" tail option (default true). */
  allowCustom?: boolean;
  /** Extra attributes on the control, already escaped (e.g. aria-invalid). */
  attrs?: string;
}): string {
  const attrs = options.attrs ? ` ${options.attrs}` : "";
  const placeholder = options.placeholder ?? "provider/model";
  if (options.models.length === 0) {
    return `<input name="${escapeHtml(options.name)}" value="${escapeHtml(options.value)}" placeholder="${escapeHtml(placeholder)}"${attrs}/>`;
  }
  const entries = [...options.models];
  if (options.value !== "" && !entries.some((entry) => entry.id === options.value)) {
    entries.push({ id: options.value, hint: "custom" });
  }
  const groups = new Map<string, ModelPickerEntry[]>();
  for (const entry of entries) {
    const slash = entry.id.indexOf("/");
    const provider = slash > 0 ? entry.id.slice(0, slash) : "other";
    const list = groups.get(provider) ?? [];
    list.push(entry);
    groups.set(provider, list);
  }
  const optionHtml = (entry: ModelPickerEntry): string => {
    const selected = entry.id === options.value;
    const slash = entry.id.indexOf("/");
    const shortName = slash > 0 ? entry.id.slice(slash + 1) : entry.id;
    const detail = entry.hint ? `${entry.id} · ${entry.hint}` : entry.id;
    return `<span class="model-picker-option" role="option" data-value="${escapeHtml(entry.id)}" data-label="${escapeHtml(entry.id)}" aria-selected="${selected ? "true" : "false"}" tabindex="-1">
      <span class="model-picker-check" aria-hidden="true">✓</span>
      <span class="model-picker-text"><span class="model-picker-name">${escapeHtml(shortName)}</span><span class="model-picker-detail">${escapeHtml(detail)}</span></span>
    </span>`;
  };
  const emptyOption =
    options.emptyLabel !== undefined
      ? `<span class="model-picker-option" role="option" data-value="" data-label="${escapeHtml(options.emptyLabel)}" aria-selected="${options.value === "" ? "true" : "false"}" tabindex="-1"><span class="model-picker-check" aria-hidden="true">✓</span><span class="model-picker-text"><span class="model-picker-name model-picker-empty-label">${escapeHtml(options.emptyLabel)}</span></span></span>`
      : "";
  const groupsHtml = [...groups.entries()]
    .map(
      ([provider, list]) =>
        `<span class="model-picker-group" role="presentation">${escapeHtml(provider)}</span>${list.map(optionHtml).join("")}`,
    )
    .join("");
  const customOption =
    options.allowCustom === false
      ? ""
      : `<span class="model-picker-option model-picker-option-custom" role="option" data-custom data-label="Custom model" aria-selected="false" tabindex="-1"><span class="model-picker-check" aria-hidden="true">✓</span><span class="model-picker-text"><span class="model-picker-name">Type a custom model…</span><span class="model-picker-detail">enter any provider/model id</span></span></span>`;
  const buttonLabel = options.value === "" ? (options.emptyLabel ?? options.value) : options.value;
  return `<span class="model-picker" data-model-picker>
    <input type="text" class="model-picker-input" name="${escapeHtml(options.name)}" value="${escapeHtml(options.value)}" placeholder="${escapeHtml(placeholder)}"${attrs}/>
    <button type="button" class="model-picker-btn" aria-haspopup="listbox" aria-expanded="false"${attrs}>
      <span class="model-picker-label">${escapeHtml(buttonLabel)}</span><span class="model-picker-caret" aria-hidden="true">▾</span>
    </button>
    <span class="model-picker-pop" role="listbox" hidden>${emptyOption}${groupsHtml}${customOption}</span>
  </span>`;
}

/** Deferred script src on pages that render a model picker. */
export const MODEL_PICKER_HREF = "/assets/model-picker.js";

/**
 * Wires every [data-model-picker] control: stamps `is-js` so the button and
 * popover render (the raw input alone serves no-JS use), toggles the
 * popover, picks an option into the text input (button label follows the
 * option's data-label), a `data-custom` option re-shows the input for
 * free-text ids, Escape/outside-click closes, arrows + Enter navigate when
 * open. Plain string (no bundler) so it ships as a static asset; all option
 * text comes from server-rendered attributes, nothing is eval'd.
 */
export const MODEL_PICKER_JS = String.raw`(function () {
  "use strict";

  function options(picker) {
    return Array.prototype.slice.call(picker.querySelectorAll(".model-picker-option"));
  }

  function isOpen(picker) {
    var pop = picker.querySelector(".model-picker-pop");
    return pop && !pop.hidden;
  }

  function open(picker) {
    closeAll();
    var pop = picker.querySelector(".model-picker-pop");
    var btn = picker.querySelector(".model-picker-btn");
    if (!pop || !btn) return;
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    var selected = pop.querySelector('[aria-selected="true"]') || options(picker)[0];
    activate(picker, selected);
  }

  function close(picker) {
    var pop = picker.querySelector(".model-picker-pop");
    var btn = picker.querySelector(".model-picker-btn");
    if (!pop || !btn) return;
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    options(picker).forEach(function (o) { o.classList.remove("is-active"); });
  }

  function closeAll() {
    document.querySelectorAll("[data-model-picker]").forEach(function (p) {
      if (isOpen(p)) close(p);
    });
  }

  function activate(picker, option) {
    options(picker).forEach(function (o) { o.classList.remove("is-active"); });
    if (!option) return;
    option.classList.add("is-active");
    option.scrollIntoView({ block: "nearest" });
  }

  function pick(picker, option) {
    if (!option) return;
    var input = picker.querySelector(".model-picker-input");
    var label = picker.querySelector(".model-picker-label");
    if (option.hasAttribute("data-custom")) {
      picker.classList.add("is-custom");
      if (label) label.textContent = option.getAttribute("data-label") || "Custom model";
      options(picker).forEach(function (o) { o.setAttribute("aria-selected", "false"); });
      close(picker);
      if (input) input.focus();
      return;
    }
    picker.classList.remove("is-custom");
    var value = option.getAttribute("data-value") || "";
    if (input) input.value = value;
    if (label) label.textContent = option.getAttribute("data-label") || value || "";
    options(picker).forEach(function (o) { o.setAttribute("aria-selected", o === option ? "true" : "false"); });
    close(picker);
    picker.querySelector(".model-picker-btn").focus();
  }

  function step(picker, delta) {
    var list = options(picker);
    if (!list.length) return;
    var active = picker.querySelector(".model-picker-option.is-active");
    var index = list.indexOf(active);
    if (index === -1) {
      var selected = picker.querySelector('.model-picker-option[aria-selected="true"]');
      index = Math.max(0, list.indexOf(selected) - (delta > 0 ? 1 : -1));
    }
    index = (index + delta + list.length) % list.length;
    activate(picker, list[index]);
  }

  document.addEventListener("click", function (event) {
    var picker = event.target.closest ? event.target.closest("[data-model-picker]") : null;
    if (!picker) { closeAll(); return; }
    if (event.target.closest(".model-picker-btn")) {
      isOpen(picker) ? close(picker) : open(picker);
      return;
    }
    // Pickers sit inside <label>s: without preventDefault the label forwards
    // a synthesized click to the control, re-toggling the pop after a pick.
    if (event.target.closest(".model-picker-pop")) {
      event.preventDefault();
      var option = event.target.closest(".model-picker-option");
      if (option) pick(picker, option);
    }
  });

  document.addEventListener("keydown", function (event) {
    var picker = event.target.closest ? event.target.closest("[data-model-picker]") : null;
    if (!picker) {
      if (event.key === "Escape") closeAll();
      return;
    }
    if (!isOpen(picker)) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].indexOf(event.key) !== -1 && event.target.closest(".model-picker-btn")) {
        event.preventDefault();
        open(picker);
      }
      return;
    }
    if (event.key === "Escape") {
      close(picker);
      picker.querySelector(".model-picker-btn").focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      step(picker, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      step(picker, -1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(picker, picker.querySelector(".model-picker-option.is-active"));
    } else if (event.key === "Tab") {
      close(picker);
    }
  });

  // Progressive enhancement: reveal the button/popover and hide the raw
  // input once this script has actually run.
  document.querySelectorAll("[data-model-picker]").forEach(function (picker) {
    picker.classList.add("is-js");
  });
})();
`;
