/**
 * GitLab connection probe: validates a new/updated connection by calling the
 * instance's API v4 through the security boundary. Captures the bot identity,
 * token scopes where discoverable, and the instance version so capability
 * detection can degrade per self-managed version later. The scope and version
 * endpoints are best-effort by design — their failures are reported per-field
 * in the result, never fatal to the probe.
 */
import { SafeHttpError, safeHttpRequest, type SafeHttpRequest } from "./safe-http.js";
import type { ForgeConnectionStore } from "./connections.js";

export type ProbeResult =
  | {
      ok: true;
      botUserId: number;
      botUsername?: string;
      scopes?: string[];
      version?: string;
      scopesError?: string;
      versionError?: string;
    }
  | { ok: false; status?: number; error: string };

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
  const requestBase: Pick<SafeHttpRequest, "bearerToken" | "instance" | "allowPrivateNetwork" | "caPem" | "timeoutMs"> = {
    bearerToken: connection.token,
    instance: connection.instance,
    allowPrivateNetwork: connection.row.allow_private_network === 1,
    caPem: connection.row.ca_pem ?? undefined,
    timeoutMs: opts.timeoutMs,
  };

  const response = await safeHttpRequest({ ...requestBase, url: `${base}/user` }).catch(
    (error: unknown) =>
      error instanceof SafeHttpError ? error : new SafeHttpError(error instanceof Error ? error.message : String(error)),
  );
  if (response instanceof SafeHttpError) {
    return { ok: false, status: response.status, error: response.message };
  }
  if (response.status !== 200) {
    return {
      ok: false,
      status: response.status,
      error:
        response.status === 401
          ? "the instance rejected the access token (401)"
          : `instance returned status ${response.status} for /user`,
    };
  }
  let user: { id?: unknown; username?: unknown };
  try {
    user = JSON.parse(response.body) as { id?: unknown; username?: unknown };
  } catch {
    return { ok: false, error: "instance /user response was not valid JSON" };
  }
  const botUserId = user.id;
  if (typeof botUserId !== "number" || !Number.isSafeInteger(botUserId)) {
    return { ok: false, error: "instance /user response is missing a numeric id" };
  }
  const botUsername = typeof user.username === "string" ? user.username : undefined;

  // Token scopes: best-effort; older self-managed versions may not expose
  // the self endpoint to project/group access tokens. Never fatal, but the
  // outcome is recorded so "unknown" never masquerades as "checked".
  const scopes = await bestEffort(`${base}/personal_access_tokens/self`, requestBase, (body) => {
    const parsed = JSON.parse(body) as { scopes?: unknown };
    return Array.isArray(parsed.scopes) ? parsed.scopes.map(String) : undefined;
  });

  const version = await bestEffort(`${base}/version`, requestBase, (body) => {
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  });

  const recorded = store.recordProbe(connectionId, {
    botUserId,
    botUsername,
    scopes: scopes.value,
    version: version.value,
  });
  if (!recorded) {
    return { ok: false, error: "connection was deleted while being probed" };
  }
  return {
    ok: true,
    botUserId,
    botUsername,
    scopes: scopes.value,
    version: version.value,
    scopesError: scopes.error,
    versionError: version.error,
  };
}

async function bestEffort<T>(
  url: string,
  requestBase: Pick<SafeHttpRequest, "bearerToken" | "instance" | "allowPrivateNetwork" | "caPem" | "timeoutMs">,
  parse: (body: string) => T | undefined,
): Promise<{ value?: T; error?: string }> {
  try {
    const response = await safeHttpRequest({ ...requestBase, url });
    if (response.status !== 200) {
      return { error: `status ${response.status}` };
    }
    return { value: parse(response.body) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
