export interface GuidedDiffLine {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface GuidedDiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: GuidedDiffLine[];
}

export interface GuidedDiffFile {
  oldPath?: string;
  newPath?: string;
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  hunks: GuidedDiffHunk[];
  patch: string;
  binary: boolean;
  truncated: boolean;
}

function parseDiffGitPaths(line: string): { oldPath?: string; newPath?: string } {
  const body = line.slice("diff --git ".length);
  const token = /^(?:"((?:\\.|[^"])*)"|(\S+))/;
  const first = body.match(token);
  if (!first) return {};
  const rest = body.slice(first[0].length).trimStart();
  const second = rest.match(token);
  if (!second) return {};
  const decode = (raw: string, quoted: string | undefined) => {
    const value = quoted === undefined ? raw : raw.replace(/\\(.)/g, "$1");
    return value.replace(/^[ab]\//, "");
  };
  return { oldPath: decode(first[1] ?? first[2], first[1]), newPath: decode(second[1] ?? second[2], second[1]) };
}

function unprefix(value: string): string | undefined {
  let trimmed = value.trim();
  if (trimmed === "/dev/null") return undefined;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) trimmed = trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  return trimmed.replace(/^[ab]\//, "");
}

/** Parse enough unified-diff structure for safe SSR rendering and exact anchors. */
export function parseUnifiedDiff(diff: string, opts: { maxFiles?: number; maxLinesPerFile?: number; truncated?: boolean } = {}): GuidedDiffFile[] {
  const maxFiles = opts.maxFiles ?? 300;
  const maxLines = opts.maxLinesPerFile ?? 2000;
  const lines = diff.split("\n");
  const files: GuidedDiffFile[] = [];
  let file: GuidedDiffFile | undefined;
  let hunk: GuidedDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let fileLineCount = 0;
  const finishHunk = () => { hunk = undefined; };
  const finishFile = () => {
    if (file) files.push(file);
    file = undefined;
    finishHunk();
  };
  for (const raw of lines) {
    if (raw === "") continue;
    if (raw.startsWith("diff --git ")) {
      finishFile();
      if (files.length >= maxFiles) break;
      const { oldPath, newPath } = parseDiffGitPaths(raw);
      file = {
        oldPath,
        newPath,
        path: newPath ?? oldPath ?? "unknown",
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
        patch: `${raw}\n`,
        binary: false,
        truncated: Boolean(opts.truncated),
      };
      fileLineCount = 0;
      continue;
    }
    if (!file) continue;
    if (!file.truncated) file.patch += `${raw}\n`;
    if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) {
      file.binary = true;
      finishHunk();
      continue;
    }
    if (raw.startsWith("new file mode")) file.status = "added";
    else if (raw.startsWith("deleted file mode")) file.status = "deleted";
    else if (raw.startsWith("rename from ")) {
      file.oldPath = raw.slice("rename from ".length).trim();
      file.status = "renamed";
    } else if (raw.startsWith("rename to ")) {
      file.newPath = raw.slice("rename to ".length).trim();
      file.path = file.newPath;
      file.status = "renamed";
    } else if (raw.startsWith("--- ")) file.oldPath = unprefix(raw.slice(4));
    else if (raw.startsWith("+++ ")) {
      file.newPath = unprefix(raw.slice(4));
      if (file.newPath) file.path = file.newPath;
      else if (file.oldPath) file.path = file.oldPath;
    } else if (raw.startsWith("@@")) {
      const match = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      hunk = { header: raw, oldStart: oldLine, newStart: newLine, lines: [] };
      file.hunks.push(hunk);
      fileLineCount = 0;
    } else if (hunk) {
      fileLineCount += 1;
      if (fileLineCount > maxLines) {
        file.truncated = true;
        hunk = undefined;
        continue;
      }
      const first = raw[0];
      if (first === "+") {
        file.additions += 1;
        hunk.lines.push({ kind: "add", text: raw.slice(1), newLine: newLine++ });
      } else if (first === "-") {
        file.deletions += 1;
        hunk.lines.push({ kind: "del", text: raw.slice(1), oldLine: oldLine++ });
      } else if (raw.startsWith("\\")) {
        hunk.lines.push({ kind: "meta", text: raw });
      } else {
        hunk.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldLine: oldLine++, newLine: newLine++ });
      }
    }
  }
  finishFile();
  return files;
}

export function guidedDiffSummary(files: GuidedDiffFile[]): { files: number; additions: number; deletions: number; truncated: boolean } {
  return {
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    truncated: files.some((file) => file.truncated),
  };
}
