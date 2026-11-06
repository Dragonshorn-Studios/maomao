/**
 * `npm run ui:validate` — the copyable installation check for the workbench.
 *
 * It exits nonzero and explains what to fix when the story set is malformed:
 * duplicate or malformed ids, missing variants, source references that do not
 * resolve inside the repository, a catalog that does not match the published
 * schema, or a variant that renders nothing.
 *
 * The checks live in `validate.ts` so they can be tested; this file is only
 * the command-line entry point.
 */
import { runValidation } from "./validate.js";
import { STORIES } from "./stories.js";

const result = runValidation(STORIES);

for (const problem of result.problems) {
  console.error(problem);
}

if (result.exitCode !== 0) {
  console.error(
    `UI workbench story registry is invalid (${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}).`,
  );
  process.exit(result.exitCode);
}

console.log(
  `UI workbench story registry is valid (${result.stories} stor${result.stories === 1 ? "y" : "ies"}, ${result.variants} variants).`,
);
