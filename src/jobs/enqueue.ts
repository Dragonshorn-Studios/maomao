import type { Config } from "../config.js";
import type { EnqueueResult, JobStore, NewJobInput } from "./store.js";
import type { JobQueue } from "./queue.js";

export function reviewerSpecs(config: Config): NewJobInput["reviewers"] {
  return config.reviewers.map((role) => ({
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
  return store.enqueue({
    ...input,
    reviewers: reviewerSpecs(config),
  });
}

export function dispatchEnqueue(queue: JobQueue, result: EnqueueResult): void {
  if (result.created) queue.enqueue(result.job.id);
  if (result.staleJobIds.length) queue.abortMany(result.staleJobIds);
}
