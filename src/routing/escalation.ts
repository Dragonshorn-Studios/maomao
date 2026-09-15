import { createHash, createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ExternalTarget } from "./types.js";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

export class UnsafeWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeWebhookUrlError";
  }
}

export function validateMentionRecipient(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "@repository-owner" || trimmed === "repository-owner") return "@repository-owner";
  const value = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  if (!/^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\/[A-Za-z0-9._-]+)?$/.test(value)) {
    throw new Error(`invalid mention recipient: ${trimmed}`);
  }
  if (/[\r\n]/.test(value)) throw new Error("mention recipient cannot contain newlines");
  return value;
}

export function validateCommandText(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_\- ]{0,39}$/.test(trimmed)) {
    throw new Error(`invalid escalation command: ${raw}`);
  }
  return trimmed;
}

export function parseExternalTargetsJson(raw: string | undefined): ExternalTarget[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("POISON_ALERT_EXTERNAL_TARGETS_JSON is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("POISON_ALERT_EXTERNAL_TARGETS_JSON must be an array");
  return parsed.map((item, index) => parseTarget(item, index));
}

function parseTarget(item: unknown, index: number): ExternalTarget {
  if (!item || typeof item !== "object") throw new Error(`target ${index} is not an object`);
  const record = item as Record<string, unknown>;
  const type = record.type;
  if (type === "mention") {
    const recipient = validateMentionRecipient(String(record.recipient ?? ""));
    return { type: "mention", recipient };
  }
  if (type === "command") {
    const recipient = validateMentionRecipient(String(record.recipient ?? ""));
    const command = validateCommandText(String(record.command ?? "escalate"));
    return { type: "command", recipient, command };
  }
  if (type === "webhook") {
    const urlSecretRef = String(record.url_secret_ref ?? record.urlSecretRef ?? "").trim();
    const signingSecretRef = String(record.signing_secret_ref ?? record.signingSecretRef ?? "").trim();
    if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(urlSecretRef)) {
      throw new Error(`target ${index} webhook url_secret_ref is invalid`);
    }
    if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(signingSecretRef)) {
      throw new Error(`target ${index} webhook signing_secret_ref is invalid`);
    }
    return { type: "webhook", urlSecretRef, signingSecretRef };
  }
  throw new Error(`target ${index} has unsupported type`);
}

export function resolveMention(recipient: string, repoOwner: string): string {
  const validated = validateMentionRecipient(recipient);
  if (validated === "@repository-owner") return validateMentionRecipient(repoOwner);
  return validated;
}

export function targetKey(target: ExternalTarget): string {
  if (target.type === "mention") return `mention:${target.recipient.toLowerCase()}`;
  if (target.type === "command") return `command:${target.recipient.toLowerCase()}:${target.command.toLowerCase()}`;
  return `webhook:${target.urlSecretRef}:${target.signingSecretRef}`;
}

export function escalationId(input: {
  provider: string;
  instance: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  policy: string;
}): string {
  const basis = [
    input.provider,
    input.instance,
    input.repoFullName.toLowerCase(),
    String(input.prNumber),
    input.headSha.toLowerCase(),
    input.policy,
  ].join("|");
  return `esc_${createHash("sha256").update(basis).digest("hex").slice(0, 20)}`;
}

export const ESCALATION_MARKER_PREFIX = "<!-- maomao-escalation";

export function sanitizePublicReason(raw: string, max = 180): string {
  return raw
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@[A-Za-z0-9][A-Za-z0-9\-\/]*/g, " ")
    .replace(/<!--|-->/g, " ")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function escalationMarker(fields: {
  id: string;
  provider: string;
  instance: string;
  repo: string;
  pr: number;
  sha: string;
  job: number;
  targetKey: string;
  status: string;
}): string {
  const target = fields.targetKey.replace(/\s+/g, "").slice(0, 120);
  return `${ESCALATION_MARKER_PREFIX} id=${fields.id} provider=${fields.provider} instance=${fields.instance} repo=${fields.repo} pr=${fields.pr} sha=${fields.sha} job=${fields.job} target=${target} status=${fields.status} -->`;
}

export function parseEscalationMarker(body: string): { id: string; sha: string; target: string; status: string } | undefined {
  const match = body.match(
    /<!-- maomao-escalation id=(\S+) provider=\S+ instance=\S+ repo=\S+ pr=\d+ sha=(\S+) job=\d+ target=(\S+) status=(\S+)/,
  );
  if (!match) return undefined;
  return { id: match[1] ?? "", sha: match[2] ?? "", target: match[3] ?? "", status: match[4] ?? "" };
}

export function commentLooksLikeMaomaoEscalation(body: string): boolean {
  return body.includes(ESCALATION_MARKER_PREFIX) || body.includes("<!-- maomao-review");
}

export function isBotActor(input: { login?: string; type?: string }): boolean {
  const login = (input.login ?? "").toLowerCase();
  const type = (input.type ?? "").toLowerCase();
  return type === "bot" || login.endsWith("[bot]") || login.endsWith("bot");
}

export function mentionsEscalateCommand(body: string, mentionName: string, command: string): boolean {
  const mention = mentionName.replace(/^@/, "");
  const pattern = new RegExp(`(^|\\s)@${escapeRegExp(mention)}\\s+${escapeRegExp(command)}\\b`, "i");
  return pattern.test(body);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("::ffff:")) return isPrivateIp(normalized.slice(7));
    return false;
  }
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b != null && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError("webhook URL is not a valid absolute URL");
  }
  if (url.protocol !== "https:") throw new UnsafeWebhookUrlError("webhook URL must use https");
  if (url.username || url.password) throw new UnsafeWebhookUrlError("webhook URL must not contain credentials");
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new UnsafeWebhookUrlError("webhook host is not allowed");
  }
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true, verbatim: true })).map((row) => row.address);
  if (addresses.length === 0) throw new UnsafeWebhookUrlError("webhook host did not resolve");
  for (const address of addresses) {
    if (isPrivateIp(address)) throw new UnsafeWebhookUrlError("webhook host resolves to a private or loopback address");
  }
  return url;
}

export async function deliverSignedWebhook(input: {
  url: string;
  secret: string;
  body: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  const url = await assertSafeWebhookUrl(input.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-maomao-signature": signWebhookBody(input.secret, input.body),
        "user-agent": "maomao-escalation",
      },
      body: input.body,
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, error: `webhook responded ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}
