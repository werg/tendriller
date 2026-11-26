import { importSigningIdentity, signRecord, verifyRecord, type AuthorityBundle, type Signed, type SigningIdentity } from '@chronolog/authority';
export { signRecord, verifyRecord, type AuthorityBundle, type Signed };
import type { Env } from './env';
import { HttpError } from './http';

/**
 * The host's Ed25519 attestation key (Worker secret `HOST_ATTESTATION_KEY`,
 * `{"publicKey":"<64 hex>","privateKey":"<pkcs8 hex>"}`). It signs only
 * host attestations — evidence that an authenticated account proved a key —
 * and never descriptors, memberships or epoch keys.
 */
interface Parsed { publicKey: string; privateKey: string }
const KEY_RE = /^[0-9a-f]{64}$/, PRIVATE_RE = /^(?:[0-9a-f]{2}){16,256}$/;
const imported = new Map<string, Promise<SigningIdentity | null>>();

function parse(secret: string | undefined): Parsed | null {
  if (!secret) return null;
  try {
    const value = JSON.parse(secret) as Partial<Parsed>;
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'privateKey,publicKey' ||
      typeof value.publicKey !== 'string' || !KEY_RE.test(value.publicKey) || typeof value.privateKey !== 'string' || !PRIVATE_RE.test(value.privateKey)) return null;
    return { publicKey: value.publicKey, privateKey: value.privateKey };
  } catch { return null; }
}

/** The published attestation public key (hex), or null when this deployment has none configured. */
export function hostAttestationKey(env: Env): string | null {
  return parse(env.HOST_ATTESTATION_KEY)?.publicKey ?? null;
}

/** Imported once per isolate; a private key that does not match its public key is unconfigured. */
export function loadHostAttestationIdentity(env: Env): Promise<SigningIdentity | null> {
  const secret = env.HOST_ATTESTATION_KEY ?? '';
  let pending = imported.get(secret);
  if (!pending) {
    pending = (async () => {
      const value = parse(secret);
      if (!value) return null;
      try {
        const identity = await importSigningIdentity(value);
        // signRecord verifies its own signature against the declared public key.
        await signRecord('host-attestation-key-check', { check: true }, identity);
        return identity;
      } catch { return null; }
    })();
    imported.clear(); imported.set(secret, pending);
  }
  return pending;
}

export async function requireHostAttestationIdentity(env: Env): Promise<SigningIdentity> {
  const identity = await loadHostAttestationIdentity(env);
  if (!identity) throw new HttpError(503, 'attestation_unconfigured', 'This host has no valid HOST_ATTESTATION_KEY. See docs/OPERATIONS.md.');
  return identity;
}
