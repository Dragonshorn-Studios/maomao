/**
 * Tests for the HTTPS branch of the safe-http boundary (verification stays
 * on; custom CA bundles are additive) and the GitLab connection probe, over
 * a real local TLS/HTTP server.
 */
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizeInstanceUrl, SafeHttpError, safeHttpRequest } from "./safe-http.js";
import { TEST_CERT_PEM, TEST_KEY_PEM } from "./https-fixture.js";
import { ForgeConnectionStore } from "./connections.js";
import { probeConnection } from "./probe.js";
import { generateForgeKeyHex } from "./secretbox.js";
import { openDb } from "../db.js";

describe("safeHttpRequest over TLS", () => {
  let server: Server;
  let httpsOrigin: string;

  beforeAll(async () => {
    server = createHttpsServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM }, (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ secure: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    httpsOrigin = `https://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function request(caPem?: string): Promise<unknown> {
    return safeHttpRequest({
      url: `${httpsOrigin}/api/v4/user`,
      instance: canonicalizeInstanceUrl(httpsOrigin),
      allowPrivateNetwork: true,
      caPem,
      timeoutMs: 2_000,
    });
  }

  it("succeeds when the connection trusts the instance CA", async () => {
    const result = (await request(TEST_CERT_PEM)) as { status: number; body: string };
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ secure: true });
  });

  it("keeps TLS verification on: an unknown CA is rejected", async () => {
    await expect(request()).rejects.toThrow(SafeHttpError);
  });

  it("keeps TLS verification on: the wrong CA is rejected", async () => {
    await expect(request(TEST_CERT_PEM.replace(/T/g, "T").slice(0, 900) + "\n")).rejects.toThrow(SafeHttpError);
  });
});

describe("probeConnection", () => {
  let server: Server;
  let origin: string;
  const store = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
  let connectionId: string;

  beforeAll(async () => {
    const responses: Record<string, { status: number; body?: string }> = {
      "/api/v4/user": { status: 200, body: JSON.stringify({ id: 42, username: "maomao-bot" }) },
      "/api/v4/personal_access_tokens/self": { status: 403 },
      "/api/v4/version": { status: 500 },
    };
    server = createServer((req, res) => {
      // Token check: anything but the probe-test token is rejected, so the
      // bad-token store in the 401 test exercises the real diagnosis path.
      if (req.headers.authorization !== "Bearer glpat-probe-token-value") {
        res.writeHead(401);
        res.end();
        return;
      }
      const response = responses[req.url ?? ""] ?? { status: 404 };
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(response.body ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;

    connectionId = store
      .create({
        provider: "gitlab",
        label: "probe-test",
        instanceUrl: origin,
        token: "glpat-probe-token-value",
        tokenType: "pat",
        scopeType: "instance",
        scopePath: "",
        webhookSecret: "whsec-probe-value",
        allowPrivateNetwork: true,
        allowInsecureHttp: true,
        allowApprove: false,
      })
      .id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("reports a bad token with the operator-facing 401 diagnosis", async () => {
    const badTokenStore = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
    const badId = badTokenStore
      .create({
        provider: "gitlab",
        label: "bad-token",
        instanceUrl: origin,
        token: "glpat-wrong-token-value",
        tokenType: "pat",
        scopeType: "instance",
        scopePath: "",
        webhookSecret: "whsec-wrong-value",
        allowPrivateNetwork: true,
        allowInsecureHttp: true,
        allowApprove: false,
      })
      .id;
    const probe = await probeConnection(badTokenStore, badId, { timeoutMs: 2_000 });
    expect(probe).toMatchObject({ ok: false, status: 401 });
    if (!probe.ok) expect(probe.error).toMatch(/rejected the access token/);
  });

  it("validates the bot identity but treats scope/version endpoints as best-effort", async () => {
    const probe = await probeConnection(store, connectionId, { timeoutMs: 2_000 });
    expect(probe.ok).toBe(true);
    if (probe.ok) {
      expect(probe.botUserId).toBe(42);
      expect(probe.botUsername).toBe("maomao-bot");
      // The 403/500 on the optional endpoints is recorded, not swallowed.
      expect(probe.scopes).toBeUndefined();
      expect(probe.scopesError).toBe("status 403");
      expect(probe.version).toBeUndefined();
      expect(probe.versionError).toBe("status 500");
    }
    const row = store.get(connectionId)!;
    expect(row.bot_username).toBe("maomao-bot");
    expect(row.last_probed_at).toBeTruthy();
  });

  it("refuses a /user response without a numeric id", async () => {
    const responses: Record<string, { status: number; body?: string }> = {
      "/api/v4/user": { status: 200, body: JSON.stringify({ username: "no-id" }) },
    };
    const rogue = createServer((req, res) => {
      const response = responses[req.url ?? ""] ?? { status: 404 };
      res.writeHead(response.status);
      res.end(response.body ?? "");
    });
    await new Promise<void>((resolve) => rogue.listen(0, "127.0.0.1", resolve));
    const address = rogue.address() as AddressInfo;
    const rogueStore = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
    const rogueId = rogueStore
      .create({
        provider: "gitlab",
        label: "rogue",
        instanceUrl: `http://127.0.0.1:${address.port}`,
        token: "glpat-rogue-token-value",
        tokenType: "pat",
        scopeType: "instance",
        scopePath: "",
        webhookSecret: "whsec-rogue-value",
        allowPrivateNetwork: true,
        allowInsecureHttp: true,
        allowApprove: false,
      })
      .id;
    try {
      const probe = await probeConnection(rogueStore, rogueId, { timeoutMs: 2_000 });
      expect(probe).toMatchObject({ ok: false });
      if (!probe.ok) expect(probe.error).toMatch(/missing a numeric id/);
    } finally {
      await new Promise<void>((resolve) => rogue.close(() => resolve()));
    }
  });

  it("fails cleanly for a connection that does not exist", async () => {
    const probe = await probeConnection(store, "no-such-connection");
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.error).toMatch(/does not exist/);
  });

  it("fails cleanly when the instance is unreachable", async () => {
    const deadStore = new ForgeConnectionStore(openDb(":memory:"), Buffer.from(generateForgeKeyHex(), "hex"));
    const deadId = deadStore
      .create({
        provider: "gitlab",
        label: "dead",
        instanceUrl: "http://127.0.0.1:9",
        token: "glpat-dead-token-value",
        tokenType: "pat",
        scopeType: "instance",
        scopePath: "",
        webhookSecret: "whsec-dead-value",
        allowPrivateNetwork: true,
        allowInsecureHttp: true,
        allowApprove: false,
      })
      .id;
    const probe = await probeConnection(deadStore, deadId, { timeoutMs: 1_000 });
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.status).toBeUndefined();
  });
});
