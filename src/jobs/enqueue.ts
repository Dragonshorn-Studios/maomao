import type { Config } from "../config.js";
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
 * Constrains reviewer specs to the job's profile revision: roles, order, per-role models.
 * The revision is resolved from the job's enqueue-time stamp, never from the live active
 * revision, so all stages of one job see the same configuration. When the profile leaves
 * no runnable role from the specs, the env configuration runs instead (warned loudly).
 */
export function applyProfileToSpecs(
  store: JobStore,
  config: Config,
  specs: NewJobInput["reviewers"],
  revisionId: number | null | undefined,
): NewJobInput["reviewers"] {
  const revision = revisionId ? store.configs.getRevision(revisionId) : undefined;
  if (!revision) return specs;
  const byRole = new Map<string, NewJobInput["reviewers"][number]>(
    revision.definition.reviewers.map((reviewer) => [reviewer.role, { role: reviewer.role, title: reviewer.role, model: reviewer.model }]),
  );
  let constrained: NewJobInput["reviewers"] = specs.filter((spec) => byRole.has(spec.role));
  if (constrained.length === 0) {
    constrained = [...byRole.values()];
  }
  if (constrained.length === 0) {
    console.warn(
      `profile revision #${revision.id} (${revision.name}) selects no configured reviewer roles; running env roles`,
    );
    return specs;
  }
  return constrained.map((spec) => {
    const override = byRole.get(spec.role);
    return override?.model ? { ...spec, model: override.model } : spec;
  });
}

export function enqueuePullJob(
  store: JobStore,
  config: Config,
  input: Omit<NewJobInput, "reviewers"> & { profileRevisionId?: number },
): EnqueueResult {
  const reviewers =
    config.routing.mode === "fixed"
      ? applyProfileToSpecs(store, config, reviewerSpecs(config), input.profileRevisionId ?? store.configs.getActiveRevision("default")?.id ?? null)
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
