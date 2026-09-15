import { z } from "zod";
import { REVIEW_PROFILES } from "./types.js";

export const routerResultSchema = z.object({
  profile: z.enum(REVIEW_PROFILES),
  reviewers: z.array(z.string().min(1)).default([]),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).optional().default(0.5),
});
export type RouterResult = z.infer<typeof routerResultSchema>;

export const internalEscalationFindingSchema = z.object({
  id: z.string().min(1).optional(),
  severity: z.enum(["blocker", "high", "medium", "low", "info"]),
  confidence: z.number().min(0).max(1).optional().default(0.5),
  category: z.string().min(1).optional().default("general"),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  summary: z.string().min(1),
  body: z.string().optional(),
  reviewers_agreed: z.array(z.string()).optional().default([]),
});

export const internalEscalationResultSchema = z.object({
  schema_version: z.number().int().optional().default(1),
  confirmed: z.boolean().optional().default(true),
  alert_cleared: z.boolean().optional().default(false),
  summary: z.string().min(1),
  findings: z.array(internalEscalationFindingSchema).default([]),
  rejected_finding_ids: z.array(z.string()).optional().default([]),
});
export type InternalEscalationResult = z.infer<typeof internalEscalationResultSchema>;
