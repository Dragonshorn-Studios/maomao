export type FindingStatus =
  | "open"
  | "resolved"
  | "dismissed"
  | "still_valid"
  | "moved"
  | "uncertain";

export type FindingClassification = Exclude<FindingStatus, "open">;

export interface FindingRow {
  id: number;
  repo_full_name: string;
  pr_number: number;
  fingerprint: string;
  status: FindingStatus;
  reviewed_sha: string;
  current_sha: string | null;
  github_thread_id: string | null;
  github_comment_id: string | null;
  original_path: string | null;
  original_line: number | null;
  current_path: string | null;
  current_line: number | null;
  category: string | null;
  summary: string;
  body: string | null;
  severity: string | null;
  confidence: number | null;
  dismissed_by: string | null;
  dismissed_at: string | null;
  dismiss_command: string | null;
  reopened_by: string | null;
  reopened_at: string | null;
  reopen_command: string | null;
  reconciliation_confidence: number | null;
  reconciliation_reason: string | null;
  last_job_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ClassifiedFinding {
  fingerprint: string;
  status: FindingClassification;
  confidence: number;
  reason: string;
  threadId?: string;
  commentId?: string;
  originalPath?: string;
  originalLine?: number;
  currentPath?: string;
  currentLine?: number;
  category?: string;
  summary: string;
  body?: string;
  severity?: string;
}

export interface ReconciliationSnapshot {
  headSha: string;
  items: ClassifiedFinding[];
}

export function currentFindingsForRisk(items: ClassifiedFinding[]): ClassifiedFinding[] {
  return items.filter((item) => item.status !== "resolved" && item.status !== "dismissed");
}
