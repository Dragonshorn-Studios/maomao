/**
 * Boot-time seeding of the MVP env-configured GitLab connection. Idempotent:
 * the connection is keyed by its label ("env") + instance origin, and an
 * existing row is updated in place when the token or webhook secret changed
 * (rotation without a restart). The probe is never run here — boot must not
 * make network calls; use the connection UI to validate.
 */
import type { Config } from "../config.js";
import type { ForgeConnectionStore } from "./connections.js";
import { canonicalizeInstanceUrl } from "./safe-http.js";
import { openSecret } from "./secretbox.js";

export const ENV_CONNECTION_LABEL = "env";

export function ensureEnvGitLabConnection(
  store: ForgeConnectionStore,
  config: Config,
): { created: boolean; updated: boolean; id: string } | undefined {
  if (!config.gitlabBootstrap) return undefined;
  const bootstrap = config.gitlabBootstrap;
  // Validate the URL through the same boundary the connection will use; a
  // misconfigured bootstrap must fail boot loudly, not create a broken row.
  canonicalizeInstanceUrl(bootstrap.baseUrl);

  const origin = canonicalOrigin(bootstrap.baseUrl);
  // Only rows on THIS origin are the env connection's rotation target; a stale
  // env row for a different origin is disabled so it cannot keep routing.
  const existing = store
    .list("gitlab")
    .find((row) => row.label === ENV_CONNECTION_LABEL && row.instance_base_url === origin);
  for (const stale of store.list("gitlab")) {
    if (stale.label === ENV_CONNECTION_LABEL && stale.instance_base_url !== origin && stale.enabled === 1) {
      store.update(stale.id, { enabled: false });
      console.log(`Disabled stale env GitLab connection ${stale.id} (instance ${stale.instance_base_url})`);
    }
  }
  if (existing) {
    // Exact comparison: last-4 fingerprints are display hints and collide.
    const opened = store.open(existing.id);
    const unchanged = opened.token === bootstrap.token && opened.webhookSecret === bootstrap.webhookSecret;
    if (!unchanged) {
      store.update(existing.id, { token: bootstrap.token, webhookSecret: bootstrap.webhookSecret });
    }
    return { created: false, updated: !unchanged, id: existing.id };
  }
  const row = store.create({
    provider: "gitlab",
    label: ENV_CONNECTION_LABEL,
    instanceUrl: bootstrap.baseUrl,
    token: bootstrap.token,
    tokenType: "pat",
    scopeType: "instance",
    scopePath: "",
    webhookSecret: bootstrap.webhookSecret,
    allowPrivateNetwork: false,
    allowInsecureHttp: false,
    allowApprove: false,
  });
  return { created: true, updated: false, id: row.id };
}

function canonicalOrigin(raw: string): string {
  return canonicalizeInstanceUrl(raw).origin;
}
