import { extractJsonFromText } from "../schema.js";
import { routerResultSchema, type RouterResult } from "./schema.js";

export function parseRouterResult(raw: string): RouterResult {
  return routerResultSchema.parse(extractJsonFromText(raw));
}
