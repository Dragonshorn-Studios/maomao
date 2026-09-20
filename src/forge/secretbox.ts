/**
 * AES-256-GCM encryption for forge credentials at rest. The key comes from
 * MAOMAO_FORGE_KEY (64 hex chars, or a file path via MAOMAO_FORGE_KEY_FILE).
 * Plaintext secrets never touch the database, logs, or model context; only
 * this module and its callers' redaction lists see them.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";

const KEY_LENGTH = 32;

export function loadForgeKey(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const keyFile = env.MAOMAO_FORGE_KEY_FILE?.trim();
  if (keyFile) {
    return parseForgeKey(readFileSync(keyFile, "utf8").trim());
  }
  const raw = env.MAOMAO_FORGE_KEY?.trim();
  if (!raw) return undefined;
  return parseForgeKey(raw);
}

function parseForgeKey(raw: string): Buffer {
  // Production form is 64 hex chars (`openssl rand -hex 32`). Anything else is
  // treated as a passphrase and stretched with a *fixed* scrypt salt so a
  // typo'd env still boots — but that derived key cannot be rotated without
  // resealing every stored token. Prefer hex.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return scryptSync(raw, "maomao-forge-key", KEY_LENGTH);
}

export function generateForgeKeyHex(): string {
  return randomBytes(KEY_LENGTH).toString("hex");
}

export function sealSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function openSecret(key: Buffer, sealed: string): string {
  const [version, ivPart, tagPart, dataPart] = sealed.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !dataPart) {
    throw new Error("sealed secret is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new Error(
      "forge credential could not be unsealed — MAOMAO_FORGE_KEY does not match the key that sealed this connection",
      { cause: error },
    );
  }
}

/** Non-reversible display hint for the UI: the last 4 characters of the secret. */
export function secretFingerprint(secret: string): string {
  return secret.length >= 4 ? secret.slice(-4) : "";
}
