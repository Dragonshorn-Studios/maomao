import type { Config } from "../config.js";
import type { ProfileDefinition } from "../config-revisions.js";
import { KNOWN_REVIEWER_ROLES } from "../prompts.js";
import type { EnqueueResult, JobStore, NewJobInput } from "./store.js";
import type { JobQueue } from "./queue.js";

export function reviewerSpecs(config: Config, roleIds?: string[]): NewJobInput["reviewers"] {
  const selected = roleIds
    ? config.reviewers.filter((role) => roleIds.includes(role.id))
    : config.reviewers;
  return selected.map((role) => ({
    role: role.id,
    title: role.title,
    model: role.model || config.opencode.reviewerModel || undefined,
  }));
}

/**
 * Applies the job's profile revision to reviewer specs. The GUI-set profile
 * overrides the environment: an applied revision defines the reviewer set —
 * its roles run in profile order regardless of REVIEWER_ROLES, env values
 * only supplying default titles and models the profile does not pin.
 *
 * `specs` is the caller's requested subset: pass `wholeProfileSet: true` for
 * the "run the configured set" paths (fixed-mode enqueue) so the profile list
 * fully replaces it, or `requestedRoles` for routed jobs — the router's raw
 * picks, intersected in profile order. When the profile shares no role with
 * a requested subset, the whole profile list still runs — the GUI revision
 * decides. The revision is resolved from the job's enqueue-time stamp, never
 * from the live active revision, so all stages of one job see the same
 * configuration.
 */
export function applyProfileToSpecs(
  store: JobStore,
  config: Config,
  specs: NewJobInput["reviewers"],
  revisionId: number | null | undefined,
  options?: { wholeProfileSet?: boolean; requestedRoles?: string[] },
): NewJobInput["reviewers"] {
  const revision = revisionId ? store.configs.getRevision(revisionId) : undefined;
  if (!revision) return specs;
  const envByRole = new Map(config.reviewers.map((role) => [role.id, role]));
  const knownByRole = new Map(KNOWN_REVIEWER_ROLES.map((role) => [role.id, role]));
  const toSpec = (reviewer: ProfileDefinition["reviewers"][number]) => {
    const envRole = envByRole.get(reviewer.role);
    return {
      role: reviewer.role,
      title: envRole?.title ?? knownByRole.get(reviewer.role)?.title ?? reviewer.role,
      model: reviewer.model || envRole?.model || config.opencode.reviewerModel || undefined,
    };
  };
  const requested = new Set(options?.requestedRoles ?? specs.map((spec) => spec.role));
  const selected = options?.wholeProfileSet
    ? revision.definition.reviewers
    : revision.definition.reviewers.filter((reviewer) => requested.has(reviewer.role));
  const constrained = (selected.length > 0 ? selected : revision.definition.reviewers).map(toSpec);
  if (constrained.length === 0) {
    console.warn(
      `profile revision #${revision.id} (${revision.name}) selects no reviewer roles; running env roles`,
    );
    return specs;
  }
  return constrained;
}

export function enqueuePullJob(
  store: JobStore,
  config: Config,
  input: Omit<NewJobInput, "reviewers"> & { profileRevisionId?: number },
): EnqueueResult {
  const reviewers =
    config.routing.mode === "fixed"
      ? applyProfileToSpecs(store, config, reviewerSpecs(config), input.profileRevisionId ?? store.configs.resolveProfileForRepo(input.repoFullName)?.id ?? null, { wholeProfileSet: true })
      : [];
  return store.enqueue({
    ...input,
    reviewers,
  });
}

export function dispatchEnqueue(queue: JobQueue, result: EnqueueResult): void {
  if (result.created) queue.enqueue(result.job.id);
  if (result.staleJobIds.length) queue.abortMany(result.staleJobIds);
}
