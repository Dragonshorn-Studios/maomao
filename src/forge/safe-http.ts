/**
 * The network boundary every GitLab connection talks through. A configured
 * self-managed URL is untrusted input: this client canonicalizes it, enforces
 * the private-address policy, keeps TLS verification on (custom CA bundles
 * only), never sends credentials across a redirect or to a different origin,
 * and bounds every response by time and size.
 */
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";

export interface CanonicalInstance {
  /** Canonical origin: https://host[:port] — no path, query, fragment, or credentials. */
  origin: string;
  /** Lowercased hostname as configured; IPv6 literals keep their brackets. */
  hostname: string;
  port: string;
  /** API base for GitLab API v4: <origin>/api/v4 */
  apiBaseUrl: string;
}

export class InstanceUrlError extends Error {}

/**
 * Parse and canonicalize a configured instance URL. Rejects embedded
 * credentials, non-http(s) schemes, paths, query strings, and (unless the
 * operator opted in) plain HTTP. GitLab serves its API from the origin, so
 * any configured path is almost certainly a misconfiguration.
 */
export function canonicalizeInstanceUrl(
  raw: string,
  opts: { allowInsecureHttp?: boolean } = {},
): CanonicalInstance {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InstanceUrlError("instance URL is not a valid URL");
  }
  if (url.username || url.password) {
    throw new InstanceUrlError("instance URL must not embed credentials");
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "https" && scheme !== "http") {
    throw new InstanceUrlError(`instance URL scheme must be https or http, got ${scheme}`);
  }
  if (scheme === "http" && !opts.allowInsecureHttp) {
    throw new InstanceUrlError("instance URL must use https; plain http needs an explicit opt-in");
  }
  if (!url.hostname) {
    throw new InstanceUrlError("instance URL is missing a hostname");
  }
  // Trailing slashes are paste artifacts, not paths; any other segment is a misconfiguration.
  if (url.pathname.replaceAll("/", "") !== "") {
    throw new InstanceUrlError("instance URL must not include a path (GitLab serves from the origin)");
  }
  if (url.search || url.hash) {
    throw new InstanceUrlError("instance URL must not include a query string or fragment");
  }
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (scheme === "https" ? "443" : "80");
  const origin = `${scheme}://${hostname}${url.port ? `:${url.port}` : ""}`;
  return { origin, hostname, port, apiBaseUrl: `${origin}/api/v4` };
}

const PRIVATE_V4_RANGES: Array<[string, string]> = [
  ["0.0.0.0", "0.255.255.255"],
  ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["198.18.0.0", "198.19.255.255"],
  // Multicast, reserved, and documentation ranges: never legitimate instance targets.
  ["224.0.0.0", "255.255.255.255"],
  ["192.0.2.0", "192.0.2.255"],
  ["198.51.100.0", "198.51.100.255"],
  ["203.0.113.0", "203.0.113.255"],
];

function v4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part! < 0 || part! > 255)) {
    return -1;
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const value = v4ToInt(ip);
  if (value < 0) return true; // not a parseable v4 literal: fail closed
  return PRIVATE_V4_RANGES.some(([start, end]) => value >= v4ToInt(start) && value <= v4ToInt(end));
}

/**
 * Canonicalizes an IPv6 address (expanding :: and IPv4-mapped tails) so
 * compressed and expanded spellings of the same address classify identically.
 * WHATWG's URL parser performs exactly this normalization for bracketed hosts.
 */
function canonicalV6(ip: string): string {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  try {
    // Node keeps brackets on IPv6 hostnames; strip them again.
    return new URL(`http://[${bare}]/`).hostname.replaceAll("[", "").replaceAll("]", "").toLowerCase();
  } catch {
    return bare;
  }
}

function isPrivateV6(ip: string): boolean {
  const normalized = canonicalV6(ip);
  if (normalized === "::" || normalized === "::1") return true;
  if (/^f[cd]/.test(normalized)) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true; // link-local fe80::/10
  if (/^fe[c-f]/.test(normalized)) return true; // deprecated site-local fec0::/10
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  // Hex-form IPv4-mapped addresses (::ffff:7f00:1) share the v4 verdict.
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return isPrivateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  // SIIT ::ffff:0:0/96 (three-group form) reaches IPv4 through translation.
  const siit = normalized.match(/^::ffff:0:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (siit) {
    const hi = parseInt(siit[1]!, 16);
    const lo = parseInt(siit[2]!, 16);
    return isPrivateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  // NAT64 well-known prefix: the embedded IPv4 sits behind a translator, so
  // the verdict is unknowable here — fail closed.
  if (normalized.startsWith("64:ff9b:")) return true;
  // 6to4 (2002::/16): the embedded IPv4 decides, including private targets.
  // The second group may be swallowed by :: compression (x.y.0.0 forms).
  const sixToFour = normalized.match(/^2002:([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?/);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1]!, 16);
    const lo = sixToFour[2] != null ? parseInt(sixToFour[2], 16) : 0;
    return isPrivateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  // IANA special-purpose: documentation (2001:db8::/32) and discard-only (100::/64).
  if (normalized.startsWith("2001:db8:") || normalized.startsWith("100:")) return true;
  return false;
}

/** True when the address is loopback, private, link-local, multicast, or reserved. */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return isPrivateV4(bare);
  if (family === 6) return isPrivateV6(bare);
  return true; // not an IP literal: fail closed
}

/**
 * Resolves the hostname and fails closed when the policy forbids private
 * addresses. All resolved addresses must pass — a mixed answer containing a
 * private address is treated as private (DNS rebinding mitigation; the
 * residual race between this check and connect() is documented and accepted
 * for a self-hosted operator model with explicit opt-in). Bounded by the
 * same timeout as the request so a stalled resolver cannot hang a caller.
 */
export async function assertResolvesWithinPolicy(
  hostname: string,
  opts: { allowPrivateNetwork: boolean; timeoutMs?: number },
): Promise<void> {
  if (opts.allowPrivateNetwork) return;
  const bare = hostname.replace(/^\[|\]$/g, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SafeHttpError(`DNS resolution of ${bare} timed out`)), timeoutMs);
  });
  try {
    const lookupAddresses = Promise.resolve(
      isIP(bare) ? [{ address: bare }] : lookup(bare, { all: true }),
    );
    const records = await Promise.race([lookupAddresses, timeout]);
    const offenders = records.map((record) => record.address).filter((address) => isPrivateAddress(address));
    if (offenders.length > 0) {
      throw new InstanceUrlError(
        `instance host ${bare} resolves to a private address (${offenders.join(", ")}); private network access needs the connection's explicit opt-in`,
      );
    }
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export interface SafeHttpResult {
  status: number;
  body: string;
  contentType?: string;
}

export interface SafeHttpRequest {
  method?: "GET" | "POST" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Bearer token; attached only to requests on the connection's own origin. */
  bearerToken?: string;
  /** The validated connection boundary every request and redirect hop is pinned to. */
  instance: CanonicalInstance;
  allowPrivateNetwork: boolean;
  caPem?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export class SafeHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Maximum redirect hops; the budget is not caller-controllable. */
const MAX_REDIRECTS = 3;

export function safeHttpRequest(input: SafeHttpRequest): Promise<SafeHttpResult> {
  return safeRequestFollow(input, 0);
}

function safeRequestFollow(input: SafeHttpRequest, attempt: number): Promise<SafeHttpResult> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const maxBytes = input.maxBytes ?? 4 * 1024 * 1024;
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return Promise.reject(new SafeHttpError("request URL is invalid"));
  }
  const sameOrigin = `${target.protocol}//${target.host}` === input.instance.origin;
  const token = sameOrigin ? input.bearerToken : undefined;
  // Credentials live only in the dedicated bearer field; caller-supplied
  // authorization/cookie headers are filtered so they can never ride along.
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lowered = name.toLowerCase();
    if (lowered === "authorization" || lowered === "cookie") continue;
    headers[name] = value;
  }
  if (token) headers.authorization = `Bearer ${token}`;

  const policyCheck = assertResolvesWithinPolicy(target.hostname, {
    allowPrivateNetwork: input.allowPrivateNetwork,
    timeoutMs,
  }).catch((error: unknown) => {
    throw error instanceof SafeHttpError || error instanceof InstanceUrlError
      ? error
      : new SafeHttpError(
          `DNS resolution failed for ${target.hostname}: ${error instanceof Error ? error.message : String(error)}`,
        );
  });

  return policyCheck.then(
    () =>
      new Promise<SafeHttpResult>((resolve, reject) => {
        const isHttps = target.protocol === "https:";
        const options: RequestOptions = {
          method: input.method ?? "GET",
          hostname: target.hostname,
          port: target.port || (isHttps ? "443" : "80"),
          path: `${target.pathname}${target.search}`,
          headers,
          // Verification is the default; ca only adds a trusted bundle.
          ...(isHttps ? { ca: input.caPem } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        };
        const send = isHttps ? request : httpRequest;
        const req = send(options, (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location) {
            res.resume();
            res.on("error", (error) => reject(new SafeHttpError(`redirect response failed: ${error.message}`)));
            if (attempt >= MAX_REDIRECTS) {
              reject(new SafeHttpError("too many redirects"));
              return;
            }
            if (input.body != null) {
              reject(new SafeHttpError("redirects are not supported for requests with a body"));
              return;
            }
            let next: URL;
            try {
              next = new URL(location, target);
            } catch {
              reject(new SafeHttpError("redirect location is invalid"));
              return;
            }
            if (`${next.protocol}//${next.host}` !== input.instance.origin) {
              reject(new SafeHttpError("redirect leaves the instance origin; refusing to follow"));
              return;
            }
            // A redirect target is server-chosen, so credentials never follow
            // it — even when it stays on the instance origin — and 301/302/303
            // degrade to GET. 307/308 keep their (bodyless) method.
            const redirected: SafeHttpRequest = {
              ...input,
              url: next.toString(),
              body: undefined,
              bearerToken: undefined,
              method:
                (status === 301 || status === 302 || status === 303) && (input.method ?? "GET") !== "GET"
                  ? "GET"
                  : input.method,
            };
            safeRequestFollow(redirected, attempt + 1).then(resolve, reject);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy();
              reject(new SafeHttpError(`response exceeds ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            resolve({
              status,
              body: Buffer.concat(chunks).toString("utf8"),
              contentType: res.headers["content-type"],
            });
          });
          res.on("error", (error) => reject(new SafeHttpError(error.message)));
        });
        req.on("error", (error) => {
          if (req.destroyed && (error.name === "AbortError" || error.name === "TimeoutError")) {
            reject(new SafeHttpError(`request to ${input.instance.origin} timed out after ${timeoutMs}ms`));
            return;
          }
          reject(new SafeHttpError(error.message));
        });
        if (input.body != null) req.write(input.body);
        req.end();
      }),
  );
}
