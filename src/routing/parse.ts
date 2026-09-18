import { extractJsonFromText, normalizeLocationSentinels } from "../schema.js";
import { internalEscalationResultSchema, routerResultSchema, type InternalEscalationResult, type RouterResult } from "./schema.js";

export function parseRouterResult(raw: string): RouterResult {
  return routerResultSchema.parse(extractJsonFromText(raw));
}

export function parseInternalEscalationResult(
  raw: string,
  onDrop?: (droppedPlaceholders: number) => void,
): InternalEscalationResult {
  return internalEscalationResultSchema.parse(
    normalizeLocationSentinels(extractJsonFromText(raw), "findings", onDrop),
  );
}
