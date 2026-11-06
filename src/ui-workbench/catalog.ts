/**
 * The catalog document.
 *
 * The server serves it at `/dev/ui/catalog.json` and `npm run ui:validate`
 * schema-checks it. Both go through this one builder, so the validated
 * artifact and the published one cannot drift apart.
 */
import { VIEWPORTS, type Catalog } from "./contract.js";
import type { WorkbenchRegistry } from "./registry.js";
import { frameUrl, storyUrl } from "./render.js";

export function buildCatalog(registry: WorkbenchRegistry): Catalog {
  return {
    generatedBy: "maomao-ui-workbench",
    viewports: {
      mobile: { ...VIEWPORTS.mobile },
      tablet: { ...VIEWPORTS.tablet },
      desktop: { ...VIEWPORTS.desktop },
    },
    stories: registry.all().map((story) => ({
      id: story.id,
      title: story.title,
      category: story.category,
      family: story.family,
      defaultViewport: story.defaultViewport,
      sourceFiles: [...story.sourceFiles],
      // Maomao declares its composition edges: the renderers are plain
      // functions, so only the story knows which components it renders.
      uses: [...(story.uses ?? [])],
      notes: story.notes ?? null,
      variants: story.variants.map((variant) => ({
        id: variant.id,
        title: variant.title,
        url: storyUrl(story.id, variant.id),
        frameUrl: frameUrl(story.id, variant.id),
      })),
    })),
  };
}
