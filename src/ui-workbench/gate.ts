/**
 * The workbench gate. The workbench fails closed: it answers only when it is
 * explicitly enabled, only outside production, and only for allowlisted
 * client addresses (loopback by default).
 */

/** Client addresses allowed to reach the workbench unless overridden. */
export const DEFAULT_ALLOWED_IPS: readonly string[] = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/** The environment flag that turns the workbench on. Off unless set to "1". */
export const WORKBENCH_FLAG = "MAOMAO_UI_WORKBENCH_ENABLED";

export interface WorkbenchGateInput {
  /** The explicit opt-in flag. */
  enabled: boolean;
  /** True when the process runs with NODE_ENV=production. */
  production: boolean;
  /**
   * The real TCP peer address. `X-Forwarded-For` is deliberately ignored: a
   * spoofed header must never pose as loopback.
   */
  remoteAddr: string | undefined;
  /** Allowed client addresses; loopback by default. */
  allowedIps?: readonly string[];
}

/** Normalizes `::ffff:127.0.0.1` to `127.0.0.1` so both forms match. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
}

export function isLoopback(address: string): boolean {
  const normalized = normalizeAddress(address);
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * True when the workbench may answer this request. Every condition must
 * hold; a missing address is a denial.
 */
export function workbenchAvailable(input: WorkbenchGateInput): boolean {
  if (!input.enabled) return false;
  if (input.production) return false;

  const client = input.remoteAddr;
  if (typeof client !== "string" || client.trim() === "") return false;

  const allowed = input.allowedIps ?? DEFAULT_ALLOWED_IPS;
  const normalizedClient = normalizeAddress(client);

  return allowed.some((candidate) => {
    const normalized = normalizeAddress(candidate);
    // A configured loopback address also accepts the whole 127.0.0.0/8 range.
    if (isLoopback(normalized) && isLoopback(normalizedClient)) return true;
    return normalized === normalizedClient;
  });
}

/** The flag value of the current environment. Off unless it is exactly "1". */
export function workbenchFlagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WORKBENCH_FLAG] === "1";
}

/** True when the process runs in production mode. */
export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

/**
 * Headers that only a reverse proxy sets.
 *
 * Their presence means the socket peer is the proxy's address, not the
 * client's, so the loopback rule proves nothing about who is asking.
 */
export const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];

/**
 * True when a request carries a forwarding header.
 *
 * The workbench refuses these rather than trusting them: a proxy in front of
 * the host would otherwise present a loopback peer and turn "loopback only"
 * into "the proxy only" — serving the previews, and their CSRF-exempt fake
 * endpoint, to every remote visitor.
 */
export function looksProxied(header: (name: string) => string | undefined): boolean {
  return PROXY_HEADERS.some((name) => header(name) !== undefined);
}
