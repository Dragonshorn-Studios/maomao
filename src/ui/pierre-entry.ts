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
  var __maomaoPierre: { enhance(): void; applyLayout(layout: "unified" | "split"): void };
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

function applyLayout(layout: DiffLayout): void {
  localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
  for (const container of Array.from(document.querySelectorAll<HTMLElement>(".pierre-diff[data-enhanced]"))) {
    const previous = instances.get(container);
    previous?.cleanUp();
    instances.delete(container);
    container.removeAttribute("data-enhanced");
    for (const child of Array.from(container.children)) {
      if (child.classList.contains("diff-raw")) continue;
      if (child.classList.contains("diff-panel")) {
        (child as HTMLElement).hidden = false;
        continue;
      }
      child.remove();
    }
    renderInto(container);
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

export { enhanceAll as enhance, applyLayout };

globalThis.__maomaoPierre = { enhance: enhanceAll, applyLayout };
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
