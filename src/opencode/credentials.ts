/**
 * Provider API-key management via OpenCode's own credential store
 * (`auth.json`). OpenCode reads `$XDG_DATA_HOME/opencode/auth.json`
 * (default `~/.local/share/opencode/auth.json`) on startup; Maomao's child
 * env passes `HOME`/`XDG_*` through unchanged, so writing the file the child
 * will read needs no env plumbing and the key never transits `.env`.
 *
 * Security model: key material is write-only. The file is atomic
 * read-modify-write (temp + rename, mode 0600) so OAuth entries written by
 * `opencode auth login` survive key updates untouched. The UI shows source
 * and a last-4 fingerprint, never the key.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

/** models.dev provider ids that take a plain API key, with the env vars that also satisfy them. */
export const PROVIDER_CREDENTIAL_OPTIONS: ReadonlyArray<{
  id: string;
  label: string;
  envVars: readonly string[];
  /** Where the operator obtains an API key for this provider. */
  helpUrl: string;
  /** Short instruction shown next to the help link; defaults to "Get a key". */
  helpLabel?: string;
}> = [
  {
    id: "anthropic",
    label: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY"],
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    helpUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    envVars: ["OPENROUTER_API_KEY"],
    helpUrl: "https://openrouter.ai/keys",
  },
  {
    id: "google",
    label: "Google (Gemini)",
    envVars: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    helpUrl: "https://aistudio.google.com/app/apikey",
  },
  { id: "xai", label: "xAI (Grok)", envVars: ["XAI_API_KEY"], helpUrl: "https://console.x.ai/" },
  {
    id: "mistral",
    label: "Mistral",
    envVars: ["MISTRAL_API_KEY"],
    helpUrl: "https://console.mistral.ai/api-keys",
  },
  { id: "groq", label: "Groq", envVars: ["GROQ_API_KEY"], helpUrl: "https://console.groq.com/keys" },
  {
    id: "deepseek",
    label: "DeepSeek",
    envVars: ["DEEPSEEK_API_KEY"],
    helpUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "togetherai",
    label: "Together AI",
    envVars: ["TOGETHER_API_KEY"],
    helpUrl: "https://api.together.xyz/settings/api-keys",
  },
  {
    id: "cohere",
    label: "Cohere",
    envVars: ["COHERE_API_KEY"],
    helpUrl: "https://dashboard.cohere.com/api-keys",
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    envVars: ["AZURE_API_KEY"],
    helpUrl: "https://portal.azure.com/",
    helpLabel: "Azure portal → your OpenAI resource → Keys and Endpoint",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    envVars: ["OLLAMA_API_KEY"],
    helpUrl: "https://ollama.com/settings/keys",
  },
  {
    id: "zai",
    label: "Z.AI",
    envVars: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
    helpUrl: "https://z.ai/manage-apikey/apikey-list",
  },
  {
    id: "zai-coding-plan",
    label: "Z.AI Coding Plan",
    envVars: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
    helpUrl: "https://z.ai/manage-apikey/coding-plan",
  },
];

export type ProviderCredentialSource = "environment" | "stored" | "none";

export interface ProviderCredentialStatus {
  id: string;
  label: string;
  source: ProviderCredentialSource;
  /** The env var supplying the key when source === "environment". */
  envVar?: string;
  /** Last-4 fingerprint of the stored key when source === "stored". */
  fingerprint?: string;
  /** Where the operator obtains an API key; absent for unknown/custom providers. */
  helpUrl?: string;
  /** Short instruction shown next to the help link; page defaults to "Get a key". */
  helpLabel?: string;
}

interface AuthEntry {
  type: string;
  key?: string;
  [key: string]: unknown;
}

type AuthFile = Record<string, AuthEntry>;

/** The path the spawned OpenCode child resolves for its credential file. */
export function opencodeAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim();
  const home = env.HOME?.trim() || homedir();
  return dataHome ? join(dataHome, "opencode", "auth.json") : join(home, ".local", "share", "opencode", "auth.json");
}

function fingerprint(key: string): string {
  return key.length >= 4 ? key.slice(-4) : "";
}

function readAuthFile(path: string): AuthFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as AuthFile;
  } catch {
    // A malformed file is treated as empty for listing, but writes refuse
    // rather than silently discarding whatever the operator had stored.
    return {};
  }
}

function authFileIsParseable(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return true; // absent file — a write creates it
  }
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** Validates what OpenCode will accept: a non-empty key without whitespace/control chars. */
function validateKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return "API key is empty.";
  if (/[\x00-\x1f\x7f\s]/.test(trimmed)) return "API key must not contain whitespace or control characters.";
  return null;
}

export class ProviderCredentialStore {
  constructor(
    private readonly path: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Per-provider credential status. Stored entries for providers not in the
   * option list still appear (id is reused as the label) so a custom provider
   * key is never invisible. */
  list(): ProviderCredentialStatus[] {
    const auth = readAuthFile(this.path);
    const seen = new Map<string, string>();
    for (const [id, entry] of Object.entries(auth)) {
      if (entry && typeof entry === "object" && entry.type === "api" && typeof entry.key === "string" && entry.key) {
        seen.set(id, entry.key);
      }
    }
    const statuses: ProviderCredentialStatus[] = PROVIDER_CREDENTIAL_OPTIONS.map((option) => {
      const envVar = option.envVars.find((name) => Boolean(this.env[name]?.trim()));
      const storedKey = seen.get(option.id);
      seen.delete(option.id);
      const base = { id: option.id, label: option.label, helpUrl: option.helpUrl, helpLabel: option.helpLabel };
      if (envVar) return { ...base, source: "environment" as const, envVar };
      if (storedKey) return { ...base, source: "stored" as const, fingerprint: fingerprint(storedKey) };
      return { ...base, source: "none" as const };
    });
    for (const [id, key] of seen) {
      statuses.push({ id, label: id, source: "stored", fingerprint: fingerprint(key) });
    }
    return statuses;
  }

  /** Inserts or replaces an api-key entry; OAuth entries are preserved verbatim. */
  set(providerId: string, key: string): { ok: true } | { ok: false; error: string } {
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(providerId)) {
      return { ok: false, error: "Provider id must be a models.dev-style id (letters, digits, dashes, dots)." };
    }
    const keyError = validateKey(key);
    if (keyError) return { ok: false, error: keyError };
    if (!authFileIsParseable(this.path)) {
      return { ok: false, error: `${this.path} is not valid JSON — refusing to overwrite it. Fix or remove it first.` };
    }
    const auth = readAuthFile(this.path);
    auth[providerId] = { type: "api", key: key.trim() };
    this.write(auth);
    return { ok: true };
  }

  delete(providerId: string): { ok: true; removed: boolean } | { ok: false; error: string } {
    if (!authFileIsParseable(this.path)) {
      return { ok: false, error: `${this.path} is not valid JSON — refusing to rewrite it. Fix or remove it first.` };
    }
    const auth = readAuthFile(this.path);
    const removed = providerId in auth;
    if (removed) {
      delete auth[providerId];
      this.write(auth);
    }
    return { ok: true, removed };
  }

  /** Raw key material for redaction lists — never logged or rendered. */
  storedSecrets(): string[] {
    return Object.values(readAuthFile(this.path))
      .map((entry) => (entry && typeof entry === "object" ? entry.key : undefined))
      .filter((key): key is string => typeof key === "string" && key.length >= 8);
  }

  private write(auth: AuthFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${createHash("sha1").update(String(Date.now())).digest("hex").slice(0, 8)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    // renameSync preserves the temp file's mode; chmod only when the file
    // pre-existed with looser perms (rename replaced it, so this is a no-op
    // safety net for older umasks).
    chmodSync(this.path, 0o600);
  }
}

/**
 * Stored key material for redaction lists. Pass the *child's* env so the
 * resolved auth.json path matches what the spawned process reads (HOME and
 * XDG_DATA_HOME pass through sanitizeChildEnv unchanged).
 */
export function providerAuthSecrets(childEnv: NodeJS.ProcessEnv): string[] {
  return new ProviderCredentialStore(opencodeAuthPath(childEnv), childEnv).storedSecrets();
}
