#!/usr/bin/env node
// Generate a host attestation signing identity for the HOST_ATTESTATION_KEY Worker secret.
// Prints the secret JSON on stdout and the public key on stderr. See docs/OPERATIONS.md.
import { generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** `{publicKey, privateKey}` as lowercase hex (raw Ed25519 public key, PKCS#8 private key) — the @chronolog/authority exportSigningIdentity format. */
export function createAttestationKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return {
    publicKey: spki.subarray(spki.length - 32).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const key = createAttestationKey();
  process.stdout.write(JSON.stringify(key) + '\n');
  process.stderr.write(`HOST_ATTESTATION_KEY public key: ${key.publicKey}\n`);
}
