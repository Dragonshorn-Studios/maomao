/**
 * The UI workbench contract: the stable, machine-readable surface shared with
 * the Sumomo workbench (Dragonshorn-Studios/sumomo#232).
 *
 * Everything a browser agent needs to discover and open a preview lives here:
 * lowercase slug ids, viewport presets, and the catalog JSON shape. The story
 * registry itself is app knowledge and lives in stories.ts.
 */
import { z } from "zod";

/** Story and variant ids appear in URLs, so they must stay slugs. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const slugSchema = z
  .string()
  .min(1)
  .regex(SLUG_PATTERN, "must be a lowercase slug ([a-z0-9] words joined by single dashes)");

/** Viewport presets offered by the story frame, keyed by their query parameter name. */
export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 },
} as const;

export const viewportNameSchema = z.enum(["mobile", "tablet", "desktop"]);
export type ViewportName = z.infer<typeof viewportNameSchema>;

/**
 * Maomao renders server-side HTML and mounts a few React islands; there is no
 * Livewire. Sumomo's `blade`/`livewire` families therefore collapse into `ssr`
 * here, and `react` keeps its name. See docs/ui-workbench/portability-findings.md.
 */
export const storyFamilySchema = z.enum(["ssr", "react"]);
export type StoryFamily = z.infer<typeof storyFamilySchema>;

export interface WorkbenchVariant {
  id: string;
  title: string;
  notes?: string;
}

export interface WorkbenchStory {
  id: string;
  title: string;
  category: string;
  family: StoryFamily;
  variants: WorkbenchVariant[];
  /**
   * Repository-relative paths shown in the gallery and checked by
   * `npm run ui:validate`. Only the allowlisted registry may reference files;
   * nothing is loaded from a URL.
   */
  sourceFiles: string[];
  /**
   * The stories this one composes — the components its preview renders.
   *
   * Sumomo derives these edges from the markup of a Blade view; Maomao's
   * renderers are plain functions whose composition is only known where they
   * are called, so the story declares it. `npm run ui:validate` checks every
   * id against the registry.
   */
  uses?: string[];
  defaultViewport: ViewportName;
  notes?: string;
  /**
   * Renders the variant into the HTML fragment shown inside the frame. The
   * fragment is production markup — the workbench never rewrites it.
   */
  preview: (variant: WorkbenchVariant) => string;
}

/** One variant as published in the catalog JSON. */
export const catalogVariantSchema = z.object({
  id: slugSchema,
  title: z.string().min(1),
  url: z.string().min(1),
  frameUrl: z.string().min(1),
});

/** One story as published in the catalog JSON. */
export const catalogStorySchema = z.object({
  id: slugSchema,
  title: z.string().min(1),
  category: z.string().min(1),
  family: storyFamilySchema,
  defaultViewport: viewportNameSchema,
  sourceFiles: z.array(z.string().min(1)),
  /**
   * The stories this one composes. Maomao declares the edges on the story
   * (see `WorkbenchStory.uses`); the key and its type stay as Sumomo
   * publishes them.
   */
  uses: z.array(slugSchema),
  notes: z.string().nullable(),
  variants: z.array(catalogVariantSchema).min(1),
});

/**
 * The catalog document served at `/dev/ui/catalog.json`. Browser automation
 * discovers stories here, then opens a variant's `frameUrl` to screenshot it.
 */
export const catalogSchema = z.object({
  generatedBy: z.literal("maomao-ui-workbench"),
  viewports: z.record(
    viewportNameSchema,
    z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  ),
  stories: z.array(catalogStorySchema),
});

export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogStory = z.infer<typeof catalogStorySchema>;
export type CatalogVariant = z.infer<typeof catalogVariantSchema>;
