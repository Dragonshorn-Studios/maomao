/**
 * `npm run ui:validate` — the copyable installation check for the workbench.
 *
 * It exits nonzero and explains what to fix when the story set is malformed:
 * duplicate or malformed ids, missing variants, source references that do not
 * resolve inside the repository, a catalog that does not match the published
 * schema, or a variant that renders nothing.
 */
import { catalogSchema } from "./contract.js";
import { WorkbenchRegistry } from "./registry.js";
import { STORIES } from "./stories.js";

function main(): number {
  const registry = new WorkbenchRegistry(STORIES);
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

  const catalog = catalogSchema.safeParse({
    generatedBy: "maomao-ui-workbench",
    viewports: {
      mobile: { width: 390, height: 844 },
      tablet: { width: 834, height: 1112 },
      desktop: { width: 1440, height: 900 },
    },
    stories: registry.all().map((story) => ({
      id: story.id,
      title: story.title,
      category: story.category,
      family: story.family,
      defaultViewport: story.defaultViewport,
      sourceFiles: story.sourceFiles,
      uses: [],
      notes: story.notes ?? null,
      variants: story.variants.map((variant) => ({
        id: variant.id,
        title: variant.title,
        url: `/dev/ui/${story.id}/${variant.id}`,
        frameUrl: `/dev/ui/${story.id}/${variant.id}/frame`,
      })),
    })),
  });
  if (!catalog.success) {
    for (const issue of catalog.error.issues) {
      problems.push(`Catalog schema: ${issue.path.join(".")} ${issue.message}`);
    }
  }

  for (const problem of problems) {
    console.error(problem);
  }

  if (problems.length > 0) {
    console.error(
      `UI workbench story registry is invalid (${problems.length} problem${problems.length === 1 ? "" : "s"}).`,
    );
    return 1;
  }

  const variants = registry.all().reduce((total, story) => total + story.variants.length, 0);
  console.log(
    `UI workbench story registry is valid (${registry.all().length} stor${registry.all().length === 1 ? "y" : "ies"}, ${variants} variants).`,
  );
  return 0;
}

process.exit(main());
