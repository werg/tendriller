/**
 * Zero-plaintext-at-rest key wrapping for hosted MCP participants.
 *
 * Each OAuth grant owns an X25519 wrapping keypair:
 * - `wrap_public_key` (64-hex) is stored in D1 so the owner's browser can HPKE/ECDH-seal
 *   a page's revocable Ed25519 signing seed + epoch keys at any later time.
 * - `wrap_private_key` (32 bytes) is NEVER stored in D1 or DO SQLite; it travels only
 *   inside the OAuth access & refresh tokens (encrypted under the Worker's OAUTH_SIGNING_JWK
 *   secret) and is unwrapped strictly in RAM for the duration of an authenticated /mcp call.
 */
import { base64url } from './accounts/oauth-support';
import { HttpError } from './http';

// ASN.1 PKCS#8 wrapper for a 32-byte raw X25519 private key (RFC 8410).
const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[a-f0-9]*$/iu.test(hex)) {
    throw new HttpError(400, 'invalid_hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function unbase64url(encoded: string): Uint8Array {
  if (typeof encoded !== 'string' || !encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new HttpError(400, 'invalid_encoding');
  }
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importX25519PrivateKey(raw32: Uint8Array): Promise<CryptoKey> {
  if (raw32.byteLength !== 32) throw new HttpError(400, 'invalid_wrap_key');
  const pkcs8 = new Uint8Array(X25519_PKCS8_PREFIX.length + 32);
  pkcs8.set(X25519_PKCS8_PREFIX, 0);
  pkcs8.set(raw32, X25519_PKCS8_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', asBuffer(pkcs8), { name: 'X25519' }, false, ['deriveBits']);
}

async function importX25519PublicKey(raw32: Uint8Array): Promise<CryptoKey> {
  if (raw32.byteLength !== 32) throw new HttpError(400, 'invalid_wrap_key');
  return crypto.subtle.importKey('raw', asBuffer(raw32), { name: 'X25519' }, false, []);
}

async function deriveSharedAesKey(sharedBits: ArrayBuffer, salt: Uint8Array, info: Uint8Array, usage: ('encrypt' | 'decrypt')[]): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: asBuffer(salt), info: asBuffer(info) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

/** Generate a fresh X25519 keypair for an OAuth grant. */
export async function generateWrapKeyPair(): Promise<{ publicKeyHex: string; privateKeyBytes: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
  if (pubRaw.byteLength !== 32 || privPkcs8.byteLength < 32) throw new Error('Unexpected X25519 key length');
  return {
    publicKeyHex: bytesToHex(pubRaw),
    privateKeyBytes: privPkcs8.slice(-32),
  };
}

export interface HostedKeyMaterial {
  /** 32-byte raw Ed25519 seed (hex) used as managedSigner in RAM only. */
  signingSeedHex: string;
  /** 32-byte raw Ed25519 public key (64-hex). */
  signingPublicKey: string;
  /** Map of epoch number -> 32-byte raw epoch key (hex). */
  epochKeys: Record<string, string>;
}

/**
 * Seal a page's hosted MCP signing seed + epoch keys to the OAuth grant's public X25519 key.
 * Output is UTF-8 JSON bytes suitable for storing as a BLOB in `mcp_connections.wrapped_keys`.
 */
export async function sealHostedKeys(
  wrapPublicKeyHex: string,
  material: HostedKeyMaterial,
  aadContext: string,
): Promise<Uint8Array> {
  const recipientPubBytes = hexToBytes(wrapPublicKeyHex);
  const recipientPub = await importX25519PublicKey(recipientPubBytes);
  const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const ephemeralPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey) as ArrayBuffer);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: recipientPub } as any, ephemeral.privateKey, 256);
  const salt = new Uint8Array(64);
  salt.set(ephemeralPubBytes, 0);
  salt.set(recipientPubBytes, 32);
  const aad = encoder.encode(`tendriller-mcp-keys-v1:${aadContext}`);
  const aesKey = await deriveSharedAesKey(sharedBits, salt, aad, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(material));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(aad) },
    aesKey,
    asBuffer(plaintext),
  ));
  return encoder.encode(JSON.stringify({
    v: 1,
    epk: bytesToHex(ephemeralPubBytes),
    iv: base64url(iv),
    ct: base64url(ciphertext),
  }));
}

export function normalizeEd25519Pkcs8Hex(hex: string): string {
  if (/^[a-f0-9]{96}$/iu.test(hex)) return hex.toLowerCase();
  if (/^[a-f0-9]{64}$/iu.test(hex)) return '302e020100300506032b657004220420' + hex.toLowerCase();
  throw new HttpError(400, 'invalid_wrapped_keys');
}

/** Unseal a page's hosted MCP signing seed + epoch keys strictly in RAM using the token-delivered X25519 private key. */
export async function unsealHostedKeys(
  wrapPrivateKeyBytes: Uint8Array,
  wrapPublicKeyHex: string,
  sealedBytes: Uint8Array,
  aadContext: string,
): Promise<HostedKeyMaterial> {
  let envelope: { v?: unknown; epk?: unknown; iv?: unknown; ct?: unknown };
  try {
    envelope = JSON.parse(decoder.decode(sealedBytes));
  } catch {
    throw new HttpError(400, 'invalid_wrapped_keys');
  }
  if (envelope?.v !== 1 || typeof envelope.epk !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') {
    throw new HttpError(400, 'invalid_wrapped_keys');
  }
  const ephemeralPubBytes = hexToBytes(envelope.epk);
  const recipientPubBytes = hexToBytes(wrapPublicKeyHex);
  const [privKey, epkKey] = await Promise.all([
    importX25519PrivateKey(wrapPrivateKeyBytes),
    importX25519PublicKey(ephemeralPubBytes),
  ]);
  const sharedBits = await crypto.subtle.deriveBits({ name: 'X25519', public: epkKey } as any, privKey, 256);
  const salt = new Uint8Array(64);
  salt.set(ephemeralPubBytes, 0);
  salt.set(recipientPubBytes, 32);
  const aad = encoder.encode(`tendriller-mcp-keys-v1:${aadContext}`);
  const aesKey = await deriveSharedAesKey(sharedBits, salt, aad, ['decrypt']);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBuffer(unbase64url(envelope.iv)), additionalData: asBuffer(aad) },
      aesKey,
      asBuffer(unbase64url(envelope.ct)),
    );
  } catch {
    throw new HttpError(403, 'mcp_key_unwrap_failed', 'The OAuth token could not unwrap this page’s hosted MCP keys.');
  }
  const parsed = JSON.parse(decoder.decode(plaintext)) as HostedKeyMaterial;
  if (!parsed || typeof parsed.signingSeedHex !== 'string' || !/^[a-f0-9]{64}([a-f0-9]{32})?$/iu.test(parsed.signingSeedHex) ||
      typeof parsed.signingPublicKey !== 'string' || !/^[a-f0-9]{64}$/iu.test(parsed.signingPublicKey) ||
      !parsed.epochKeys || typeof parsed.epochKeys !== 'object') {
    throw new HttpError(400, 'invalid_wrapped_keys');
  }
  return parsed;
}

/**
 * Derive an AES-256-GCM key from the Worker's OAUTH_SIGNING_JWK secret so `wk` carried inside
 * OAuth tokens (and transient 120s auth codes) is opaque even if a client inspects JWT claims.
 */
async function tokenProtectionKey(secretMaterial: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(`tendriller-oauth-wk-v1:${secretMaterial}`));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealTokenWrapKey(secretMaterial: string, context: string, raw32: Uint8Array): Promise<string> {
  if (raw32.byteLength !== 32) throw new Error('Expected 32-byte wrap key');
  const key = await tokenProtectionKey(secretMaterial);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(`wk:${context}`);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(aad) },
    key,
    asBuffer(raw32),
  ));
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv, 0);
  combined.set(ct, 12);
  return base64url(combined);
}

export async function unsealTokenWrapKey(secretMaterial: string, context: string, sealed: string): Promise<Uint8Array> {
  const combined = unbase64url(sealed);
  if (combined.byteLength <= 12) throw new HttpError(401, 'invalid_token');
  const key = await tokenProtectionKey(secretMaterial);
  const iv = combined.subarray(0, 12);
  const ct = combined.subarray(12);
  const aad = encoder.encode(`wk:${context}`);
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(aad) },
      key,
      asBuffer(ct),
    ));
    if (plain.byteLength !== 32) throw Error('bad length');
    return plain;
  } catch {
    throw new HttpError(401, 'invalid_token');
  }
}

async function hostedRequestKey(signingSeedHex: string, usage: ('encrypt' | 'decrypt')[]): Promise<CryptoKey> {
  const seed = await crypto.subtle.importKey('raw', asBuffer(hexToBytes(signingSeedHex.toLowerCase())), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode('tendriller-hosted-mcp-requests-v1') },
    seed, { name: 'AES-GCM', length: 256 }, false, usage);
}

/**
 * Seal the hosted participant's own signed-intent request records (operationId → proposal) under a key
 * derived from its wrapped signing seed. Only an authenticated call that unwraps that seed can reopen them,
 * so a retried operationId resolves to its original proposal without plaintext metadata at rest.
 */
export async function sealHostedRequests(signingSeedHex: string, context: string, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBuffer(iv), additionalData: asBuffer(encoder.encode('requests:' + context)) },
    await hostedRequestKey(signingSeedHex, ['encrypt']), asBuffer(bytes)));
  const out = new Uint8Array(12 + ct.byteLength); out.set(iv, 0); out.set(ct, 12);
  return out;
}

/** Null when the record was sealed by another (rotated) hosted identity or context. */
export async function unsealHostedRequests(signingSeedHex: string, context: string, sealed: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.byteLength <= 12) return null;
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(sealed.subarray(0, 12)), additionalData: asBuffer(encoder.encode('requests:' + context)) },
      await hostedRequestKey(signingSeedHex, ['decrypt']), asBuffer(sealed.subarray(12))));
  } catch { return null; }
}
