export class PullUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullUrlError";
  }
}

export function parseGithubPullUrl(raw: string): { owner: string; repo: string; number: number } {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new PullUrlError("Paste a GitHub pull request URL, for example https://github.com/owner/repo/pull/123");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new PullUrlError("Not a valid URL. Example: https://github.com/owner/repo/pull/123");
  }

  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "github.com") {
    throw new PullUrlError("Only github.com pull request URLs are supported.");
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/i);
  if (!match) {
    throw new PullUrlError("URL must look like https://github.com/owner/repo/pull/123");
  }

  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  const number = Number(match[3]);
  if (!owner || !repo || !Number.isInteger(number) || number < 1) {
    throw new PullUrlError("URL must look like https://github.com/owner/repo/pull/123");
  }
  return { owner, repo, number };
}
