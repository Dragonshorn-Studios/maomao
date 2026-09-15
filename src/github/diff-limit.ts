export class DiffTooLargeError extends Error {
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number) {
    super(`diff exceeds MAX_DIFF_BYTES (${actualBytes} > ${maxBytes})`);
    this.name = "DiffTooLargeError";
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export function unwrapDiffTooLarge(error: unknown): DiffTooLargeError | undefined {
  let current: unknown = error;
  for (let i = 0; i < 6 && current; i++) {
    if (current instanceof DiffTooLargeError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Octokit `request.fetch` replacement that aborts once the body exceeds `maxBytes`.
 * Non-OK responses are left untouched so GitHub error bodies can be parsed.
 */
export function limitedGithubFetch(maxBytes: number): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (maxBytes <= 0 || !response.ok) return response;
    const body = await readBodyWithByteLimit(response, maxBytes);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Abort reading a GitHub response once it exceeds `maxBytes`. `maxBytes <= 0` disables the cap. */
export async function readBodyWithByteLimit(response: Response, maxBytes: number): Promise<string> {
  if (maxBytes <= 0) return response.text();
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel();
      throw new DiffTooLargeError(length, maxBytes);
    }
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new DiffTooLargeError(total, maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!(error instanceof DiffTooLargeError)) {
      await reader.cancel().catch(() => undefined);
    }
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}
