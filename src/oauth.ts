import type { Config } from "./config.js";

export interface GithubUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

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

/**
 * GitHub OAuth apps do not support PKCE; the single-use short-lived state and the exact
 * redirect URI registered with the app carry the CSRF/protection role instead.
 * The scope stays empty: this exchange must only ever identify the operator.
 */
export async function exchangeOauthCode(
  config: Config,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const response = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: config.oauthClientId,
      client_secret: config.oauthClientSecret,
      code,
      redirect_uri: oauthCallbackUrl(config),
    }),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { access_token?: unknown; error?: unknown };
  return typeof body.access_token === "string" && body.access_token ? body.access_token : undefined;
}

export async function fetchGithubUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubUser | undefined> {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "maomao",
    },
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
  if (typeof body.id !== "number" || !Number.isInteger(body.id) || body.id <= 0) return undefined;
  if (typeof body.login !== "string" || !body.login) return undefined;
  return {
    id: body.id,
    login: body.login,
    avatarUrl: typeof body.avatar_url === "string" && body.avatar_url.startsWith("https://") ? body.avatar_url : null,
  };
}
