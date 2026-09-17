import {
  PROFILE_MAX_REVIEWERS,
  PROFILE_MAX_TIMEOUT_MS,
  profileDefinitionSchema,
} from "./config-revisions.js";

/**
 * Structured-profile-form boundary: decodes the flat, no-JS form encoding
 * (indexed reviewer rows, action buttons) into a definition object, and maps
 * zod validation issues back to individual form fields so the editor can
 * show errors next to the control that caused them. The strict
 * profileDefinitionSchema stays the enforcement layer — this module only
 * converts representations (blank strings to absent optionals, timeout
 * seconds to whole milliseconds).
 *
 * Form field contract:
 *   editor                 "structured"
 *   action                 save | add | remove:<i> | up:<i> | down:<i>
 *   name                   profile name
 *   note                   free-text revision note
 *   reviewer_count         number of reviewer rows rendered
 *   reviewer_role_<i>      known role id (may be "" for an empty row)
 *   reviewer_model_<i>     optional provider/model
 *   reviewer_timeout_<i>   optional timeout in SECONDS (decimals allowed;
 *                          the schema stores whole milliseconds)
 *   router_model           optional provider/model
 *   min_severity           severity enum value
 *   max_cost_usd           optional positive number
 *   max_tokens             optional positive integer
 *
 * Action decoding never falls back to "save": valid-shaped but out-of-range
 * or malformed actions decode to "noop" (a re-render with no persistence),
 * so a boundary click can never persist a half-edited draft.
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
  | { kind: "noop" }
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
  [key: string]: string | undefined;
};

/** The create form's starting values; mirrors the old JSON prefill. */
export function initialProfileFormValues(): ProfileFormValues {
  return {
    name: "default",
    note: "",
    reviewers: [{ role: "correctness", model: "", timeoutSeconds: "" }],
    routerModel: "",
    minSeverity: "info",
    maxCostUsd: "",
    maxTokens: "",
  };
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asIndex = (value: unknown): number => {
  const raw = asString(value).trim();
  if (raw === "") return -1;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : -1;
};

/** Reads the structured form into raw string values (no validation). */
export function decodeProfileForm(body: Record<string, unknown>): ProfileFormValues {
  const count = Math.max(0, Math.min(asIndex(body.reviewer_count), PROFILE_MAX_REVIEWERS));
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

/**
 * Reads which action button was clicked. Only a genuine `save` (or an absent
 * action) persists; out-of-range or malformed actions decode to "noop" so a
 * boundary click can never persist a half-edited draft.
 */
export function decodeProfileAction(body: Record<string, unknown>): ProfileFormAction {
  const raw = asString(body.action);
  if (raw === "" || raw === "save") return { kind: "save" };
  if (raw === "add") return { kind: "add" };
  const [kind, indexRaw] = raw.split(":");
  const index = asIndex(indexRaw);
  if (kind === "remove" && index >= 0) return { kind: "remove", index };
  if (kind === "up" && index > 0) return { kind: "up", index };
  if (kind === "down" && index >= 0) return { kind: "down", index };
  return { kind: "noop" };
}

/** Applies a structural action to the values, returning the next form state. */
export function applyProfileAction(
  values: ProfileFormValues,
  action: ProfileFormAction,
  knownRoleIds: readonly string[],
): ProfileFormValues {
  if (action.kind === "add") {
    if (values.reviewers.length >= PROFILE_MAX_REVIEWERS) return values;
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

/** Seconds → schema whole milliseconds. Blank stays absent (optional field). */
function timeoutToMs(seconds: string): number | undefined | "invalid" {
  if (seconds.trim() === "") return undefined;
  const ms = Number(seconds) * 1000;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > PROFILE_MAX_TIMEOUT_MS) return "invalid";
  return ms;
}

function optionalString(value: string): string | undefined {
  return value.trim() === "" ? undefined : value.trim();
}

/** Optional positive number; blank stays absent. */
function optionalPositive(value: string): number | undefined | "invalid" {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
  return parsed;
}

/** Optional positive integer (whole tokens); blank stays absent. */
function optionalPositiveInteger(value: string): number | undefined | "invalid" {
  const parsed = optionalPositive(value);
  if (parsed === undefined || parsed === "invalid") return parsed;
  if (!Number.isSafeInteger(parsed)) return "invalid";
  return parsed;
}

/**
 * Converts raw form values into the definition object the versioned store
 * validates. Blank strings become absent optionals; timeout seconds become
 * whole milliseconds. On any failure, issues are mapped back to field keys
 * so the renderer can flag the control that caused them; unmappable issues
 * land on the form-level error. A definition is only returned when
 * everything validated.
 */
export function profileFormToDefinition(
  values: ProfileFormValues,
): { ok: true; definition: unknown } | { ok: false; errors: ProfileFieldErrors } {
  const errors: ProfileFieldErrors = {};
  // Blank rows are dropped before validation; formIndices translates zod's
  // compacted array index back to the row the operator actually sees.
  const formIndices: number[] = [];
  const reviewers: unknown[] = [];
  values.reviewers.forEach((row, formIndex) => {
    if (row.role === "" && row.model.trim() === "" && row.timeoutSeconds.trim() === "") return;
    const entry: Record<string, unknown> = { role: row.role };
    const model = optionalString(row.model);
    if (model !== undefined) entry.model = model;
    const timeout = timeoutToMs(row.timeoutSeconds);
    if (timeout === "invalid") {
      errors[`reviewer_timeout_${formIndex}`] =
        "timeout must be a positive number of seconds (max 30 minutes)";
    } else if (timeout !== undefined) {
      entry.timeoutMs = timeout;
    }
    formIndices.push(formIndex);
    reviewers.push(entry);
  });
  const definition: Record<string, unknown> = {
    name: values.name,
    reviewers,
    minPublishableSeverity: values.minSeverity,
  };
  const routerModel = optionalString(values.routerModel);
  if (routerModel !== undefined) definition.routerModel = routerModel;
  const cost = optionalPositive(values.maxCostUsd);
  if (cost === "invalid") errors.max_cost_usd = "must be a positive number";
  else if (cost !== undefined) definition.maxTotalCostUsd = cost;
  const tokens = optionalPositiveInteger(values.maxTokens);
  if (tokens === "invalid") errors.max_tokens = "must be a positive whole number of tokens";
  else if (tokens !== undefined) definition.maxTotalTokens = tokens;

  const check = profileDefinitionSchema.safeParse(definition);
  if (!check.success) {
    for (const issue of check.error.issues) {
      const key = zodPathToFieldKey(issue.path, formIndices);
      if (key && !errors[key]) errors[key] = issue.message;
      else if (!key && !errors.form) errors.form = issue.message;
    }
  }
  // Conversion errors (and any unmappable schema issue) must survive even
  // when the stripped definition would parse cleanly.
  if (Object.keys(errors).length > 0) {
    if (!errors.form) errors.form = "Some fields need attention before this profile can be saved.";
    return { ok: false, errors };
  }
  return { ok: true, definition };
}

/**
 * Maps a zod issue path onto the form field that caused it. Zod indexes the
 * compacted reviewer array; `formIndices` translates back to the rows the
 * operator actually sees. Returns null for unmappable paths.
 */
function zodPathToFieldKey(path: PropertyKey[], formIndices: readonly number[]): ProfileFieldKey | null {
  if (path.length === 0) return null;
  const [head, index, leaf] = path as [PropertyKey, PropertyKey?, PropertyKey?];
  if (head === "name") return "name";
  if (head === "routerModel") return "router_model";
  if (head === "minPublishableSeverity") return "min_severity";
  if (head === "maxTotalCostUsd") return "max_cost_usd";
  if (head === "maxTotalTokens") return "max_tokens";
  if (head === "reviewers" && typeof index === "number") {
    const formIndex = formIndices[index];
    if (formIndex == null) return null;
    if (leaf === "model") return `reviewer_model_${formIndex}`;
    if (leaf === "timeoutMs") return `reviewer_timeout_${formIndex}`;
    if (leaf === "role") return `reviewer_role_${formIndex}`;
  }
  return null;
}

/**
 * Prefills editor values from a stored definition — the exact inverse of
 * profileFormToDefinition, so definition → form → definition is lossless
 * for schema-valid values (timeout milliseconds render as exact decimal
 * seconds; 1500 → "1.5", never a rounded integer).
 */
export function profileFormValuesFromDefinition(
  definition: unknown,
  note: string | null,
): ProfileFormValues {
  const def = (definition ?? {}) as {
    name?: string;
    reviewers?: Array<{ role?: string; model?: string; timeoutMs?: number }>;
    routerModel?: string;
    minPublishableSeverity?: string;
    maxTotalCostUsd?: number;
    maxTotalTokens?: number;
  };
  return {
    name: def.name ?? "",
    note: note ?? "",
    reviewers:
      def.reviewers?.map((reviewer) => ({
        role: reviewer.role ?? "",
        model: reviewer.model ?? "",
        timeoutSeconds: reviewer.timeoutMs != null ? String(reviewer.timeoutMs / 1000) : "",
      })) ?? [],
    routerModel: def.routerModel ?? "",
    minSeverity: def.minPublishableSeverity ?? "info",
    maxCostUsd: def.maxTotalCostUsd != null ? String(def.maxTotalCostUsd) : "",
    maxTokens: def.maxTotalTokens != null ? String(def.maxTotalTokens) : "",
  };
}
