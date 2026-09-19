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

  const existing = store
    .list("gitlab")
    .find((row) => row.label === ENV_CONNECTION_LABEL && row.instance_base_url === canonicalOrigin(bootstrap.baseUrl));
  if (existing) {
    const before = `${existing.token_fingerprint}`;
    store.update(existing.id, { token: bootstrap.token, webhookSecret: bootstrap.webhookSecret });
    const after = store.get(existing.id)?.token_fingerprint ?? before;
    return { created: false, updated: before !== after, id: existing.id };
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
