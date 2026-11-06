/**
 * The checks `npm run ui:validate` runs.
 *
 * They live here, apart from the command-line entry point, so a test can
 * exercise them without the process exiting underneath it.
 */
import { catalogSchema } from "./contract.js";
import { buildCatalog } from "./catalog.js";
import { WorkbenchRegistry } from "./registry.js";
import type { WorkbenchStory } from "./contract.js";

export interface ValidationResult {
  /** Every problem found, in the order they were found. */
  problems: string[];
  /** 0 when the story set is valid, 1 when it is not. */
  exitCode: number;
  /** The number of stories checked. */
  stories: number;
  /** The number of variants checked. */
  variants: number;
}

/**
 * Collects the problems of a story set.
 *
 * The catalog is built through the same builder the server publishes, so the
 * artifact the CLI checks is the artifact `/dev/ui/catalog.json` serves.
 */
export function runValidation(stories: WorkbenchStory[]): ValidationResult {
  const registry = new WorkbenchRegistry(stories);
  const problems = registry.problems();

  // Every variant must render something: a story that throws or renders an
  // empty fragment is worse than no story at all.
  for (const story of registry.all()) {
    for (const variant of story.variants) {
      try {
        const fragment = story.preview(variant);
        if (fragment.trim() === "") {
          problems.push(`Variant [${story.id}/${variant.id}] renders an empty preview.`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        problems.push(`Variant [${story.id}/${variant.id}] failed to render: ${reason}`);
      }
    }
  }

  const catalog = catalogSchema.safeParse(buildCatalog(registry));
  if (!catalog.success) {
    for (const issue of catalog.error.issues) {
      problems.push(`Catalog schema: ${issue.path.join(".")} ${issue.message}`);
    }
  }

  return {
    problems,
    exitCode: problems.length > 0 ? 1 : 0,
    stories: registry.all().length,
    variants: registry.all().reduce((total, story) => total + story.variants.length, 0),
  };
}
