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
  /** Lowercased hostname as configured. */
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
    throw new InstanceUrlError(`instance URL is not a valid URL: ${JSON.stringify(raw)}`);
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
];

function v4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const value = v4ToInt(ip);
  return PRIVATE_V4_RANGES.some(([start, end]) => value >= v4ToInt(start) && value <= v4ToInt(end));
}

function isPrivateV6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/%.*$/, "");
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local fc00::/7
  if (normalized.startsWith("::ffff:")) return isPrivateV4(normalized.slice(7));
  return false;
}

/** True when the address is loopback, private, or link-local. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true; // not an IP literal: fail closed
}

/**
 * Resolves the hostname and fails closed when the policy forbids private
 * addresses. All resolved addresses must pass — a mixed answer containing a
 * private address is treated as private (DNS rebinding mitigation; the
 * residual race between this check and connect() is documented and accepted
 * for a self-hosted operator model with explicit opt-in).
 */
export async function assertResolvesWithinPolicy(
  hostname: string,
  opts: { allowPrivateNetwork: boolean },
): Promise<void> {
  if (opts.allowPrivateNetwork) return;
  const literal = isIP(hostname)
    ? [hostname]
    : await lookup(hostname, { all: true }).then((records) => records.map((record) => record.address));
  const offenders = literal.filter((address) => isPrivateAddress(address));
  if (offenders.length > 0) {
    throw new InstanceUrlError(
      `instance host ${hostname} resolves to a private address (${offenders.join(", ")}); private network access needs the connection's explicit opt-in`,
    );
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
  /** Connection policy. */
  instanceOrigin: string;
  allowPrivateNetwork: boolean;
  caPem?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: never;
}

export class SafeHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * One bounded request through the security boundary. Redirects are followed
 * manually (max 3): each hop is re-canonicalized, must stay on the
 * connection's origin, and Authorization is stripped before following —
 * credentials never cross a redirect boundary. TLS verification stays on;
 * a custom CA bundle is additive, never a bypass.
 */
export function safeHttpRequest(input: SafeHttpRequest, attempt = 0): Promise<SafeHttpResult> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const maxBytes = input.maxBytes ?? 4 * 1024 * 1024;
  let target: URL;
  try {
    target = new URL(input.url);
  } catch {
    return Promise.reject(new SafeHttpError(`request URL is invalid: ${JSON.stringify(input.url)}`));
  }
  const sameOrigin = `${target.protocol}//${target.host}` === input.instanceOrigin;
  const token = sameOrigin ? input.bearerToken : undefined;
  const headers: Record<string, string> = { accept: "application/json", ...(input.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;

  return assertResolvesWithinPolicy(target.hostname, { allowPrivateNetwork: input.allowPrivateNetwork }).then(
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
            if (attempt >= 3) {
              reject(new SafeHttpError("too many redirects"));
              return;
            }
            let next: URL;
            try {
              next = new URL(location, target);
            } catch {
              reject(new SafeHttpError("redirect location is invalid"));
              return;
            }
            if (`${next.protocol}//${next.host}` !== input.instanceOrigin) {
              reject(new SafeHttpError("redirect leaves the instance origin; refusing to follow"));
              return;
            }
            // A redirect target is server-chosen, so credentials never follow
            // it — even when it stays on the instance origin.
            safeHttpRequest(
              { ...input, url: next.toString(), body: undefined, bearerToken: undefined },
              attempt + 1,
            ).then(resolve, reject);
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
        req.on("error", (error) => reject(new SafeHttpError(error.message)));
        if (input.body != null) req.write(input.body);
        req.end();
      }),
  );
}
