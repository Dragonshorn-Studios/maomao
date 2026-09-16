import { describe, expect, it, vi } from "vitest";
import { exchangeOAuthCode, fetchGithubUser } from "./oauth.js";
import type { Config } from "./config.js";

function config(): Config {
  return {
    oauthClientId: "cid",
    oauthClientSecret: "csecret",
    publicUrl: "https://maomao.example",
  } as unknown as Config;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("oauth token exchange", () => {
  it("returns the access token on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: "tok" }));
    expect(await exchangeOAuthCode(config(), "good-code", fetchImpl as unknown as typeof fetch)).toBe("tok");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(String(init.body))).toMatchObject({ client_id: "cid", code: "good-code" });
  });

  it("returns undefined on GitHub's 200-with-error body (e.g. bad_verification_code)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "bad_verification_code" }));
    expect(await exchangeOAuthCode(config(), "stale-code", fetchImpl as unknown as typeof fetch)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns undefined on non-200 responses and transport failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    expect(await exchangeOAuthCode(config(), "code", failing as unknown as typeof fetch)).toBeUndefined();
    const throwing = vi.fn().mockRejectedValue(new Error("dns gone"));
    expect(await exchangeOAuthCode(config(), "code", throwing as unknown as typeof fetch)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("oauth user lookup", () => {
  it("maps a well-formed GitHub user", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ id: 1001, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/1001" }),
    );
    expect(await fetchGithubUser("tok", fetchImpl as unknown as typeof fetch)).toEqual({
      id: 1001,
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/1001",
    });
  });

  it.each([
    ["non-200", new Response("nope", { status: 401 })],
    ["malformed id", jsonResponse({ id: "1001", login: "octocat" })],
    ["missing login", jsonResponse({ id: 1001 })],
    ["empty login", jsonResponse({ id: 1001, login: "" })],
  ])("returns undefined on %s", async (_name, response) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(response);
    expect(await fetchGithubUser("tok", fetchImpl as unknown as typeof fetch)).toBeUndefined();
    warn.mockRestore();
  });
});
