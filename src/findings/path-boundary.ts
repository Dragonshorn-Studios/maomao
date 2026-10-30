/**
 * Publish-time path boundary (issue #176): a reviewer run can be tricked by
 * prompt injection into reading files outside the checked-out repo (host
 * credentials such as auth.json are not covered by env redaction), then
 * smuggle what it read into a published review. Any finding that references a
 * path outside the checkout — in its `file` location or in its prose — is
 * withheld from the forge and logged instead of posted.
 *
 * `file` locations are checked lexically first so findings on deleted or
 * renamed files are not mistaken for escapes; a realpath pass catches symlink
 * escapes when the file exists. Prose is scanned for path-shaped tokens, but
 * only tokens that resolve to files that exist on the host count — a token
 * naming no host file cannot be exfiltration, which keeps URL paths like
 * `/api/v1/...` from suppressing real findings.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export interface PathBoundaryViolation {
  /** Which finding field carried the offending reference. */
  source: "file" | "text";
  /** The offending path token — safe to log; never the finding body itself. */
  ref: string;
}

function lexicallyInside(repoDir: string, candidate: string): boolean {
  const rel = relative(repoDir, resolve(repoDir, candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Whether a finding's `file` path stays inside the checkout. Lexical first so
 * locations on missing files still pass; realpath catches symlink escapes.
 */
export function filePathInsideRepo(repoDir: string, file: string): boolean {
  if (!lexicallyInside(repoDir, file)) return false;
  try {
    const repoReal = realpathSync(repoDir);
    const fileReal = realpathSync(resolve(repoDir, file));
    const inside = relative(repoReal, fileReal);
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
  } catch {
    // Missing file or repoDir — the lexical result stands.
    return true;
  }
}

const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{2}[\\/]|\/)[^\s"'`()[\]{}<>|;&]*/g;
const TRAILING_PUNCT_RE = /[.,;:!?'"\]]+$/;

/**
 * Path-shaped tokens in `text` that resolve outside `repoDir` and exist on
 * the host filesystem. Without `repoDir` every absolute/home/drive token is a
 * candidate (used when the workspace has already been swept). `..`-relative
 * tokens are resolved against the repo so escapes into sibling workspaces are
 * caught the same way as absolute paths.
 */
export function outsidePathReferences(text: string, repoDir: string | undefined, homeDir = homedir()): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN_RE)) {
    const token = match[0].replace(TRAILING_PUNCT_RE, "");
    if (token.length < 3) continue;
    let resolved: string;
    if (/^[A-Za-z]:[\\/]/.test(token)) {
      resolved = normalize(token);
    } else if (token.startsWith("~")) {
      resolved = join(homeDir, token.slice(2));
    } else {
      resolved = resolve(repoDir ?? process.cwd(), token);
    }
    if (repoDir && lexicallyInside(repoDir, resolved)) continue;
    if (existsSync(resolved)) refs.add(token);
  }
  return [...refs];
}

/**
 * Every out-of-checkout path a finding references: its `file` location plus
 * path references inside summary/body/reason prose. Returns the tokens for
 * audit logging — callers must not echo the finding's own text into the log
 * line beyond these paths.
 */
export function findingPathViolations(
  finding: { file?: string | null; summary?: string | null; body?: string | null; reason?: string | null },
  repoDir: string | undefined,
): PathBoundaryViolation[] {
  const violations: PathBoundaryViolation[] = [];
  if (finding.file) {
    const inside = repoDir
      ? filePathInsideRepo(repoDir, finding.file)
      : !isAbsolute(finding.file) && !normalize(finding.file).startsWith("..");
    if (!inside) violations.push({ source: "file", ref: finding.file });
  }
  const prose = [finding.summary, finding.body, finding.reason].filter((v): v is string => Boolean(v)).join("\n");
  for (const ref of outsidePathReferences(prose, repoDir)) {
    violations.push({ source: "text", ref });
  }
  return violations;
}
