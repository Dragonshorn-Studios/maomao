import { createHash } from "node:crypto";
import { basename } from "node:path";

export const FINDING_MARKER_PREFIX = "<!-- maomao-finding";
export const FINDING_MARKER_RE =
  /<!--\s*maomao-finding\s+id=([A-Za-z0-9_-]+)\s+sha=([A-Za-z0-9_-]+)\s*-->/;

const STOP_WORDS = new Set([
  "the",
  "this",
  "that",
  "with",
  "from",
  "file",
  "line",
  "code",
  "into",
  "when",
  "then",
  "than",
  "should",
  "would",
  "could",
  "must",
  "not",
  "and",
  "for",
  "are",
  "was",
  "can",
  "may",
  "use",
  "using",
  "used",
  "because",
  "after",
  "before",
  "missing",
  "potential",
  "possible",
  "issue",
  "error",
  "bug",
]);

export interface FindingIdentity {
  file?: string;
  category?: string;
  summary: string;
  body?: string;
  reason?: string;
}

export function normalizePath(file: string | undefined): string {
  return (file ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

export function normalizeMeaning(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/:\d+(?:-\d+)?/g, " ")
    .replace(/\bline\s+\d+\b/g, " ")
    .replace(/[^a-z0-9\s_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CODE_IDENT_RE =
  /\b[A-Za-z_][A-Za-z0-9]*[A-Z][A-Za-z0-9_]*\b|\b[A-Za-z_][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g;

export function codeIdentifiers(text: string): string[] {
  const idents = text.match(CODE_IDENT_RE) ?? [];
  return [
    ...new Set(
      idents
        .map((item) => item.toLowerCase())
        .filter((item) => !STOP_WORDS.has(item) && item.length < 64),
    ),
  ]
    .sort()
    .slice(0, 8);
}

export function semanticAnchor(finding: FindingIdentity): string {
  const text = `${finding.summary} ${finding.body ?? ""} ${finding.reason ?? ""}`;
  const fileBase = finding.file ? basename(normalizePath(finding.file)).replace(/\.[^.]+$/, "").toLowerCase() : "";
  return [fileBase, ...codeIdentifiers(text)].filter(Boolean).join(",");
}

export function fingerprintFinding(finding: FindingIdentity): string {
  const path = normalizePath(finding.file);
  const category = (finding.category ?? "general").trim().toLowerCase();
  const text = `${finding.summary} ${finding.body ?? ""} ${finding.reason ?? ""}`;
  const idents = codeIdentifiers(text);
  const fileBase = finding.file ? basename(path).replace(/\.[^.]+$/, "").toLowerCase() : "";
  const payload = idents.length
    ? [path, category, fileBase, ...idents].join("\u001f")
    : [path, category, fileBase, normalizeMeaning(finding.summary)].join("\u001f");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function findingMarker(fingerprint: string, sha: string): string {
  return `<!-- maomao-finding id=${fingerprint} sha=${sha} -->`;
}

export function parseFindingMarker(body: string): { id: string; sha: string } | undefined {
  const match = body.match(FINDING_MARKER_RE);
  if (!match?.[1] || !match[2]) return undefined;
  return { id: match[1], sha: match[2] };
}
