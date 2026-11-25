export interface MergeGroupParticipant {
  number: number;
  headSha: string;
  title: string;
  htmlUrl: string;
}

export interface MergeGroupEvent {
  installationId: number;
  githubAccountId?: number;
  githubRepositoryId?: number;
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  participants: MergeGroupParticipant[];
}

function positiveId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/** Parse the checked parts of a GitHub merge_group webhook payload. */
export function parseMergeGroupPayload(payload: unknown): MergeGroupEvent {
  const root = payload as {
    installation?: { id?: number; account?: { id?: number } };
    repository?: { id?: number; full_name?: string; name?: string; owner?: { login?: string; id?: number } };
    merge_group?: {
      base_sha?: string;
      head_sha?: string;
      base_ref?: string;
      head_ref?: string;
      pull_requests?: Array<{ number?: number; title?: string; html_url?: string; head?: { sha?: string } }>;
    };
  };
  const group = root.merge_group;
  const installationId = positiveId(root.installation?.id);
  const repoOwner = root.repository?.owner?.login;
  const repoName = root.repository?.name;
  const repoFullName = root.repository?.full_name;
  if (!installationId || !repoOwner || !repoName || !repoFullName || !group?.base_sha || !group.head_sha || !group.base_ref || !group.head_ref) {
    throw new Error("merge_group payload missing installation, repository, or merge group SHAs");
  }
  const participants = (group.pull_requests ?? [])
    .filter((pr) => typeof pr.number === "number" && pr.number > 0 && typeof pr.head?.sha === "string" && pr.head.sha.length > 0)
    .map((pr) => ({
      number: pr.number!,
      headSha: pr.head!.sha!,
      title: pr.title ?? "",
      htmlUrl: pr.html_url ?? "",
    }))
    .sort((a, b) => a.number - b.number);
  return {
    installationId,
    githubAccountId: positiveId(root.installation?.account?.id) ?? positiveId(root.repository?.owner?.id),
    githubRepositoryId: positiveId(root.repository?.id),
    repoFullName,
    repoOwner,
    repoName,
    baseSha: group.base_sha,
    headSha: group.head_sha,
    baseRef: stripRefsHeads(group.base_ref),
    headRef: group.head_ref,
    participants,
  };
}

export function mergeGroupPrimaryPrNumber(headRef: string, participants: MergeGroupParticipant[]): number {
  if (participants[0]) return participants[0].number;
  const match = /(?:^|\/)pr-(\d+)(?:-|$)/.exec(headRef);
  return match ? Number(match[1]) : 0;
}

export function mergeGroupMetadata(event: MergeGroupEvent): string {
  return JSON.stringify({
    pullRequests: event.participants,
  });
}
