/**
 * The story registry: an explicit allowlist of previewable components.
 *
 * Only registered ids resolve; every other path is a 404. Nothing is loaded
 * from a URL, so the registry is the single place where a file or component
 * becomes reachable.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SLUG_PATTERN,
  VIEWPORTS,
  type ViewportName,
  type WorkbenchStory,
  type WorkbenchVariant,
} from "./contract.js";

/** The repository root, derived from this file so paths never depend on cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class WorkbenchRegistry {
  private readonly index = new Map<string, WorkbenchStory>();

  constructor(private readonly stories: WorkbenchStory[]) {
    for (const story of stories) {
      if (!this.index.has(story.id)) this.index.set(story.id, story);
    }
  }

  /** Every registered story, in registration order. */
  all(): WorkbenchStory[] {
    return [...this.stories];
  }

  /** Only explicitly registered ids resolve. */
  find(id: string): WorkbenchStory | undefined {
    return this.index.get(id);
  }

  /** The requested variant, or the story's first one when no variant is asked for. */
  variant(story: WorkbenchStory, variantId: string | undefined): WorkbenchVariant | undefined {
    if (!variantId) return story.variants[0];
    return story.variants.find((candidate) => candidate.id === variantId);
  }

  /** The stories a story composes, in declaration order. */
  uses(story: WorkbenchStory): WorkbenchStory[] {
    return this.resolve(story.uses ?? []);
  }

  /** The stories that compose a story, in registry order. */
  usedBy(story: WorkbenchStory): WorkbenchStory[] {
    return this.stories.filter((candidate) => (candidate.uses ?? []).includes(story.id));
  }

  private resolve(ids: string[]): WorkbenchStory[] {
    const found: WorkbenchStory[] = [];
    for (const id of ids) {
      const story = this.index.get(id);
      if (story) found.push(story);
    }
    return found;
  }

  /**
   * Problems `npm run ui:validate` reports. An empty result means the story
   * set is well formed.
   */
  problems(): string[] {
    const problems: string[] = [];
    const seenStories = new Set<string>();

    for (const story of this.stories) {
      if (seenStories.has(story.id)) {
        problems.push(`Duplicate story id [${story.id}].`);
      }
      seenStories.add(story.id);

      if (!SLUG_PATTERN.test(story.id)) {
        problems.push(`Story id [${story.id}] must be a lowercase slug.`);
      }
      if (story.title.trim() === "") {
        problems.push(`Story [${story.id}] has no title.`);
      }
      if (story.category.trim() === "") {
        problems.push(`Story [${story.id}] has no category.`);
      }
      if (!(story.defaultViewport in VIEWPORTS)) {
        problems.push(`Story [${story.id}] has unknown default viewport [${story.defaultViewport}].`);
      }
      if (story.variants.length === 0) {
        problems.push(`Story [${story.id}] has no variants.`);
      }
      if (typeof story.preview !== "function") {
        problems.push(`Story [${story.id}] needs a preview renderer.`);
      }

      problems.push(...this.variantProblems(story));
      problems.push(...this.usesProblems(story));
      problems.push(...this.sourceFileProblems(story));
    }

    return problems;
  }

  /**
   * Composition edges must point at stories that exist. A dangling id would
   * silently drop a link in the gallery and the catalog.
   */
  private usesProblems(story: WorkbenchStory): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();

    for (const id of story.uses ?? []) {
      if (seen.has(id)) {
        problems.push(`Story [${story.id}] repeats the composed story [${id}].`);
      }
      seen.add(id);

      if (id === story.id) {
        problems.push(`Story [${story.id}] cannot compose itself.`);
        continue;
      }
      if (!this.index.has(id)) {
        problems.push(`Story [${story.id}] composes unknown story [${id}].`);
      }
    }

    return problems;
  }

  private variantProblems(story: WorkbenchStory): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();

    for (const variant of story.variants) {
      if (seen.has(variant.id)) {
        problems.push(`Story [${story.id}] repeats variant id [${variant.id}].`);
      }
      seen.add(variant.id);

      if (!SLUG_PATTERN.test(variant.id)) {
        problems.push(`Variant id [${story.id}/${variant.id}] must be a lowercase slug.`);
      }
      if (variant.title.trim() === "") {
        problems.push(`Variant [${story.id}/${variant.id}] has no title.`);
      }
    }

    return problems;
  }

  /**
   * Source references are checked deterministically: the path must stay
   * inside the repository and point at a file that exists.
   */
  private sourceFileProblems(story: WorkbenchStory): string[] {
    const problems: string[] = [];

    for (const file of story.sourceFiles) {
      if (file.trim() === "") {
        problems.push(`Story [${story.id}] has an empty source file reference.`);
        continue;
      }
      if (isAbsolute(file) || file.startsWith("..") || file.split(/[\\/]/).includes("..")) {
        problems.push(`Story [${story.id}] references a source file outside the repository [${file}].`);
        continue;
      }
      const absolute = resolve(REPO_ROOT, file);
      if (absolute !== REPO_ROOT && !absolute.startsWith(REPO_ROOT + sep)) {
        problems.push(`Story [${story.id}] resolves a source file outside the repository [${file}].`);
        continue;
      }
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        problems.push(`Story [${story.id}] references missing file [${file}].`);
      }
    }

    return problems;
  }
}

/** The viewport preset for a requested name, falling back to the given default. */
export function resolveViewport(
  requested: string | undefined,
  fallback: ViewportName,
): { name: ViewportName; width: number; height: number } {
  const name = (requested ?? "") in VIEWPORTS ? (requested as ViewportName) : fallback;
  const preset = VIEWPORTS[name] ?? VIEWPORTS.desktop;
  return { name, ...preset };
}
