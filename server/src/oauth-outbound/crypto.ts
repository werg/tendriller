/**
 * Zero-plaintext-at-rest cryptography for Issue #136 outbound OAuth connections:
 * - Tier A (agent-held): ephemeral X25519 + HKDF-SHA256 + AES-256-GCM sealing to the agent's wrapKey.
 * - Tier B (host-brokered): AES-256-GCM wrapping under a client-held 256-bit connection secret `K_conn`
 *   (personal custody or Chronolog page custody); host never stores `K_conn` or plaintext tokens.
 * - Inbound webhooks: constant-time HMAC-SHA256 verification without decrypting OAuth tokens.
 */
import { base64url } from '../accounts/oauth-support';
import { bytesToHex, hexToBytes, unbase64url } from '../mcp-crypto';
import { HttpError } from '../http';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface OutboundTokenSet {
  access_token: string;
  refresh_token?: string | null;
  token_type?: string;
  scope?: string;
  expires_at?: number | null;
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Generate a fresh 32-byte connection wrap key (`K_conn`) encoded as base64url. */
export function generateConnectionKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function importAesKey(kConnBase64url: string, usage: ('encrypt' | 'decrypt')[]): Promise<CryptoKey> {
  let raw: Uint8Array;
  try { raw = unbase64url(kConnBase64url); }
  catch { throw new HttpError(400, 'invalid_connection_key', 'Connection wrap key must be 32 random bytes (base64url)'); }
  if (raw.byteLength !== 32) {
    throw new HttpError(400, 'invalid_connection_key', 'Connection wrap key must be 32 bytes');
  }
  return crypto.subtle.importKey('raw', asBuffer(raw), { name: 'AES-GCM', length: 256 }, false, usage);
}

/**
 * Tier B: Wrap OAuth tokens under client-held `K_conn` with bound AAD context.
 * Output is JSON string stored in `outbound_connections.wrapped_tokens`.
 */
export async function wrapConnectionTokens(
  kConnBase64url: string,
  tokens: OutboundTokenSet,
  aadContext: string,
): Promise<string> {
  const key = await importAesKey(kConnBase64url, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(`tendriller-outbound-oauth-v1:${aadContext}`);
  const plaintext = encoder.encode(JSON.stringify(tokens));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(aad) },
    key,
    asBuffer(plaintext),
  ));
  return JSON.stringify({
    v: 1,
    alg: 'A256GCM',
    iv: base64url(iv),
    ct: base64url(ct),
  });
}

/** Tier B: Unwrap OAuth tokens strictly in RAM using caller-supplied `K_conn`. */
export async function unwrapConnectionTokens(
  kConnBase64url: string,
  wrappedJson: string,
  aadContext: string,
): Promise<OutboundTokenSet> {
  let env: { v?: unknown; alg?: unknown; iv?: unknown; ct?: unknown };
  try { env = JSON.parse(wrappedJson); }
  catch { throw new HttpError(500, 'wrapped_tokens_corrupt', 'Stored wrapped token envelope is invalid'); }
  if (env?.v !== 1 || env.alg !== 'A256GCM' || typeof env.iv !== 'string' || typeof env.ct !== 'string') {
    throw new HttpError(500, 'wrapped_tokens_corrupt', 'Unsupported wrapped token envelope');
  }
  const key = await importAesKey(kConnBase64url, ['decrypt']);
  const aad = encoder.encode(`tendriller-outbound-oauth-v1:${aadContext}`);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBuffer(unbase64url(env.iv)), additionalData: asBuffer(aad) },
      key,
      asBuffer(unbase64url(env.ct)),
    );
  } catch {
    throw new HttpError(403, 'connection_key_invalid', 'The supplied connection wrap key could not decrypt this connection.');
  }
  const parsed = JSON.parse(decoder.decode(plain)) as OutboundTokenSet;
  if (!parsed || typeof parsed.access_token !== 'string' || !parsed.access_token) {
    throw new HttpError(500, 'wrapped_tokens_corrupt', 'Unwrapped token payload missing access_token');
  }
  return parsed;
}

/**
 * Tier A: Seal OAuth tokens to a target agent's X25519 `wrapKey` (64 lowercase hex)
 * using ephemeral X25519 ECDH + HKDF-SHA256 + AES-256-GCM.
 */
export async function sealAgentTokens(
  agentWrapPublicKeyHex: string,
  tokens: OutboundTokenSet,
  aadContext: string,
): Promise<string> {
  const recipientPubBytes = hexToBytes(agentWrapPublicKeyHex);
  if (recipientPubBytes.byteLength !== 32) {
    throw new HttpError(400, 'invalid_wrap_key', 'Agent wrapKey must be 32 bytes (64 hex)');
  }
  const recipientPub = await crypto.subtle.importKey('raw', asBuffer(recipientPubBytes), { name: 'X25519' }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const ephemeralPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey) as ArrayBuffer);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: recipientPub } as any, ephemeral.privateKey, 256);
  const salt = new Uint8Array(64);
  salt.set(ephemeralPubBytes, 0);
  salt.set(recipientPubBytes, 32);
  const aad = encoder.encode(`tendriller-agent-oauth-v1:${aadContext}`);
  const ikm = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: asBuffer(salt), info: asBuffer(aad) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(tokens));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(aad) },
    aesKey,
    asBuffer(plaintext),
  ));
  return JSON.stringify({
    v: 1,
    alg: 'X25519-HKDF-A256GCM',
    epk: bytesToHex(ephemeralPubBytes),
    iv: base64url(iv),
    ct: base64url(ct),
  });
}

/** Constant-time byte comparison. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Verify an HMAC-SHA256 hex signature (supporting optional `sha256=` prefix). */
export async function verifyHmacSha256(secret: string, body: ArrayBuffer, signatureHeader: string): Promise<boolean> {
  const rawHex = signatureHeader.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(rawHex)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    asBuffer(encoder.encode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  const provided = hexToBytes(rawHex);
  return constantTimeEqual(expected, provided);
}
