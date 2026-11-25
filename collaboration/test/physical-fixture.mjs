// Public-package fixtures: real signed authority, operation set, materializer and owner.
// In-memory bytes qualify local protocol boundaries, not disk/native/Internet persistence.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const packageRoot = process.env.CHRONOLOG_SESSION_PACKAGE;
export const peerModule = suffix => packageRoot ? pathToFileURL(join(resolve(packageRoot), suffix ? suffix + '.mjs' : 'index.mjs')).href : import.meta.resolve('@chronolog/peer-session' + (suffix ? '/' + suffix : ''));
export const p = await import(peerModule(''));
export const worker = await import(peerModule('worker'));
export const browser = await import(peerModule('browser'));
export function memoryStore() {
  const values = new Map();
  return { async get(key) { return values.get(key)?.slice() ?? null; }, async put(key, bytes) { values.set(key, bytes.slice()); } };
}
export async function authorityForDevices(devices, { applicationId = 'a'.repeat(64), key = crypto.getRandomValues(new Uint8Array(32)) } = {}) {
  const signer = await p.createSigningIdentity(), artifacts = await p.executionManifestArtifacts(await p.eventExecutionManifest());
  const descriptor = await p.signAppDescriptor({ applicationId, rootPrincipal: devices[0].identity.publicKey, authorityPublicKey: signer.publicKey,
    executionManifestDigest: p.bytesToHex(artifacts.executionManifestDigest), finalityPolicy: { kind: 'none' } }, signer);
  const membership = await p.signMembership({ applicationId, revision: 0, previous: null, authorTimeAfterMs: -1n, epoch: 0,
    epochKeyDigest: await p.epochKeyCommitment(applicationId, 0, key), members: devices.map((device, index) => ({ publicKey: device.identity.publicKey, reader: true, writer: true, administrator: index === 0, publisher: false, finalizer: false })) }, signer);
  return { authority: { descriptor, memberships: [membership] }, key };
}
export async function createPhysicalSession({ definition, applicationId = 'a'.repeat(64), close } = {}) {
  const device = await p.openApplicationDevice({ store: memoryStore(), create: true, ...(close ? { close } : {}) });
  try {
    const { authority, key } = await authorityForDevices([device], { applicationId });
    return await p.createApplicationSession({ device, definition: definition ?? p.defineApplication({ id: 'physical-owner', version: '1', commands: {}, queries: {} }), authority, epochKeys: new Map([[0, key]]) });
  } catch (error) { await device.close(); throw error; }
}
