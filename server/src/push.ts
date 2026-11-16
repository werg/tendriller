// Web Push from a Cloudflare Worker using only WebCrypto. Owned by the push agent.
// See docs/PROTOCOL.md section 10.
//   - VAPID (RFC 8292): ES256 JWT, `Authorization: vapid t=<jwt>, k=<public key>`.
//   - Message encryption (RFC 8291) with the aes128gcm content coding (RFC 8188),
//     one record.
// Key formats (Worker secrets):
//   VAPID_PUBLIC_KEY  base64url, uncompressed P-256 point (65 bytes, 0x04 || x || y)
//   VAPID_PRIVATE_KEY base64url, raw 32-byte private scalar
// Generate both with `node scripts/vapid-keys.mjs`.
import type { Env } from "./env";

export interface PushSubscriptionJSON { endpoint?: string; expirationTime?: number | null; keys?: Record<string, string> }
export type Urgency = "very-low" | "low" | "normal" | "high";
export interface NotifyDeliveryOptions { devices?: string[]; broadcastLocal?: boolean; signal?: AbortSignal }
export interface NotifyDeliveryResult { sent: number; failed: number; deliveries: { device: string; ok: boolean; status: number; gone: boolean }[] }

export function pushAvailable(env: Env): boolean { return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY); }
export function vapidPublicKey(env: Env): string | null { return env.VAPID_PUBLIC_KEY ?? null; }

/**
 * Browser subscriptions are untrusted socket input. A push endpoint must be a
 * public HTTPS host, never an IP address, local hostname or alternate port.
 * This keeps a page from turning the Worker into a private-network fetcher.
 * Accept different public push-service hosts (not only the major browsers).
 */
export function validatePushSubscription(value: unknown, now = Date.now()): PushSubscriptionJSON | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sub = value as PushSubscriptionJSON;
  if (typeof sub.endpoint !== "string" || sub.endpoint.length > 2048) return null;
  let url: URL;
  try { url = new URL(sub.endpoint); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port
    || host.length > 253 || !host.includes(".") || host.includes(":") || /^[0-9.]+$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return null;
  if (!sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(sub.keys.p256dh) || !/^[A-Za-z0-9_-]+$/.test(sub.keys.auth)) return null;
  try {
    const publicKey = b64urlDecode(sub.keys.p256dh), auth = b64urlDecode(sub.keys.auth);
    if (publicKey.length !== 65 || publicKey[0] !== 4 || auth.length !== 16) return null;
  } catch { return null; }
  if (sub.expirationTime != null && (!Number.isFinite(sub.expirationTime) || sub.expirationTime <= now)) return null;
  return {
    endpoint: url.href,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  };
}

const RECORD_SIZE = 4096;
// header (16 salt + 4 rs + 1 idlen + 65 keyid) + 1 delimiter + 16 tag must fit the 4096-byte limit push services accept.
const MAX_PLAINTEXT = RECORD_SIZE - 86 - 1 - 16;

export async function sendWebPush(
  env: Env,
  subscription: PushSubscriptionJSON,
  payload: unknown,
  opts: { ttl?: number; urgency?: Urgency; topic?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; status: number; gone: boolean }> {
  if (!pushAvailable(env)) return { ok: false, status: 501, gone: false };
  const valid = validatePushSubscription(subscription);
  if (!valid) return { ok: false, status: 400, gone: true };
  const url = new URL(valid.endpoint!);
  const p256dh = valid.keys!.p256dh, auth = valid.keys!.auth;

  const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  const plaintext = new TextEncoder().encode(text);
  if (plaintext.length > MAX_PLAINTEXT) return { ok: false, status: 413, gone: false };

  let body: Uint8Array<ArrayBuffer>;
  try { body = await encryptPayload(plaintext, b64urlDecode(p256dh), b64urlDecode(auth)); }
  catch { return { ok: false, status: 400, gone: true }; } // malformed subscription keys

  const headers: Record<string, string> = {
    "TTL": String(Math.max(0, Math.floor(opts.ttl ?? 24 * 3600))),
    "Urgency": opts.urgency ?? "normal",
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "Authorization": await vapidAuthorization(env, url.origin),
  };
  const topic = sanitizeTopic(opts.topic);
  if (topic) headers["Topic"] = topic;

  let res: Response;
  // A subscription endpoint is supplied by a page device. Never forward the
  // encrypted payload or VAPID authorization to a redirect target.
  try { res = await fetch(url.toString(), { method: "POST", headers, body, redirect: "manual",
    signal: opts.signal ?? AbortSignal.timeout(30_000) }); }
  catch { return { ok: false, status: 0, gone: false }; }
  // Drain the body so the connection can be reused.
  try { await res.arrayBuffer(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

// Topic: at most 32 characters from the base64url alphabet (RFC 8030 section 5.4).
function sanitizeTopic(t?: string): string | null {
  if (!t) return null;
  const s = t.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  return s || null;
}

// ---------- VAPID (RFC 8292) ----------

const jwtCache = new Map<string, { header: string; exp: number }>();

/** Returns the `Authorization` header value for the push service at `audience` (an origin). */
export async function vapidAuthorization(env: Env, audience: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const pub = env.VAPID_PUBLIC_KEY!, priv = env.VAPID_PRIVATE_KEY!;
  const cacheKey = audience + "|" + pub;
  const hit = jwtCache.get(cacheKey);
  if (hit && hit.exp - nowSec > 3600) return hit.header;
  const exp = nowSec + 12 * 3600; // RFC 8292: no more than 24 h
  const jwt = await createVapidJwt(priv, pub, { aud: audience, exp, sub: env.VAPID_SUBJECT || env.PUBLIC_BASE });
  const header = `vapid t=${jwt}, k=${pub}`;
  jwtCache.set(cacheKey, { header, exp });
  return header;
}

export async function createVapidJwt(privateKeyB64: string, publicKeyB64: string, claims: { aud: string; exp: number; sub: string }): Promise<string> {
  const pub = b64urlDecode(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 point");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: privateKeyB64.replace(/=+$/, ""), x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const enc = new TextEncoder();
  const unsigned = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }))) + "." + b64urlEncode(enc.encode(JSON.stringify(claims)));
  // WebCrypto ECDSA returns r || s (64 bytes), which is exactly the JWS ES256 format.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)));
  return unsigned + "." + b64urlEncode(sig);
}

// ---------- Message encryption (RFC 8291 + RFC 8188) ----------

/**
 * Encrypts `plaintext` for a subscription. `fixed` exists only for the RFC 8291
 * test vector (fixed salt and application-server key pair).
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  fixed?: { salt: Uint8Array; asPrivate: Uint8Array; asPublic: Uint8Array },
): Promise<Uint8Array<ArrayBuffer>> {
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("bad p256dh");
  if (authSecret.length < 16) throw new Error("bad auth");
  const subtle = crypto.subtle;

  let asPrivateKey: CryptoKey, asPublic: Uint8Array;
  if (fixed) {
    asPublic = fixed.asPublic;
    asPrivateKey = await subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", d: b64urlEncode(fixed.asPrivate), x: b64urlEncode(asPublic.slice(1, 33)), y: b64urlEncode(asPublic.slice(33, 65)), ext: true },
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"],
    );
  } else {
    const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivateKey = pair.privateKey;
    asPublic = new Uint8Array((await subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));

  const uaKey = await subtle.importKey("raw", copy(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: uaKey } as any, asPrivateKey, 256));

  const enc = new TextEncoder();
  // PRK_key = HMAC(auth_secret, ecdh_secret); IKM = HMAC(PRK_key, key_info || 0x01)
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1]));
  const ikm = await hmac(prkKey, keyInfo);
  // RFC 8188: PRK = HMAC(salt, IKM); CEK / NONCE from HKDF-Expand with one block.
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const aesKey = await subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2])); // last-record delimiter, no padding
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", copy(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, copy(data)));
}

// ---------- bytes ----------

function copy(a: Uint8Array): Uint8Array<ArrayBuffer> { const out = new Uint8Array(a.length); out.set(a); return out; }

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(b + "===".slice((b.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
