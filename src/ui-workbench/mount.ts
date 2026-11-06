/**
 * Mounting the workbench into a Hono app.
 *
 * The gate runs before every workbench route: when it denies, the answer is a
 * hard 404 — never a redirect and never a partial page.
 */
import type { Context, Env, Hono, MiddlewareHandler, Next } from "hono";
import { createWorkbenchApp, type WorkbenchAppOptions } from "./app.js";
import { isProduction, looksProxied, workbenchAvailable, workbenchFlagEnabled } from "./gate.js";

/** The path prefix the workbench is mounted at in every host. */
export const WORKBENCH_PREFIX = "/dev/ui";

export interface WorkbenchGateOptions {
  /** The explicit opt-in flag. Defaults to MAOMAO_UI_WORKBENCH_ENABLED=1. */
  enabled?: boolean;
  /** True when the process runs with NODE_ENV=production. */
  production?: boolean;
  /** Allowed client addresses; loopback by default. */
  allowedIps?: readonly string[];
  /**
   * Resolves the real TCP peer address. Overridable so tests can pretend to
   * be a browser on the loopback interface.
   */
  peerAddress?: (c: Context) => string | undefined;
  /** Prints a startup warning when the workbench is enabled. */
  announce?: boolean;
}

/**
 * The real peer address of the connection.
 *
 * `X-Forwarded-For` is deliberately ignored: a spoofed header must never pose
 * as loopback, so the socket address is the only source of truth.
 */
export function defaultPeerAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

export function createWorkbenchGate(options: WorkbenchGateOptions = {}): MiddlewareHandler<any, string, any> {
  const peerAddress = options.peerAddress ?? defaultPeerAddress;
  return async (c: Context<any, string, any>, next: Next) => {
    // A request that carries forwarding headers came through a proxy, so the
    // socket peer is the proxy's address and the loopback rule proves nothing
    // about who is asking. Refuse it instead of trusting the header.
    if (looksProxied((name) => c.req.header(name))) return c.notFound();

    const available = workbenchAvailable({
      enabled: options.enabled ?? workbenchFlagEnabled(),
      production: options.production ?? isProduction(),
      remoteAddr: peerAddress(c),
      allowedIps: options.allowedIps,
    });
    if (!available) return c.notFound();
    await next();
  };
}

/**
 * Registers the workbench routes and their gate on a Hono app.
 *
 * The routes are mounted before the caller's own middleware, so the workbench
 * never depends on the operator login: it is protected by the dev-only flag
 * and the loopback rule instead.
 */
export function mountWorkbench<E extends Env>(
  app: Hono<E>,
  options: WorkbenchGateOptions & WorkbenchAppOptions = {},
): Hono<E> {
  const gate = createWorkbenchGate(options);
  app.use(WORKBENCH_PREFIX, gate);
  app.use(`${WORKBENCH_PREFIX}/*`, gate);
  app.route(WORKBENCH_PREFIX, createWorkbenchApp(options));

  if (options.announce && (options.enabled ?? workbenchFlagEnabled())) {
    console.warn(
      "[ui-workbench] enabled — it answers direct loopback requests only. A reverse proxy in front of this host is refused, because the peer would be the proxy's address and not the client's.",
    );
  }

  return app;
}
