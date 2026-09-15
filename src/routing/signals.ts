import type { ChangedFileSignal, HardRiskFamily, RoutingSignals, SignalFamily } from "./types.js";
import { HARD_RISK_FAMILIES } from "./types.js";

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "bun.lockb",
  "bun.lock",
  "go.sum",
  "go.mod",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "pipfile.lock",
  "uv.lock",
]);

const DOC_EXTENSIONS = new Set(["md", "mdx", "rst", "txt", "adoc", "org"]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  cs: "csharp",
  php: "php",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  toml: "toml",
  tf: "hcl",
  proto: "protobuf",
  graphql: "graphql",
  md: "markdown",
};

interface FamilyRule {
  family: SignalFamily;
  path?: RegExp;
  text?: RegExp;
}

const FAMILY_RULES: FamilyRule[] = [
  {
    family: "auth",
    path: /(^|\/)(authn?|oauth2?|oidc|sso|saml|rbac|acl|session|jwt|login|passwd|permission)s?(\/|$|\.)/i,
    text: /\b(oauth2?|oidc|saml|rbac|jwt|authn|authz|session cookie|login flow)\b/i,
  },
  {
    family: "secrets",
    path: /(^|\/)(\.env|secrets?|credentials?|keystore|private[-_]?key|id_rsa)(\/|$|\.)|\.(pem|p12|pfx)$/i,
    text: /\b(api[-_ ]?key|private key|client secret|password hash|credential leak)\b/i,
  },
  {
    family: "billing",
    path: /(^|\/)(billing|payments?|stripe|invoices?|subscriptions?|checkout)(\/|$|\.)/i,
    text: /\b(stripe|payment intent|subscription|invoice|pci)\b/i,
  },
  {
    family: "migrations",
    path: /(^|\/)(migrations?|alembic|flyway|liquibase|prisma\/migrations)(\/|$)|(\.sql$)/i,
    text: /\b(alter table|drop table|database migration|schema migration)\b/i,
  },
  {
    family: "deploy",
    path: /(^|\/)(\.github\/workflows|Dockerfile|docker-compose|terraform|helm|kubernetes|k8s|deploy|infra)(\/|$|\.)/i,
    text: /\b(production deploy|ci workflow|kubernetes|terraform)\b/i,
  },
  {
    family: "concurrency",
    path: /(^|\/)(workers?|queues?|mutex|locks?)(\/|$|\.)/i,
    text: /\b(race condition|deadlock|mutex|shared mutable|atomics?)\b/i,
  },
  {
    family: "api",
    path: /(^|\/)(openapi|swagger|graphql|proto|api|routes?|handlers?)(\/|$|\.)|\.(proto|graphql)$/i,
    text: /\b(breaking change|public api|openapi|graphql schema)\b/i,
  },
];

export function languageForPath(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  if (LANGUAGE_BY_EXT[ext]) return LANGUAGE_BY_EXT[ext];
  if (LOCKFILES.has(base.toLowerCase())) return "lockfile";
  return ext || "unknown";
}

export function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    /(^|\/)(__tests?__|tests?|spec)(\/|$)/.test(lower) ||
    /\.(tests?|spec)\.[^.]+$/.test(lower) ||
    /\.test\.[^.]+$/.test(lower)
  );
}

export function isDocsPath(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
  if (DOC_EXTENSIONS.has(ext)) return true;
  return /(^|\/)(docs?|changelog)(\/|$)/i.test(filePath);
}

export function isLockfilePath(filePath: string): boolean {
  const base = (filePath.split("/").pop() ?? filePath).toLowerCase();
  return LOCKFILES.has(base);
}

export function familiesForPath(filePath: string): SignalFamily[] {
  const families = new Set<SignalFamily>();
  if (isLockfilePath(filePath)) families.add("dependencies");
  if (isTestPath(filePath)) families.add("tests");
  if (isDocsPath(filePath)) families.add("docs");
  for (const rule of FAMILY_RULES) {
    if (rule.path?.test(filePath)) families.add(rule.family);
  }
  return [...families];
}

export function familiesForText(text: string): SignalFamily[] {
  if (!text.trim()) return [];
  const families = new Set<SignalFamily>();
  for (const rule of FAMILY_RULES) {
    if (rule.text?.test(text)) families.add(rule.family);
  }
  return [...families];
}

interface ParsedFile {
  path: string;
  added: number;
  removed: number;
}

export function parseUnifiedDiff(diff: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let current: ParsedFile | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader) {
      current = { path: gitHeader[2] ?? gitHeader[1] ?? "", added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    const plusName = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (plusName && current && plusName[1] !== "/dev/null") {
      current.path = plusName[1];
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
      continue;
    }
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  return files.filter((file) => file.path && file.path !== "/dev/null");
}

export function scanRoutingSignals(input: {
  diff: string;
  title?: string;
  body?: string;
}): RoutingSignals {
  const parsed = parseUnifiedDiff(input.diff);
  const files: ChangedFileSignal[] = parsed.map((file) => {
    const families = familiesForPath(file.path);
    return {
      path: file.path,
      language: languageForPath(file.path),
      added: file.added,
      removed: file.removed,
      families,
      isTest: isTestPath(file.path),
      isLockfile: isLockfilePath(file.path),
      isDocs: isDocsPath(file.path),
    };
  });

  const familySet = new Set<SignalFamily>();
  const languageSet = new Set<string>();
  let addedLines = 0;
  let removedLines = 0;
  let testsAdded = false;
  let lockfileChanged = false;
  let codeChanged = false;

  for (const file of files) {
    addedLines += file.added;
    removedLines += file.removed;
    languageSet.add(file.language);
    for (const family of file.families) familySet.add(family);
    if (file.isTest && file.added > 0) testsAdded = true;
    if (file.isLockfile) lockfileChanged = true;
    if (!file.isDocs && !file.isTest && !file.isLockfile) codeChanged = true;
  }

  const titleHints = familiesForText(input.title ?? "");
  const bodyHints = familiesForText(input.body ?? "");
  for (const family of [...titleHints, ...bodyHints]) familySet.add(family);

  const families = [...familySet];
  const hardRiskFamilies = families.filter((family): family is HardRiskFamily =>
    (HARD_RISK_FAMILIES as readonly string[]).includes(family),
  );

  return {
    fileCount: files.length,
    addedLines,
    removedLines,
    languages: [...languageSet],
    families,
    hardRiskFamilies,
    files,
    testsAdded,
    testsMissing: codeChanged && !testsAdded,
    lockfileChanged,
    titleHints,
    bodyHints,
  };
}

export function compactSignalSummary(signals: RoutingSignals): Record<string, unknown> {
  return {
    fileCount: signals.fileCount,
    addedLines: signals.addedLines,
    removedLines: signals.removedLines,
    languages: signals.languages,
    families: signals.families,
    hardRiskFamilies: signals.hardRiskFamilies,
    testsAdded: signals.testsAdded,
    testsMissing: signals.testsMissing,
    lockfileChanged: signals.lockfileChanged,
    titleHints: signals.titleHints,
    bodyHints: signals.bodyHints,
    files: signals.files.map((file) => ({
      path: file.path,
      language: file.language,
      added: file.added,
      removed: file.removed,
      families: file.families,
    })),
  };
}

export function sampleDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff;
  return `${diff.slice(0, maxChars)}\n\n[diff truncated at ${maxChars} characters]`;
}

export function relevantDiffHunks(diff: string, files: string[], maxChars: number): string {
  if (files.length === 0) return sampleDiff(diff, maxChars);
  const wanted = new Set(files.map((file) => file.replace(/^\.\//, "")));
  const chunks: string[] = [];
  let current: string[] = [];
  let keep = false;
  const flush = () => {
    if (keep && current.length) chunks.push(current.join("\n"));
    current = [];
    keep = false;
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = (match?.[2] ?? match?.[1] ?? "").replace(/^\.\//, "");
      keep = wanted.has(path);
      current.push(line);
      continue;
    }
    current.push(line);
  }
  flush();
  const joined = chunks.join("\n\n");
  if (!joined) return sampleDiff(diff, Math.min(maxChars, 4_000));
  return sampleDiff(joined, maxChars);
}
