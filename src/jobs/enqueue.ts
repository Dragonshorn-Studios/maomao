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

export function enqueuePullJob(
  store: JobStore,
  config: Config,
  input: Omit<NewJobInput, "reviewers">,
): EnqueueResult {
  const reviewers = config.routing.mode === "fixed" ? reviewerSpecs(config) : [];
  return store.enqueue({
    ...input,
    reviewers,
  });
}

export function dispatchEnqueue(queue: JobQueue, result: EnqueueResult): void {
  if (result.created) queue.enqueue(result.job.id);
  if (result.staleJobIds.length) queue.abortMany(result.staleJobIds);
}
