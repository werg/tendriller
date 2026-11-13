// Identifiers, secrets and hashing (PROTOCOL section 1).

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `n` random characters from the base32 alphabet `[a-z2-7]`. */
export function randomB32(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += B32[b & 31];
  return out;
}

export const newTendrilId = () => randomB32(12);
export const newPageKey = () => randomB32(26);
export const newToken = () => "tk_" + randomB32(32);
export const newBlobId = () => "b_" + randomB32(20);
export const newLinkId = () => "l_" + randomB32(10);
export const newCallId = () => "c_" + randomB32(12);

/** Six decimal digits, uniformly distributed. */
export function sixDigits(): string {
  const buf = new Uint32Array(1);
  // Rejection sampling to avoid modulo bias.
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_294_000_000) return String(buf[0] % 1_000_000).padStart(6, "0");
  }
}

export const TENDRIL_ID_RE = /^[a-z2-7]{12}$/;
export const PAGE_KEY_RE = /^[a-z2-7]{26}$/;
export const DEVICE_ID_RE = /^d_[a-z2-7]{16}$/;
export const DEVICE_SECRET_RE = /^[a-z2-7]{32}$/;
export const BLOB_ID_RE = /^b_[a-z2-7]{20}$/;

export async function sha256Hex(data: string | ArrayBuffer | ArrayBufferView): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Constant-time comparison of two strings of equal length (e.g. hex hashes). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
