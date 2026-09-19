import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertResolvesWithinPolicy,
  canonicalizeInstanceUrl,
  InstanceUrlError,
  isPrivateAddress,
  SafeHttpError,
  safeHttpRequest,
} from "./safe-http.js";
import { generateForgeKeyHex, loadForgeKey, openSecret, sealSecret, secretFingerprint } from "./secretbox.js";
import { ForgeConnectionStore, type ForgeConnectionRow } from "./connections.js";
import { ensureEnvGitLabConnection, ENV_CONNECTION_LABEL } from "./bootstrap.js";
import { openDb } from "../db.js";
import { loadConfig } from "../config.js";
import { renderConnectionsPage } from "../ui/connections.js";

describe("connections page", () => {
  it("renders identity and fingerprints but never secret material", () => {
    const row = {
      id: "conn-1",
      provider: "gitlab",
      label: "acme",
      instance_base_url: "https://gitlab.corp.internal",
      api_base_url: "https://gitlab.corp.internal/api/v4",
      token_sealed: "v1.aGVsbG8.aGVsbG8.aGVsbG8",
      token_fingerprint: "7890",
      token_type: "project",
      scope_type: "group",
      scope_path: "acme",
      webhook_secret_sealed: "v1.aGVsbG8.aGVsbG8.aGVsbG8",
      ca_pem: null,
      allow_private_network: 1,
      allow_insecure_http: 0,
      allow_approve: 0,
      enabled: 1,
      bot_user_id: 42,
      bot_username: "maomao-bot",
      token_scopes_json: JSON.stringify(["api", "read_repository"]),
      version_json: JSON.stringify("17.2.1"),
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    } as unknown as ForgeConnectionRow;
    const html = renderConnectionsPage({
      connections: [row],
      csrfToken: undefined,
      options: {},
    });
    expect(html).toContain("gitlab.corp.internal");
    expect(html).toContain("···7890");
    expect(html).toContain(`/webhooks/gitlab/${row.id}`);
    expect(html).not.toContain("glpat-token");
    expect(html).not.toContain("whsec-");
    expect(html).not.toContain(row.token_sealed);
    expect(html).not.toContain(row.webhook_secret_sealed);
  });

  it("escapes hostile strings in row fields and tolerates corrupt probe JSON", () => {
    const row = {
      id: "conn-2",
      provider: "gitlab",
      label: '<img src=x onerror=alert(1)>',
      instance_base_url: "https://gitlab.corp.internal",
      api_base_url: "https://gitlab.corp.internal/api/v4",
      token_sealed: "v1.aaa.bbb.ccc",
      token_fingerprint: "7890",
      token_type: "project",
      scope_type: "group",
      scope_path: '<script>alert(1)</script>',
      webhook_secret_sealed: "v1.aaa.bbb.ccc",
      webhook_secret_fingerprint: "b-78",
      ca_pem: null,
      allow_private_network: 1,
      allow_insecure_http: 0,
      allow_approve: 0,
      enabled: 1,
      bot_user_id: 42,
      bot_username: '"><svg onload=alert(2)>',
      token_scopes_json: "{corrupt",
      version_json: '{"version": {"nested": true}}',
      last_probed_at: null,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    } as unknown as ForgeConnectionRow;
    const html = renderConnectionsPage({ connections: [row], csrfToken: undefined, options: {} });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<svg onload=alert(2)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Corrupt or non-string probe JSON omits the pair rather than throwing mid-render.
    expect(html).not.toContain("Scopes <strong>");
    expect(html).not.toContain("Version <strong>");
  });
});

describe("canonicalizeInstanceUrl", () => {
  it("canonicalizes origins and derives the API base", () => {
    expect(canonicalizeInstanceUrl("https://gitlab.com")).toEqual({
      origin: "https://gitlab.com",
      hostname: "gitlab.com",
      port: "443",
      apiBaseUrl: "https://gitlab.com/api/v4",
    });
    expect(canonicalizeInstanceUrl("https://GitLab.Corp.Internal:8443//").origin).toBe(
      "https://gitlab.corp.internal:8443",
    );
  });

  it("rejects embedded credentials, paths, queries, and odd schemes", () => {
    expect(() => canonicalizeInstanceUrl("https://user:pass@gitlab.com")).toThrow(InstanceUrlError);
    expect(() => canonicalizeInstanceUrl("https://gitlab.com/acme")).toThrow(InstanceUrlError);
    expect(() => canonicalizeInstanceUrl("https://gitlab.com?x=1")).toThrow(InstanceUrlError);
    expect(() => canonicalizeInstanceUrl("ftp://gitlab.com")).toThrow(InstanceUrlError);
    expect(() => canonicalizeInstanceUrl("not a url")).toThrow(InstanceUrlError);
  });

  it("requires an explicit opt-in for plain HTTP", () => {
    expect(() => canonicalizeInstanceUrl("http://gitlab.corp.internal")).toThrow(/must use https/);
    expect(canonicalizeInstanceUrl("http://gitlab.corp.internal", { allowInsecureHttp: true }).origin).toBe(
      "http://gitlab.corp.internal",
    );
  });
});

describe("isPrivateAddress", () => {
  it("classifies private, loopback, link-local, and public addresses", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.1.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateAddress("[::1]")).toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("fec0::1")).toBe(true);
    expect(isPrivateAddress("fed0::1")).toBe(true);
    expect(isPrivateAddress("feff::1")).toBe(true);
    expect(isPrivateAddress("::ffff:0:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("64:ff9b:7f00:1::1")).toBe(true);
    expect(isPrivateAddress("2002:7f00:1::1")).toBe(true);
    expect(isPrivateAddress("2002:7f00::1")).toBe(true);
    expect(isPrivateAddress("2002:ac10::")).toBe(true);
    expect(isPrivateAddress("2002:8080:8080::1")).toBe(false);
    expect(isPrivateAddress("2001:db8::1")).toBe(true);
    expect(isPrivateAddress("100::1")).toBe(true);
    expect(isPrivateAddress("2606:4700::1")).toBe(false);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("140.82.121.4")).toBe(false);
  });

  it("fails closed on values that are not addresses", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("assertResolvesWithinPolicy", () => {
  it("refuses localhost without the private-network opt-in", async () => {
    await expect(assertResolvesWithinPolicy("localhost", { allowPrivateNetwork: false })).rejects.toThrow(
      /private address/,
    );
  });

  it("allows any host when the connection opted in", async () => {
    await expect(assertResolvesWithinPolicy("localhost", { allowPrivateNetwork: true })).resolves.toBeUndefined();
  });
});

describe("safeHttpRequest", () => {
  let server: Server;
  let baseUrl: string;
  let allowPrivate: boolean;
  const seen: Array<{ url: string; authorization?: string; method: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization, method: req.method ?? "" });
      if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/huge") {
        res.writeHead(200);
        res.end("x".repeat(1024));
        return;
      }
      if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200);
          res.end("late");
        }, 5_000);
        return;
      }
      if (req.url === "/hop") {
        // Same-origin redirect: credentials must be dropped before following.
        res.writeHead(302, { location: "/json" });
        res.end();
        return;
      }
      if (req.url === "/escape") {
        res.writeHead(302, { location: "https://example.com/steal" });
        res.end();
        return;
      }
      if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    allowPrivate = true;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function requestBase(url: string): Parameters<typeof safeHttpRequest>[0] {
    return {
      url: `${baseUrl}${url}`,
      instance: canonicalizeInstanceUrl(baseUrl, { allowInsecureHttp: true }),
      allowPrivateNetwork: allowPrivate,
      bearerToken: "glpat-test-token-value",
      maxBytes: 512,
      timeoutMs: 2_000,
    };
  }

  it("performs a same-origin GET with the bearer token attached", async () => {
    const result = await safeHttpRequest(requestBase("/json"));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
    expect(seen.at(-1)?.authorization).toBe("Bearer glpat-test-token-value");
  });

  it("drops the bearer token when following a same-origin redirect", async () => {
    const result = await safeHttpRequest(requestBase("/hop"));
    expect(result.status).toBe(200);
    expect(seen.filter((entry) => entry.url === "/json").at(-1)?.authorization).toBeUndefined();
  });

  it("refuses redirects that leave the instance origin", async () => {
    await expect(safeHttpRequest(requestBase("/escape"))).rejects.toThrow(/leaves the instance origin/);
  });

  it("refuses to follow endless redirect loops", async () => {
    await expect(safeHttpRequest(requestBase("/loop"))).rejects.toThrow(/too many redirects/);
  });

  it("aborts responses over the byte cap", async () => {
    await expect(safeHttpRequest(requestBase("/huge"))).rejects.toThrow(/exceeds 512 bytes/);
  });

  it("times out slow responses", async () => {
    await expect(safeHttpRequest({ ...requestBase("/slow"), timeoutMs: 50 })).rejects.toThrow();
  });

  it("rejects request URLs that are not valid URLs", async () => {
    await expect(safeHttpRequest({ ...requestBase(""), url: "not a url" })).rejects.toThrow(SafeHttpError);
  });
});

describe("secretbox", () => {
  it("round-trips secrets and hints only the tail", () => {
    const key = Buffer.from(generateForgeKeyHex(), "hex");
    const sealed = sealSecret(key, "glpat-abcdef123456");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("glpat-abcdef123456");
    expect(openSecret(key, sealed)).toBe("glpat-abcdef123456");
    expect(secretFingerprint("glpat-abcdef123456")).toBe("3456");
  });

  it("fails with the wrong key or a malformed sealed value", () => {
    const key = Buffer.from(generateForgeKeyHex(), "hex");
    const other = Buffer.from(generateForgeKeyHex(), "hex");
    const sealed = sealSecret(key, "secret-value");
    expect(() => openSecret(other, sealed)).toThrow();
    expect(() => openSecret(key, "garbage")).toThrow(/malformed/);
  });

  it("stretches passphrases deterministically", () => {
    const key = Buffer.from(generateForgeKeyHex(), "hex");
    const sealed = sealSecret(key, "secret-value");
    expect(openSecret(key, sealed)).toBe("secret-value");
  });
});

describe("ForgeConnectionStore", () => {
  function newStore(): ForgeConnectionStore {
    return new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
  }

  function input(overrides: Record<string, unknown> = {}) {
    return {
      provider: "gitlab" as const,
      label: "acme",
      instanceUrl: "https://gitlab.corp.internal",
      token: "glpat-token-1234567890",
      tokenType: "project" as const,
      scopeType: "group" as const,
      scopePath: "acme",
      webhookSecret: "whsec-1234567890",
      allowPrivateNetwork: true,
      allowInsecureHttp: false,
      allowApprove: false,
      ...overrides,
    };
  }

  it("creates, opens, and isolates connections; secrets never land in the row", () => {
    const store = newStore();
    const row = store.create(input());
    expect(row.instance_base_url).toBe("https://gitlab.corp.internal");
    expect(row.token_sealed).not.toContain("glpat-token");
    expect(row.webhook_secret_sealed).not.toContain("whsec-");
    expect(row.token_fingerprint).toBe("7890");
    const opened = store.open(row.id);
    expect(opened.token).toBe("glpat-token-1234567890");
    expect(opened.webhookSecret).toBe("whsec-1234567890");
    expect(opened.instance.apiBaseUrl).toBe("https://gitlab.corp.internal/api/v4");
    expect(store.list("gitlab")).toHaveLength(1);
    expect(store.list("github")).toHaveLength(0);
  });

  it("rotates the token via update and reports it through the fingerprint", () => {
    const store = newStore();
    const row = store.create(input());
    store.update(row.id, { token: "glpat-rotated-9876543" });
    const updated = store.get(row.id)!;
    expect(updated.token_fingerprint).toBe("6543");
    expect(store.open(row.id).token).toBe("glpat-rotated-9876543");
  });

  it("records probe results without inventing values", () => {
    const store = newStore();
    const row = store.create(input());
    store.recordProbe(row.id, { botUserId: 42, botUsername: "maomao-bot", scopes: ["api"], version: "17.2.1" });
    const updated = store.get(row.id)!;
    expect(updated.bot_username).toBe("maomao-bot");
    expect(JSON.parse(updated.token_scopes_json!)).toEqual(["api"]);
    expect(JSON.parse(updated.version_json!)).toBe("17.2.1");
    store.recordProbe(row.id, {});
    expect(store.get(row.id)!.bot_username).toBe("maomao-bot");
  });

  it("rejects weak tokens and unsupported providers", () => {
    const store = newStore();
    expect(() => store.create(input({ token: "short" }))).toThrow(/at least 8/);
    expect(() => store.create(input({ provider: "github" as never }))).toThrow(/unsupported forge provider/);
  });

  it("deletes connections", () => {
    const store = newStore();
    const row = store.create(input());
    expect(store.delete(row.id)).toBe(true);
    expect(store.get(row.id)).toBeUndefined();
  });

  it("enforces create()-time invariants across updates", () => {
    const store = newStore();
    const row = store.create(input());
    store.create(input({ label: "other", scopeType: "instance" as const, scopePath: "" }));
    // Rename colliding with an existing label on the same origin is refused.
    expect(() => store.update(row.id, { label: "other" })).toThrow(/already exists/);
    // Clearing the scope path while scope stays group-scoped is refused.
    expect(() => store.update(row.id, { scopePath: "" })).toThrow(/scope type group/);
    // A consistent combined patch passes.
    store.update(row.id, { scopeType: "instance", scopePath: "" });
    expect(store.get(row.id)!.scope_type).toBe("instance");
  });
});

describe("ensureEnvGitLabConnection", () => {
  function envWith(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
    return {
      GITLAB_BASE_URL: "https://gitlab.com",
      GITLAB_TOKEN: "glpat-bootstrap-token-1",
      GITLAB_WEBHOOK_SECRET: "whsec-bootstrap-1",
      ...overrides,
    } as NodeJS.ProcessEnv;
  }

  it("seeds once and rotates in place on re-boot", () => {
    const store = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
    const config = loadConfig(envWith({}));
    const first = ensureEnvGitLabConnection(store, config);
    expect(first?.created).toBe(true);
    const second = ensureEnvGitLabConnection(store, config);
    expect(second?.created).toBe(false);
    expect(second?.updated).toBe(false);
    expect(store.list("gitlab")).toHaveLength(1);

    const rotated = ensureEnvGitLabConnection(
      store,
      loadConfig(envWith({ GITLAB_TOKEN: "glpat-bootstrap-token-2" })),
    );
    expect(rotated?.updated).toBe(true);
    expect(store.open(rotated!.id).token).toBe("glpat-bootstrap-token-2");
    expect(store.get(rotated!.id)!.label).toBe(ENV_CONNECTION_LABEL);
  });

  it("matches the existing env connection across equivalent origin spellings", () => {
    const store = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
    const first = ensureEnvGitLabConnection(
      store,
      loadConfig(envWith({ GITLAB_BASE_URL: "https://gitlab.com/" })),
    );
    expect(first?.created).toBe(true);
    const variants = ["https://gitlab.com", "HTTPS://GitLab.com", "https://gitlab.com:443"];
    for (const baseUrl of variants) {
      const again = ensureEnvGitLabConnection(store, loadConfig(envWith({ GITLAB_BASE_URL: baseUrl })));
      expect(again?.created).toBe(false);
    }
    expect(store.list("gitlab")).toHaveLength(1);
  });

  it("disables a stale env connection from a different origin", () => {
    const store = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
    const first = ensureEnvGitLabConnection(store, loadConfig(envWith({ GITLAB_BASE_URL: "https://old.gitlab.example" })));
    expect(first?.created).toBe(true);
    const second = ensureEnvGitLabConnection(
      store,
      loadConfig(envWith({ GITLAB_BASE_URL: "https://new.gitlab.example" })),
    );
    expect(second?.created).toBe(true);
    const stale = store.get(first!.id)!;
    expect(stale.enabled).toBe(0);
    expect(store.get(second!.id)!.enabled).toBe(1);
  });

  it("refuses to seed a bootstrap that violates the URL policy", () => {
    const store = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
    const config = loadConfig(envWith({ GITLAB_BASE_URL: "https://user:pass@gitlab.com" }));
    expect(() => ensureEnvGitLabConnection(store, config)).toThrow(InstanceUrlError);
  });
});

describe("loadForgeKey", () => {
  it("accepts 64-char hex keys verbatim and stretches passphrases deterministically", () => {
    const hex = generateForgeKeyHex();
    const fromHex = loadForgeKey({ MAOMAO_FORGE_KEY: hex });
    expect(fromHex?.toString("hex")).toBe(hex);
    const passphrase = loadForgeKey({ MAOMAO_FORGE_KEY: "op-secret-passphrase" });
    expect(passphrase?.length).toBe(32);
    expect(loadForgeKey({ MAOMAO_FORGE_KEY: "op-secret-passphrase" })?.toString("hex")).toBe(
      passphrase?.toString("hex"),
    );
    expect(loadForgeKey({})).toBeUndefined();
  });
});
