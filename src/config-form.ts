import { profileDefinitionSchema, PROFILE_MAX_TIMEOUT_MS } from "./config-revisions.js";

/**
 * Structured-profile-form boundary: decodes the flat, no-JS form encoding
 * (indexed reviewer rows, action buttons) into a definition object, and maps
 * zod validation issues back to individual form fields so the editor can
 * show errors next to the control that caused them. The strict
 * profileDefinitionSchema stays the enforcement layer — this module only
 * converts representations (blank strings to absent optionals, timeout
 * seconds to milliseconds).
 *
 * Form field contract:
 *   editor                 "structured"
 *   action                 save | add | remove:<i> | up:<i> | down:<i>
 *   name                   profile name
 *   note                   free-text revision note
 *   reviewer_count         number of reviewer rows rendered
 *   reviewer_role_<i>      known role id (may be "" for an empty row)
 *   reviewer_model_<i>     optional provider/model
 *   reviewer_timeout_<i>   optional timeout in SECONDS (schema stores ms)
 *   router_model           optional provider/model
 *   min_severity           severity enum value
 *   max_cost_usd           optional positive number
 *   max_tokens             optional positive integer
 */

export interface ReviewerRowValues {
  role: string;
  model: string;
  timeoutSeconds: string;
}

export interface ProfileFormValues {
  name: string;
  note: string;
  reviewers: ReviewerRowValues[];
  routerModel: string;
  minSeverity: string;
  maxCostUsd: string;
  maxTokens: string;
}

export type ProfileFormAction =
  | { kind: "save" }
  | { kind: "add" }
  | { kind: "remove"; index: number }
  | { kind: "up"; index: number }
  | { kind: "down"; index: number };

/** Field keys the renderer understands; zod paths map onto these. */
export type ProfileFieldKey =
  | "name"
  | `reviewer_model_${number}`
  | `reviewer_role_${number}`
  | `reviewer_timeout_${number}`
  | "router_model"
  | "min_severity"
  | "max_cost_usd"
  | "max_tokens";

export type ProfileFieldErrors = { form?: string } & {
  [K in string]?: string;
};

export const emptyProfileForm = (): ProfileFormValues => ({
  name: "",
  note: "",
  reviewers: [{ role: "", model: "", timeoutSeconds: "" }],
  routerModel: "",
  minSeverity: "info",
  maxCostUsd: "",
  maxTokens: "",
});

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asIndex = (value: unknown): number => {
  const parsed = Number(asString(value));
  return Number.isSafeInteger(parsed) ? parsed : -1;
};

/** Reads the structured form into raw string values (no validation). */
export function decodeProfileForm(body: Record<string, unknown>): ProfileFormValues {
  const count = Math.max(0, Math.min(asIndex(body.reviewer_count) || 0, 12));
  const reviewers: ReviewerRowValues[] = [];
  for (let index = 0; index < count; index += 1) {
    reviewers.push({
      role: asString(body[`reviewer_role_${index}`]),
      model: asString(body[`reviewer_model_${index}`]),
      timeoutSeconds: asString(body[`reviewer_timeout_${index}`]),
    });
  }
  return {
    name: asString(body.name).trim(),
    note: asString(body.note),
    reviewers,
    routerModel: asString(body.router_model).trim(),
    minSeverity: asString(body.min_severity) || "info",
    maxCostUsd: asString(body.max_cost_usd).trim(),
    maxTokens: asString(body.max_tokens).trim(),
  };
}

/** Reads which action button was clicked. Unknown/missing → save. */
export function decodeProfileAction(body: Record<string, unknown>): ProfileFormAction {
  const raw = asString(body.action);
  const [kind, indexRaw] = raw.split(":");
  const index = asIndex(indexRaw);
  if (kind === "add") return { kind: "add" };
  if (kind === "remove" && index >= 0) return { kind: "remove", index };
  if (kind === "up" && index > 0) return { kind: "up", index };
  if (kind === "down" && index >= 0) return { kind: "down", index };
  return { kind: "save" };
}

/** Applies a structural action to the values, returning the next form state. */
export function applyProfileAction(
  values: ProfileFormValues,
  action: ProfileFormAction,
  knownRoleIds: readonly string[],
): ProfileFormValues {
  if (action.kind === "add") {
    if (values.reviewers.length >= 12) return values;
    // Preselect the first known role not already in the list, else empty.
    const used = new Set(values.reviewers.map((row) => row.role).filter(Boolean));
    const free = knownRoleIds.find((role) => !used.has(role)) ?? "";
    return {
      ...values,
      reviewers: [...values.reviewers, { role: free, model: "", timeoutSeconds: "" }],
    };
  }
  if (action.kind === "remove") {
    return { ...values, reviewers: values.reviewers.filter((_, index) => index !== action.index) };
  }
  const swap = (a: number, b: number): ProfileFormValues => {
    if (b < 0 || b >= values.reviewers.length) return values;
    const reviewers = [...values.reviewers];
    [reviewers[a], reviewers[b]] = [reviewers[b]!, reviewers[a]!];
    return { ...values, reviewers };
  };
  if (action.kind === "up") return swap(action.index, action.index - 1);
  if (action.kind === "down") return swap(action.index, action.index + 1);
  return values;
}

/** Seconds → schema milliseconds. Blank stays absent (optional field). */
function timeoutToMs(seconds: string): number | undefined | "invalid" {
  if (seconds.trim() === "") return undefined;
  const parsed = Number(seconds);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return "invalid";
  const ms = parsed * 1000;
  if (ms > PROFILE_MAX_TIMEOUT_MS) return "invalid";
  return ms;
}

function optionalString(value: string): string | undefined {
  return value.trim() === "" ? undefined : value.trim();
}

/**
 * Converts raw form values into the definition object the versioned store
 * validates. Blank strings become absent optionals; timeout seconds become
 * milliseconds. On schema failure, zod issues are mapped back to field keys
 * so the renderer can flag the control that caused them; unmappable issues
 * fall back to the form-level error.
 */
export function profileFormToDefinition(
  values: ProfileFormValues,
): { ok: true; definition: unknown } | { ok: false; errors: ProfileFieldErrors } {
  const errors: ProfileFieldErrors = {};
  const reviewers: unknown[] = [];
  values.reviewers.forEach((row, index) => {
    if (row.role === "" && row.model.trim() === "" && row.timeoutSeconds.trim() === "") return;
    const entry: Record<string, unknown> = { role: row.role };
    const model = optionalString(row.model);
    if (model !== undefined) entry.model = model;
    const timeout = timeoutToMs(row.timeoutSeconds);
    if (timeout === "invalid") {
      errors[`reviewer_timeout_${index}`] = "timeout must be a positive whole number of seconds (max 30 minutes)";
    } else if (timeout !== undefined) {
      entry.timeoutMs = timeout;
    }
    reviewers.push(entry);
  });
  const definition: Record<string, unknown> = {
    name: values.name,
    reviewers,
    minPublishableSeverity: values.minSeverity,
  };
  const routerModel = optionalString(values.routerModel);
  if (routerModel !== undefined) definition.routerModel = routerModel;
  if (values.maxCostUsd !== "") {
    const parsed = Number(values.maxCostUsd);
    if (Number.isFinite(parsed) && parsed > 0) definition.maxTotalCostUsd = parsed;
  }
  if (values.maxTokens !== "") {
    const parsed = Number(values.maxTokens);
    if (Number.isSafeInteger(parsed) && parsed > 0) definition.maxTotalTokens = parsed;
  }

  const check = profileDefinitionSchema.safeParse(definition);
  if (!check.success) {
    for (const issue of check.error.issues) {
      const key = zodPathToFieldKey(issue.path);
      if (key && !errors[key]) errors[key] = issue.message;
    }
  }
  // Pre-schema conversion errors (invalid timeouts) must survive even when
  // the stripped definition would parse cleanly.
  if (Object.keys(errors).length > 0) {
    if (!errors.form) errors.form = "Some fields need attention before this profile can be saved.";
    return { ok: false, errors };
  }
  return { ok: true, definition };
}

/** Maps a zod issue path onto the form field that caused it; null for unmappable. */
function zodPathToFieldKey(path: PropertyKey[]): ProfileFieldKey | null {
  if (path.length === 0) return null;
  const [head, index, leaf] = path as [PropertyKey, PropertyKey?, PropertyKey?];
  if (head === "name") return "name";
  if (head === "routerModel") return "router_model";
  if (head === "minPublishableSeverity") return "min_severity";
  if (head === "maxTotalCostUsd") return "max_cost_usd";
  if (head === "maxTotalTokens") return "max_tokens";
  if (head === "reviewers" && typeof index === "number") {
    if (leaf === "model") return `reviewer_model_${index}`;
    if (leaf === "timeoutMs") return `reviewer_timeout_${index}`;
    if (leaf === "role") return `reviewer_role_${index}`;
  }
  return null;
}
