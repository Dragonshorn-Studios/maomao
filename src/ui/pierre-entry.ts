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

import { FileDiff, getSingularPatch, type FileDiffMetadata } from "@pierre/diffs";
import { annotationForLine, diffLayoutOptions, nextLayout, type DiffLayout, synthesisePatch } from "./pierre-glue.js";

declare global {
  // eslint-disable-next-line no-var
  var __maomaoPierre: { enhance(): void; applyLayout(layout: "unified" | "split"): void; scrollToGuidedLine(path: string, line: number, side: "LEFT" | "RIGHT"): boolean };
}

const LAYOUT_STORAGE_KEY = "maomao-diff-layout";

const instances = new Map<HTMLElement, FileDiff>();

function currentLayout(): DiffLayout {
  return localStorage.getItem(LAYOUT_STORAGE_KEY) === "split" ? "split" : "unified";
}

function themeType(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
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

function renderGuidedFile(container: HTMLElement): void {
  if (container.getAttribute("data-enhanced") === "1") return;
  const patch = container.querySelector(".guided-patch-raw")?.textContent ?? "";
  if (!patch.trim()) return;
  let metadata: FileDiffMetadata;
  try {
    metadata = getSingularPatch(patch);
  } catch {
    return;
  }
  const path = container.getAttribute("data-path") ?? "";
  const commentable = container.getAttribute("data-commentable") === "1";
  const fileDiff = new FileDiff({
    ...diffLayoutOptions(currentLayout(), themeType()),
    disableFileHeader: false,
    enableGutterUtility: commentable,
    renderGutterUtility: commentable ? (getHoveredRow) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gd-comment-trigger gd-comment-trigger--pierre";
      button.textContent = "+";
      button.title = "Add inline draft note";
      button.setAttribute("aria-label", "Add inline draft note");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = getHoveredRow();
        if (!row || !path) return;
        document.dispatchEvent(new CustomEvent("guided:line-anchor", {
          detail: { path, side: row.side === "deletions" ? "LEFT" : "RIGHT", line: String(row.lineNumber) },
        }));
      });
      return button;
    } : undefined,
  });
  try {
    fileDiff.render({ fileDiff: metadata, containerWrapper: container });
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
      if (child.classList.contains("diff-raw") || child.classList.contains("guided-patch-raw")) continue;
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

export { enhanceAll as enhance, applyLayout, scrollToGuidedLine };

globalThis.__maomaoPierre = { enhance: enhanceAll, applyLayout, scrollToGuidedLine };
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
