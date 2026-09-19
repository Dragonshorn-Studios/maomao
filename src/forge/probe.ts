/**
 * GitLab connection probe: validates a new/updated connection by calling the
 * instance's API v4 through the security boundary. Captures the bot identity,
 * token scopes where discoverable, and the instance version so capability
 * detection can degrade per self-managed version later.
 */
import { SafeHttpError, safeHttpRequest } from "./safe-http.js";
import type { ForgeConnectionStore } from "./connections.js";

export interface ProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
  botUserId?: number;
  botUsername?: string;
  scopes?: string[];
  version?: string;
}

export async function probeConnection(
  store: ForgeConnectionStore,
  connectionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  let connection;
  try {
    connection = store.open(connectionId);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const base = connection.instance.apiBaseUrl;
  const requestBase = {
    bearerToken: connection.token,
    instanceOrigin: connection.instance.origin,
    allowPrivateNetwork: connection.row.allow_private_network === 1,
    caPem: connection.row.ca_pem ?? undefined,
    timeoutMs: opts.timeoutMs,
  };

  const user = await safeHttpRequest({ ...requestBase, url: `${base}/user` })
    .then((response) => {
      if (response.status !== 200) {
        throw new SafeHttpError(
          response.status === 401
            ? "the instance rejected the access token (401)"
            : `instance returned status ${response.status} for /user`,
          response.status,
        );
      }
      return JSON.parse(response.body) as { id?: number; username?: string };
    })
    .catch((error: unknown) => error instanceof SafeHttpError ? error : new SafeHttpError(error instanceof Error ? error.message : String(error)));

  if (user instanceof SafeHttpError || user instanceof Error) {
    return { ok: false, status: user instanceof SafeHttpError ? user.status : undefined, error: user.message };
  }
  if (!Number.isSafeInteger(user.id)) {
    return { ok: false, error: "instance /user response is missing a numeric id" };
  }

  // Token scopes: best-effort; older self-managed versions may not expose
  // the self endpoint to project/group access tokens. Never fatal.
  const scopes = await safeHttpRequest({ ...requestBase, url: `${base}/personal_access_tokens/self` })
    .then((response) => {
      if (response.status !== 200) return undefined;
      const parsed = JSON.parse(response.body) as { scopes?: string[] };
      return Array.isArray(parsed.scopes) ? parsed.scopes : undefined;
    })
    .catch(() => undefined);

  const version = await safeHttpRequest({ ...requestBase, url: `${base}/version` })
    .then((response) => {
      if (response.status !== 200) return undefined;
      return (JSON.parse(response.body) as { version?: string }).version;
    })
    .catch(() => undefined);

  store.recordProbe(connectionId, {
    botUserId: user.id,
    botUsername: user.username,
    scopes,
    version,
  });
  return {
    ok: true,
    status: 200,
    botUserId: user.id,
    botUsername: user.username,
    scopes,
    version,
  };
}
