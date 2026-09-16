import type { Config } from "./config.js";

export interface GithubUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

const OAUTH_HTTP_TIMEOUT_MS = 10_000;

export function oauthEnabled(config: Config): boolean {
  return Boolean(config.oauthClientId && config.oauthClientSecret);
}

export function oauthCallbackUrl(config: Config): string {
  return `${config.publicUrl}/login/github/callback`;
}

export function oauthAuthorizeUrl(config: Config, state: string): string {
  const params = new URLSearchParams({
    client_id: config.oauthClientId,
    redirect_uri: oauthCallbackUrl(config),
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

// Confidential client: the single-use short-lived state plus the exact registered redirect URI
// carry the CSRF/code-injection role, and the client secret authenticates the exchange.
// GitHub has supported PKCE (S256) since 2025-07; adding it would be defense-in-depth.
// No scope is requested, but GitHub may return previously granted scopes for repeat
// authorizations — which is why the token is used once and then discarded.
export async function exchangeOAuthCode(
  config: Config,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: config.oauthClientId,
        client_secret: config.oauthClientSecret,
        code,
        redirect_uri: oauthCallbackUrl(config),
      }),
      signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("oauth: token exchange request failed:", error instanceof Error ? error.message : error);
    return undefined;
  }
  if (!response.ok) {
    console.warn(`oauth: token exchange failed with status=${response.status}`);
    return undefined;
  }
  let body: { access_token?: unknown; error?: unknown };
  try {
    body = (await response.json()) as { access_token?: unknown; error?: unknown };
  } catch {
    console.warn("oauth: token exchange returned a non-JSON body");
    return undefined;
  }
  if (typeof body.access_token === "string" && body.access_token) return body.access_token;
  console.warn(`oauth: token exchange rejected (${String(body.error ?? "unknown error")})`);
  return undefined;
}

export async function fetchGithubUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubUser | undefined> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "maomao",
      },
      signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn("oauth: user lookup request failed:", error instanceof Error ? error.message : error);
    return undefined;
  }
  if (!response.ok) {
    console.warn(`oauth: user lookup failed with status=${response.status}`);
    return undefined;
  }
  let body: { id?: unknown; login?: unknown; avatar_url?: unknown };
  try {
    body = (await response.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
  } catch {
    console.warn("oauth: user lookup returned a non-JSON body");
    return undefined;
  }
  if (typeof body.id !== "number" || !Number.isInteger(body.id) || body.id <= 0) {
    console.warn("oauth: user lookup returned a malformed id");
    return undefined;
  }
  if (typeof body.login !== "string" || !body.login) {
    console.warn("oauth: user lookup returned a malformed login");
    return undefined;
  }
  return {
    id: body.id,
    login: body.login,
    avatarUrl: typeof body.avatar_url === "string" && body.avatar_url.startsWith("https://") ? body.avatar_url : null,
  };
}
