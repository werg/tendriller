// Zero-dependency Web Push (RFC 8292 VAPID ES256 + RFC 8291 aes128gcm) using standard Web Crypto.
import type { Role } from "../../contract/index.mjs";
import type { Env } from "./env";
import type { Tendril } from "./tendril";
import { HttpError } from "./http";
import { isSafeRelativePageUrl } from "./pwa";

const MAX_SUBSCRIPTIONS = 16;
const MAX_PAYLOAD_BYTES = 2048;
const MAX_PUSH_PER_HOUR = 20;
const MAX_PUSH_PER_DAY = 100;
const SUBS_META_KEY = "push_subscriptions";
const RATE_META_KEY = "push_rate_log";

export interface PushSubscriptionRecord {
  id: string;
  accountId: string;
  role: Role;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface PushPayloadInput {
  title: string;
  body?: string;
  tag?: string;
  path?: string;
  badge?: number;
}

const enc = new TextEncoder();

export function b64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) throw new Error("Invalid base64url encoding");
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function concat(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hmacSha256(keyBytes: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

export function vapidConfig(env: Env): VapidConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || (env.PUBLIC_BASE ? env.PUBLIC_BASE.trim() : "mailto:admin@tendriller.dev");
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

async function importVapidPrivateKey(privateKeyInput: string, publicKeyB64Url: string): Promise<CryptoKey> {
  if (privateKeyInput.startsWith("{")) {
    const jwk = JSON.parse(privateKeyInput) as JsonWebKey;
    return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  // Raw 32-byte base64url private scalar paired with 65-byte uncompressed public key.
  const pub = b64UrlDecode(publicKeyB64Url);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 key");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64UrlEncode(pub.subarray(1, 33)),
    y: b64UrlEncode(pub.subarray(33, 65)),
    d: privateKeyInput,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function signVapidJwt(
  audience: string,
  subject: string,
  publicKeyB64Url: string,
  privateKeyInput: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = b64UrlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64UrlEncode(enc.encode(JSON.stringify({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })));
  const input = `${header}.${claims}`;
  const key = await importVapidPrivateKey(privateKeyInput, publicKeyB64Url);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input)));
  return `${input}.${b64UrlEncode(sig)}`;
}

/** RFC 8291 (aes128gcm) content encryption for Web Push payloads. */
export async function encryptWebPushPayload(
  plaintext: Uint8Array,
  p256dhB64Url: string,
  authB64Url: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublicBytes = b64UrlDecode(p256dhB64Url);
  if (uaPublicBytes.length !== 65 || uaPublicBytes[0] !== 0x04) {
    throw new Error("Invalid p256dh public key");
  }
  const authSecret = b64UrlDecode(authB64Url);
  if (authSecret.length !== 16) {
    throw new Error("Invalid auth secret");
  }

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey) as ArrayBuffer);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, ephemeral.privateKey, 256));

  const salt = new Uint8Array(new ArrayBuffer(16));
  crypto.getRandomValues(salt);

  // IKM = HKDF(salt = authSecret, ikm = ecdhSecret, info = "WebPush: info\0" || ua_pub || as_pub, L = 32)
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublicBytes, asPublicBytes, new Uint8Array([0x01]));
  const ikm = await hmacSha256(prkKey, keyInfo);

  // CEK (16 bytes) and NONCE (12 bytes)
  const prk = await hmacSha256(salt, ikm);
  const cekFull = await hmacSha256(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([0x01])));
  const nonceFull = await hmacSha256(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([0x01])));
  const cek = cekFull.slice(0, 16);
  const nonce = nonceFull.slice(0, 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  // RFC 8188 header: salt(16) || rs(4, 4096 BE) || idlen(1, 65) || keyid(65)
  const header = new Uint8Array(new ArrayBuffer(16 + 4 + 1 + 65));
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = asPublicBytes.length;
  header.set(asPublicBytes, 21);
  return concat(header, ciphertext);
}

function isDisallowedPushHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^(fc|fd|fe80)/i.test(h)) return true;
  return false;
}

export function validatePushSubscriptionInput(raw: unknown): { endpoint: string; p256dh: string; auth: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "bad_request", "Subscription object required");
  }
  const rec = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof rec.endpoint !== "string" || rec.endpoint.length > 2048) {
    throw new HttpError(400, "bad_request", "Valid HTTPS push endpoint required");
  }
  let parsed: URL;
  try { parsed = new URL(rec.endpoint); }
  catch { throw new HttpError(400, "bad_request", "Invalid push endpoint URL"); }
  if (parsed.protocol !== "https:" || !parsed.hostname || isDisallowedPushHost(parsed.hostname)) {
    throw new HttpError(400, "bad_request", "Push endpoint must be a public HTTPS URL");
  }
  const p256dh = typeof rec.keys?.p256dh === "string" ? rec.keys.p256dh.trim() : "";
  const auth = typeof rec.keys?.auth === "string" ? rec.keys.auth.trim() : "";
  try {
    const pub = b64UrlDecode(p256dh);
    const secret = b64UrlDecode(auth);
    if (pub.length !== 65 || pub[0] !== 0x04 || secret.length !== 16) {
      throw new Error("bad lengths");
    }
  } catch {
    throw new HttpError(400, "bad_request", "Subscription keys.p256dh (65-byte P-256) and keys.auth (16-byte) are required");
  }
  return { endpoint: parsed.href, p256dh, auth };
}

export function listPushSubscriptions(t: Tendril): PushSubscriptionRecord[] {
  const list = t.db.get<PushSubscriptionRecord[]>(SUBS_META_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function savePushSubscription(
  t: Tendril,
  accountId: string,
  role: Role,
  sub: { endpoint: string; p256dh: string; auth: string },
): PushSubscriptionRecord {
  const existing = listPushSubscriptions(t).filter(s => s.endpoint !== sub.endpoint);
  const record: PushSubscriptionRecord = {
    id: crypto.randomUUID(),
    accountId,
    role,
    endpoint: sub.endpoint,
    p256dh: sub.p256dh,
    auth: sub.auth,
    createdAt: t.now(),
  };
  existing.push(record);
  const bounded = existing.length > MAX_SUBSCRIPTIONS ? existing.slice(existing.length - MAX_SUBSCRIPTIONS) : existing;
  t.db.set(SUBS_META_KEY, bounded);
  return record;
}

export function deletePushSubscription(t: Tendril, accountId: string, endpoint: string): boolean {
  const existing = listPushSubscriptions(t);
  const next = existing.filter(s => !(s.endpoint === endpoint && s.accountId === accountId));
  if (next.length === existing.length) return false;
  t.db.set(SUBS_META_KEY, next);
  return true;
}

export function validatePushPayload(raw: unknown): PushPayloadInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "bad_request", "Notification payload object required");
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.title !== "string" || !rec.title.trim() || rec.title.trim().length > 120) {
    throw new HttpError(400, "bad_request", "title is required (1–120 characters)");
  }
  const title = rec.title.trim();
  const body = typeof rec.body === "string" ? rec.body.trim().slice(0, 500) : "";
  let tag: string | undefined;
  if (rec.tag !== undefined && rec.tag !== null) {
    if (typeof rec.tag !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(rec.tag)) {
      throw new HttpError(400, "bad_request", "tag must be 1–64 alphanumeric/._- characters");
    }
    tag = rec.tag;
  }
  let path: string | undefined;
  if (rec.path !== undefined && rec.path !== null) {
    if (typeof rec.path !== "string" || !isSafeRelativePageUrl(rec.path.trim())) {
      throw new HttpError(400, "bad_request", "path must be a relative path, query, or fragment within this page");
    }
    path = rec.path.trim();
  }
  let badge: number | undefined;
  if (rec.badge !== undefined && rec.badge !== null) {
    const n = Number(rec.badge);
    if (!Number.isInteger(n) || n < 0 || n > 999) {
      throw new HttpError(400, "bad_request", "badge must be an integer between 0 and 999");
    }
    badge = n;
  }
  return { title, ...(body ? { body } : {}), ...(tag ? { tag } : {}), ...(path ? { path } : {}), ...(badge !== undefined ? { badge } : {}) };
}

export async function sendPushNotification(
  t: Tendril,
  rawPayload: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<{ sent: number; failed: number; pruned: number; total: number }> {
  const cfg = vapidConfig(t.env);
  if (!cfg) {
    throw new HttpError(503, "push_not_configured", "Web Push VAPID keys are not configured on this host");
  }
  const payload = validatePushPayload(rawPayload);
  const subs = listPushSubscriptions(t);
  if (subs.length === 0) return { sent: 0, failed: 0, pruned: 0, total: 0 };

  const now = t.now();
  const dayAgo = now - 24 * 60 * 60_000;
  const hourAgo = now - 60 * 60_000;
  const log = t.db.get<number[]>(RATE_META_KEY, []).filter(ts => typeof ts === "number" && ts > dayAgo);
  if (log.filter(ts => ts > hourAgo).length >= MAX_PUSH_PER_HOUR || log.length >= MAX_PUSH_PER_DAY) {
    throw new HttpError(429, "push_rate_limited", "Notification rate limit reached for this page");
  }

  const pageUrl = t.mainPageUrl();
  const targetUrl = payload.path ? new URL(payload.path, pageUrl).href : pageUrl;
  const wireObj = {
    title: payload.title,
    body: payload.body ?? "",
    ...(payload.tag ? { tag: payload.tag } : {}),
    url: targetUrl,
    ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
  };
  const wireBytes = enc.encode(JSON.stringify(wireObj));
  if (wireBytes.length > MAX_PAYLOAD_BYTES) {
    throw new HttpError(400, "payload_too_large", "Notification payload exceeds 2048 bytes");
  }

  log.push(now);
  t.db.set(RATE_META_KEY, log);

  let sent = 0;
  let failed = 0;
  const deadEndpoints = new Set<string>();

  await Promise.all(subs.map(async sub => {
    try {
      const origin = new URL(sub.endpoint).origin;
      const jwt = await signVapidJwt(origin, cfg.subject, cfg.publicKey, cfg.privateKey, Math.floor(now / 1000));
      const encrypted = await encryptWebPushPayload(wireBytes, sub.p256dh, sub.auth);
      const headers: Record<string, string> = {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "86400",
        "Authorization": `vapid t=${jwt}, k=${cfg.publicKey}`,
      };
      if (payload.tag) headers["Topic"] = payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
      const res = await fetchFn(sub.endpoint, { method: "POST", headers, body: encrypted });
      await res.body?.cancel();
      if (res.status === 404 || res.status === 410) {
        deadEndpoints.add(sub.endpoint);
        failed++;
      } else if (res.ok || res.status === 201 || res.status === 202) {
        sent++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }));

  if (deadEndpoints.size > 0) {
    const remaining = listPushSubscriptions(t).filter(s => !deadEndpoints.has(s.endpoint));
    t.db.set(SUBS_META_KEY, remaining);
  }

  return { sent, failed, pruned: deadEndpoints.size, total: subs.length };
}
