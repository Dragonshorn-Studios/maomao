// Browser bundle entry (esbuild IIFE → /assets/vendor/pierre-diffs.js).
// Enhances finding-card diffs with @pierre/diffs: syntax highlighting, a
// unified/split toggle, and a severity-tinted line annotation. The
// server-rendered spans stay as the no-JS fallback; when this bundle is
// missing (404) the enhancement simply never runs.
//
// FileDiff must mount via `containerWrapper`, not `fileContainer`. Passing our
// `.pierre-diff` div as fileContainer makes the library attachShadow() on it
// and skip the `diffs-container` custom element — whose constructor is what
// adopts the library stylesheet. The viewer then renders unstyled (or blank)
// and hides the fallback in the unslotted light DOM.

import { FileDiff, getSingularPatch, type DiffLineAnnotation, type FileDiffMetadata } from "@pierre/diffs";
import { annotationForLine, diffLayoutOptions, nextLayout, type DiffLayout, synthesisePatch } from "./pierre-glue.js";

declare global {
  // eslint-disable-next-line no-var
  var __maomaoPierre: { enhance(): void; applyLayout(layout: "unified" | "split"): void; scrollToGuidedLine(path: string, line: number, side: "LEFT" | "RIGHT"): boolean; updateGuidedComments(comments: GuidedBrowserComment[]): void; setGuidedComparisonVisible(visible: boolean): void };
}

const LAYOUT_STORAGE_KEY = "maomao-diff-layout";

const instances = new Map<HTMLElement, FileDiff<any>>();
let guidedComparisonVisible = false;
let latestGuidedComments: GuidedBrowserComment[] | null = null;

const GUIDED_UNSAFE_CSS = `
.gd-inline-annotation { max-width: 44rem; margin: .35rem .5rem; padding: .55rem .65rem; border: 1px solid var(--line, #d0d7de); border-left: 3px solid var(--jade, #2da160); border-radius: 7px; background: var(--surface, #fff); color: var(--ink, #24292f); font-family: var(--font-sans, system-ui, sans-serif); font-size: .82rem; line-height: 1.35; box-shadow: 0 4px 14px rgba(0,0,0,.08); }
.gd-inline-annotation--maomao { border-left-color: var(--focus, #6f5bd7); }
.gd-inline-annotation-group .gd-inline-annotation + .gd-inline-annotation { margin-top: .45rem; }
.gd-inline-annotation-head { display: flex; align-items: center; gap: .4rem; color: var(--ink-muted, #57606a); font-size: .72rem; font-weight: 750; letter-spacing: .04em; text-transform: uppercase; }
.gd-inline-annotation-severity { padding: .05rem .3rem; border: 1px solid var(--line, #d0d7de); border-radius: 999px; font-size: .62rem; }
.gd-inline-annotation p { margin: .25rem 0 0; white-space: pre-wrap; }
.gd-inline-annotation-actions { display: flex; gap: .3rem; margin-top: .4rem; }
.gd-inline-annotation button { border: 1px solid var(--line, #d0d7de); border-radius: 5px; padding: .12rem .42rem; background: var(--surface, #fff); color: var(--ink, #24292f); font-size: .68rem; cursor: pointer; }
`;

interface GuidedAnnotationMetadata {
  source: "human" | "maomao";
  summary: string;
  body?: string;
  severity?: string;
  clientId?: string;
  publishable?: boolean;
  category?: string;
  anchorStatus?: "anchored" | "unplaced";
  path?: string;
  side?: "LEFT" | "RIGHT";
  line?: number;
  match?: string;
  entries?: GuidedAnnotationMetadata[];
}

interface GuidedBrowserComment {
  clientId: string;
  kind: "inline" | "general";
  deletedAt?: string;
  path?: string;
  side?: "LEFT" | "RIGHT";
  line?: number;
  severity?: string;
  category?: string;
  publishable?: boolean;
  anchorStatus?: "anchored" | "unplaced";
  body: string;
}

type GuidedAnnotation = DiffLineAnnotation<GuidedAnnotationMetadata>;

function currentLayout(): DiffLayout {
  return localStorage.getItem(LAYOUT_STORAGE_KEY) === "split" ? "split" : "unified";
}

function themeType(): "light" | "dark" {
  return document.documentElement.getAttribute("data-if-theme") === "dark" ? "dark" : "light";
}

function cardAttribute(container: HTMLElement, name: string): string {
  return container.getAttribute(`data-${name}`) ?? "";
}

function renderInto(container: HTMLElement): void {
  if (container.getAttribute("data-enhanced") === "1") return;
  const rawHunk = container.querySelector(".diff-raw")?.textContent ?? "";
  if (!rawHunk) return;
  const path = cardAttribute(container, "path");
  const line = Number.parseInt(cardAttribute(container, "line") ?? "", 10);
  const annotation = annotationForLine(rawHunk, Number.isSafeInteger(line) && line > 0 ? line : undefined);
  const severity = cardAttribute(container, "severity") || "info";
  const summary = cardAttribute(container, "summary") || "Review finding";

  let metadata: FileDiffMetadata;
  try {
    metadata = getSingularPatch(synthesisePatch(rawHunk, path));
  } catch {
    return; // Malformed hunk: keep the server-rendered fallback.
  }

  const fileDiff = new FileDiff({
    ...diffLayoutOptions(currentLayout(), themeType()),
    renderAnnotation: () => {
      const node = document.createElement("div");
      node.className = `pierre-annotation severity-${severity}`;
      node.textContent = `Maomao finding — ${summary}`;
      return node;
    },
  });
  try {
    fileDiff.render({
      fileDiff: metadata,
      lineAnnotations: annotation ? [annotation] : [],
      containerWrapper: container,
    });
  } catch {
    fileDiff.cleanUp();
    return;
  }
  if (!container.querySelector("diffs-container")) {
    fileDiff.cleanUp();
    return;
  }
  // Hide (don't destroy) the no-JS panel; .diff-raw stays for layout toggles.
  const fallback = container.querySelector<HTMLElement>(".diff-panel");
  if (fallback) fallback.hidden = true;
  container.setAttribute("data-enhanced", "1");
  instances.set(container, fileDiff);
}

function annotationsForContainer(container: HTMLElement): GuidedAnnotation[] {
  const raw = container.querySelector(".guided-annotations-raw")?.textContent ?? "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as GuidedAnnotation[] : [];
  } catch {
    return [];
  }
}

function currentHumanAnnotations(container: HTMLElement, initial: GuidedAnnotation[]): GuidedAnnotation[] {
  if (!latestGuidedComments) return initial.filter((annotation) => annotation.metadata?.source === "human");
  const path = container.getAttribute("data-path") ?? "";
  return commentsToGuidedAnnotations(latestGuidedComments).get(path) ?? [];
}

function groupGuidedAnnotations(annotations: GuidedAnnotation[]): GuidedAnnotation[] {
  const groups = new Map<string, GuidedAnnotation[]>();
  for (const annotation of annotations) {
    const key = `${annotation.side}:${annotation.lineNumber}`;
    groups.set(key, [...(groups.get(key) ?? []), annotation]);
  }
  return Array.from(groups.values()).map((items) => {
    if (items.length === 1) return items[0];
    const entries = items.map((item) => item.metadata).filter((item): item is GuidedAnnotationMetadata => Boolean(item));
    return { ...items[0], metadata: { source: "human", summary: "", entries } };
  });
}

function effectiveGuidedAnnotations(container: HTMLElement): GuidedAnnotation[] {
  const initial = annotationsForContainer(container);
  const human = currentHumanAnnotations(container, initial);
  const maomao = guidedComparisonVisible ? initial.filter((annotation) => annotation.metadata?.source === "maomao") : [];
  return groupGuidedAnnotations([...human, ...maomao]);
}

function refreshGuidedAnnotations(): void {
  for (const container of Array.from(document.querySelectorAll<HTMLElement>(".guided-pierre-file[data-enhanced]"))) {
    instances.get(container)?.setLineAnnotations(effectiveGuidedAnnotations(container));
  }
}

function setGuidedComparisonVisible(visible: boolean): void {
  guidedComparisonVisible = visible;
  refreshGuidedAnnotations();
}

function renderGuidedAnnotationContent(meta: GuidedAnnotationMetadata): HTMLElement {
  const node = document.createElement("div");
  node.className = `gd-inline-annotation gd-inline-annotation--${meta.source}`;
  const title = document.createElement("div");
  title.className = "gd-inline-annotation-head";
  title.textContent = meta.source === "maomao" ? `Maomao${meta.match ? ` · ${meta.match}` : ""}` : "Your note";
  if (meta.severity) {
    const severity = document.createElement("span");
    severity.className = "gd-inline-annotation-severity";
    severity.textContent = meta.severity;
    title.appendChild(severity);
  }
  node.appendChild(title);
  const body = document.createElement("p");
  body.textContent = meta.body || meta.summary || "";
  node.appendChild(body);
  if (meta.source === "human" && meta.clientId) {
    const actions = document.createElement("div");
    actions.className = "gd-inline-annotation-actions";
    for (const [label, eventName] of [["Edit", "guided:edit-inline-comment"], ["Delete", "guided:delete-inline-comment"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "if-button if-button--sm";
      button.textContent = label;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        document.dispatchEvent(new CustomEvent(eventName, { detail: meta }));
      });
      actions.appendChild(button);
    }
    node.appendChild(actions);
  }
  return node;
}

function renderGuidedAnnotation(annotation: DiffLineAnnotation<GuidedAnnotationMetadata>): HTMLElement {
  const meta = annotation.metadata;
  if (meta?.entries?.length) {
    const group = document.createElement("div");
    group.className = "gd-inline-annotation-group";
    for (const entry of meta.entries) group.appendChild(renderGuidedAnnotationContent(entry));
    return group;
  }
  return renderGuidedAnnotationContent(meta ?? { source: "human", summary: "" });
}

function renderGuidedFile(container: HTMLElement): void {
  if (container.getAttribute("data-enhanced") === "1") return;
  const serializedPatch = container.querySelector(".guided-patch-raw")?.textContent ?? "";
  if (!serializedPatch.trim()) return;
  let patch: string;
  try {
    const parsed = JSON.parse(serializedPatch) as unknown;
    if (typeof parsed !== "string") return;
    patch = parsed;
  } catch {
    return;
  }
  let metadata: FileDiffMetadata;
  try {
    metadata = getSingularPatch(patch);
  } catch {
    return;
  }
  const path = container.getAttribute("data-path") ?? "";
  const oldPath = container.getAttribute("data-old-path") || path;
  const sessionId = container.getAttribute("data-session-id") ?? "";
  const commentable = container.getAttribute("data-commentable") === "1";
  const hoveredLineTypes = new Map<string, string>();
  let utilityButton: HTMLButtonElement | null = null;
  const setUtilityLineType = (lineType: string | undefined) => {
    if (utilityButton) utilityButton.hidden = lineType !== "context" && lineType !== "change-addition" && lineType !== "change-deletion";
  };
  const keyFor = (row: { lineNumber: number; side?: string; annotationSide?: string }) => `${row.side ?? row.annotationSide ?? "unified"}:${row.lineNumber}`;
  const fileDiff = new FileDiff<GuidedAnnotationMetadata>({
    ...diffLayoutOptions(currentLayout(), themeType()),
    unsafeCSS: GUIDED_UNSAFE_CSS,
    hunkSeparators: "line-info",
    expansionLineCount: 20,
    collapsedContextThreshold: 2,
    loadDiffFiles: async (fileDiffMetadata) => {
      if (!sessionId) throw new Error("Guided Review session is unavailable");
      const load = async (side: "base" | "head", filePath: string | undefined) => {
        if (!filePath) return null;
        const response = await fetch(`/api/guided-review/sessions/${encodeURIComponent(sessionId)}/file?side=${side}&path=${encodeURIComponent(filePath)}`);
        const payload = await response.json().catch(() => ({})) as { content?: string; error?: string; absent?: boolean };
        if (response.ok && payload.absent === true) return null;
        if (!response.ok || typeof payload.content !== "string") throw new Error(payload.error || `Could not load ${side} file contents`);
        return { name: filePath, contents: payload.content };
      };
      try {
        const [oldFile, newFile] = await Promise.all([
          load("base", oldPath || fileDiffMetadata.prevName || fileDiffMetadata.name),
          load("head", fileDiffMetadata.name || path),
        ]);
        container.querySelector(".gd-expansion-error")?.remove();
        if (oldFile && newFile) return { oldFile, newFile };
        if (newFile) return { oldFile: null, newFile };
        throw new Error("Both sides of this file are unavailable for context expansion");
      } catch (error) {
        const notice = document.createElement("p");
        notice.className = "gd-expansion-error error if-banner if-banner--danger";
        notice.textContent = `Could not expand unchanged context: ${error instanceof Error ? error.message : String(error)}`;
        container.querySelector(".gd-expansion-error")?.remove();
        container.prepend(notice);
        throw error;
      }
    },
    renderAnnotation: renderGuidedAnnotation,
    onLineEnter: commentable ? (props) => {
      hoveredLineTypes.set(keyFor(props), props.lineType);
      setUtilityLineType(props.lineType);
    } : undefined,
    onLineLeave: commentable ? (props) => {
      hoveredLineTypes.delete(keyFor(props));
      if (utilityButton) utilityButton.hidden = true;
    } : undefined,
    enableGutterUtility: commentable,
    renderGutterUtility: commentable ? (getHoveredRow) => {
      if (utilityButton) return utilityButton;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gd-comment-trigger gd-comment-trigger--pierre";
      button.textContent = "+";
      button.title = "Add inline draft note";
      button.setAttribute("aria-label", "Add inline draft note");
      button.hidden = true;
      utilityButton = button;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = getHoveredRow();
        if (!current || !path || hoveredLineTypes.get(keyFor(current)) === "context-expanded") return;
        document.dispatchEvent(new CustomEvent("guided:line-anchor", {
          detail: { path, side: current.side === "deletions" ? "LEFT" : "RIGHT", line: String(current.lineNumber) },
        }));
      });
      return button;
    } : undefined,
  });
  try {
    fileDiff.render({ fileDiff: metadata, lineAnnotations: effectiveGuidedAnnotations(container), containerWrapper: container });
  } catch {
    fileDiff.cleanUp();
    return;
  }
  if (!container.querySelector("diffs-container")) {
    fileDiff.cleanUp();
    return;
  }
  const fallback = container.querySelector<HTMLElement>(".gd-fallback");
  if (fallback) fallback.hidden = true;
  container.setAttribute("data-enhanced", "1");
  instances.set(container, fileDiff);
}

function commentsToGuidedAnnotations(comments: GuidedBrowserComment[]): Map<string, GuidedAnnotation[]> {
  const annotations = new Map<string, GuidedAnnotation[]>();
  for (const comment of comments) {
    if (comment.deletedAt || comment.kind !== "inline" || comment.anchorStatus === "unplaced" || !comment.path || !comment.line || !comment.side) continue;
    const entry: GuidedAnnotation = {
      side: comment.side === "LEFT" ? "deletions" : "additions",
      lineNumber: comment.line,
      metadata: { source: "human", summary: comment.body, body: comment.body, severity: comment.severity, clientId: comment.clientId, publishable: comment.publishable, category: comment.category, anchorStatus: comment.anchorStatus, path: comment.path, side: comment.side, line: comment.line },
    };
    const list = annotations.get(comment.path) ?? [];
    list.push(entry);
    annotations.set(comment.path, list);
  }
  return annotations;
}

function updateGuidedComments(comments: GuidedBrowserComment[]): void {
  latestGuidedComments = comments;
  refreshGuidedAnnotations();
}

function scrollToGuidedLine(path: string, line: number, side: "LEFT" | "RIGHT"): boolean {
  if (!Number.isSafeInteger(line) || line < 1) return false;
  const container = Array.from(document.querySelectorAll<HTMLElement>(".guided-pierre-file[data-guided-pierre]"))
    .find((candidate) => candidate.getAttribute("data-path") === path);
  if (!container || container.getAttribute("data-enhanced") !== "1") return false;
  const instance = instances.get(container);
  instance?.revealLine(line);
  instance?.setEditorActiveLine(line, { side: side === "LEFT" ? "deletions" : "additions" });
  const host = container.querySelector<HTMLElement>("diffs-container");
  const shadow = host?.shadowRoot;
  if (!shadow) return true;
  const column = side === "LEFT" ? "deletions" : "additions";
  const lineType = side === "LEFT" ? "deletion" : "addition";
  const scroll = () => {
    const row = shadow.querySelector<HTMLElement>(`code[data-${column}] [data-line="${line}"]`)
      ?? shadow.querySelector<HTMLElement>(`code[data-unified] [data-line="${line}"][data-line-type*="${lineType}"]`)
      ?? shadow.querySelector<HTMLElement>(`code[data-unified] [data-line="${line}"]`);
    if (!row) return false;
    row.scrollIntoView({ block: "center" });
    return true;
  };
  if (!scroll()) {
    window.setTimeout(scroll, 80);
    window.setTimeout(scroll, 250);
  }
  return true;
}

function applyLayout(layout: DiffLayout): void {
  localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
  for (const container of Array.from(document.querySelectorAll<HTMLElement>(".pierre-diff[data-enhanced], .guided-pierre-file[data-enhanced]"))) {
    const guided = container.classList.contains("guided-pierre-file");
    const previous = instances.get(container);
    previous?.cleanUp();
    instances.delete(container);
    container.removeAttribute("data-enhanced");
    for (const child of Array.from(container.children)) {
      if (child.classList.contains("diff-raw") || child.classList.contains("guided-patch-raw") || child.classList.contains("guided-annotations-raw")) continue;
      if (child.classList.contains("diff-panel") || child.classList.contains("gd-fallback")) {
        (child as HTMLElement).hidden = false;
        continue;
      }
      child.remove();
    }
    if (guided) renderGuidedFile(container);
    else renderInto(container);
  }
}

function enhanceAll(): void {
  const compareStep = document.getElementById("gd-step-compare") as HTMLInputElement | null;
  if (compareStep) guidedComparisonVisible = compareStep.checked;
  for (const details of document.querySelectorAll<HTMLDetailsElement>("details.finding-diff")) {
    const container = details.querySelector<HTMLElement>(".pierre-diff[data-pierre-diff]");
    if (!container) continue;
    if (details.open) {
      renderInto(container);
      continue;
    }
    if (details.hasAttribute("data-pierre-lazy")) continue;
    details.setAttribute("data-pierre-lazy", "1");
    details.addEventListener(
      "toggle",
      () => {
        if (details.open) renderInto(container);
      },
      { once: true },
    );
  }
  for (const container of document.querySelectorAll<HTMLElement>(".guided-pierre-file[data-guided-pierre]")) {
    renderGuidedFile(container);
  }
  for (const toggle of document.querySelectorAll<HTMLButtonElement>(".guided-layout-toggle")) {
    if (toggle.hasAttribute("data-pierre-bound")) continue;
    toggle.setAttribute("data-pierre-bound", "1");
    toggle.addEventListener("click", () => applyLayout(nextLayout(currentLayout())));
  }
  for (const summary of document.querySelectorAll<HTMLElement>("details.finding-diff > summary")) {
    if (summary.querySelector(".diff-layout-toggle")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "diff-layout-toggle";
    const label = (layout: DiffLayout) => `Switch diffs to ${layout === "split" ? "unified" : "split"} view`;
    button.textContent = currentLayout() === "split" ? "Split view" : "Unified view";
    button.setAttribute("aria-label", label(currentLayout()));
    // Buttons inside <summary> otherwise toggle the <details> in some browsers.
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const next = nextLayout(currentLayout());
      applyLayout(next);
      for (const toggle of document.querySelectorAll<HTMLButtonElement>(".diff-layout-toggle")) {
        toggle.textContent = next === "split" ? "Split view" : "Unified view";
        toggle.setAttribute("aria-label", label(next));
      }
    });
    summary.appendChild(button);
  }
}

export { enhanceAll as enhance, applyLayout, scrollToGuidedLine, updateGuidedComments, setGuidedComparisonVisible };

globalThis.__maomaoPierre = { enhance: enhanceAll, applyLayout, scrollToGuidedLine, updateGuidedComments, setGuidedComparisonVisible };
const pierre = globalThis.__maomaoPierre;

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => pierre.enhance());
  } else {
    pierre.enhance();
  }
  // Keep the library's theme type in sync with the appearance switch.
  new MutationObserver(() => {
    const type = themeType();
    for (const instance of instances.values()) instance.setThemeType(type);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}
