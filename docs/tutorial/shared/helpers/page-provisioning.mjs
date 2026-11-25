// Explicit per-page provisioning for the workspace's shared signer. These
// commands never create an application root, epoch key or SQL schema.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createApplicationSession, defineApplication } from '@chronolog/peer-session';
import { createAuthorityProvider, decodeRecord, encodeRecord, signEnrollmentRequest, verifyAuthorityBundle } from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';
const definition = defineApplication({ id: 'page-key-provisioning', version: '1', commands: {}, queries: {} });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function authorityFor(context, device) {
  try { return await createAuthorityProvider({ store: device.store, applicationId: context.page.applicationId }); }
  catch (error) {
    if ((error.code ?? error.message) !== 'AUTHORITY_CACHE_MISSING') throw error;
    const metadata = await context.host.peers.application({ signal: context.signal });
    if (!metadata.authority) throw Error('The first authorized browser must initialize this page before native key provisioning');
    const bundle = decodeRecord(authorityRecordBytes(metadata.authority));
    if (bundle.descriptor.payload.applicationId !== context.page.applicationId) throw Error('Page authority scope mismatch');
    return createAuthorityProvider({ store: device.store, bundle });
  }
}
export async function provisionPage(context, action, file) {
  if (action === 'sign-enrollment') {
    const challenge = JSON.parse(await readFile(file, 'utf8'));
    if (challenge.applicationId !== context.page.applicationId || challenge.publicKey !== context.signer.publicKey) throw Error('Challenge belongs to another page/shared signer');
    const name = `enrollment-${digest(challenge)}.json`, saved = await context.readPrivate(name, true);
    if (saved) return saved; // Preserve the original epoch-bound proof through uncertain replies.
    const metadata = await context.host.peers.application({ signal: context.signal });
    if (!metadata.authority) throw Error('The first authorized browser must initialize this page');
    const bundle = decodeRecord(authorityRecordBytes(metadata.authority));
    await verifyAuthorityBundle(bundle);
    if (bundle.descriptor.payload.applicationId !== context.page.applicationId) throw Error('Page authority scope mismatch');
    const { epoch, epochKeyDigest } = bundle.memberships.at(-1).payload;
    const proof = authorityRecord(encodeRecord(await signEnrollmentRequest({ applicationId: context.page.applicationId, publicKey: context.signer.publicKey, challenge: challenge.challenge, epoch, epochKeyDigest }, context.signer)));
    await context.savePrivate(name, proof);
    return proof;
  }
  if (!['provisioning-request', 'import-provisioning'].includes(action)) throw Error('Choose sign-enrollment FILE, provisioning-request, or import-provisioning FILE');
  if (action === 'provisioning-request') {
    const saved = await context.readPrivate('provisioning-request.json', true);
    if (saved) {
      const request = decodeRecord(authorityRecordBytes(saved));
      if (request.payload.applicationId !== context.page.applicationId || request.payload.recipient !== context.signer.publicKey) throw Error('Retained provisioning request belongs to another page/shared signer');
      return saved;
    }
  }
  if (action === 'import-provisioning') return importProvisioning(context, file);
  const device = await context.openDevice({ create: true });
  let session;
  try {
    const authority = await authorityFor(context, device);
    // Only the crypto provisioning surface is used, not an event/SQL query or
    // command. Actual SQL materialization belongs to the optional page agent.
    session = await createApplicationSession({ device, definition, authority });
    const request = authorityRecord(encodeRecord(await session.provisioning.createProvisioningRequest()));
    await context.savePrivate('provisioning-request.json', request);
    return request;
  } finally { if (session) await session.close(); else await device.close(); }
}

const importResult = receipt => ({ provisioned: true, applicationId: receipt.applicationId, publicKey: receipt.publicKey, next: 'The optional single agent program may now open this page with its cached keys. Browser authoring never waited for it. SQL engine/materialization availability is a separate native capability.' });
const markerFor = receipt => ({ applicationId: receipt.applicationId, publicKey: receipt.publicKey, executionManifestDigest: receipt.executionManifestDigest, provisioned: true });
const bound = (context, receipt, packageDigest, kind) => {
  if (receipt.schemaVersion !== 1 || receipt.kind !== kind || receipt.applicationId !== context.page.applicationId || receipt.publicKey !== context.signer.publicKey || receipt.packageDigest !== packageDigest)
    throw Error(`Retained provisioning ${kind} receipt belongs to another page, shared signer or package`);
  return receipt;
};
/** The eligibility marker is the only thing the running agent watches. It is published after the verified import, after the
 * awaited release of the page store lease AND after the durable release proof, so the agent can never open the store while
 * this command may still hold it. */
async function publishMarker(context, receipt) {
  const expected = markerFor(receipt), existing = await context.readPrivate('initialized.json', true);
  if (existing === null) { await context.savePrivate('initialized.json', expected); return; }
  if (JSON.stringify(existing) !== JSON.stringify(expected)) throw Error('Retained initialized marker belongs to another page/signer/execution graph; inspect it, nothing was replaced');
}
/** Durable proof that this command released the page store after the verified import. Never written before the close succeeds. */
async function recordRelease(context, imported, releasedName) {
  const released = { ...imported, kind: 'released', releasedAt: new Date().toISOString() };
  await context.savePrivate(releasedName, released);
  return released;
}
const storeInUse = error => (error?.code ?? error?.message) === 'BYTES_STORE_IN_USE' || /BYTES_STORE_IN_USE/.test(String(error?.message));
async function importProvisioning(context, file) {
  const value = JSON.parse(await readFile(file, 'utf8')), packageDigest = digest(value);
  const importedName = `provisioning-receipt-${packageDigest}.json`, releasedName = `provisioning-released-${packageDigest}.json`;
  // An import receipt proves the IMPORT only; it never proves the store lease is free. Only the release proof, written after an
  // awaited close, lets an exact repeat (an uncertain reply, a rerun while the agent owns the store) return without opening.
  const released = await context.readPrivate(releasedName, true);
  if (released) {
    bound(context, released, packageDigest, 'released');
    await publishMarker(context, released);
    return importResult(released);
  }
  const saved = await context.readPrivate(importedName, true);
  if (saved) {
    bound(context, saved, packageDigest, 'imported');
    // Imported but release unproven (the close failed or its reply was lost): the importer may still hold the store.
    // One exclusive cached-device acquisition validates the cached authority and current key and must close successfully.
    // No reimport, no new keys, no loop or sleep. A holder still present fails closed, claiming nothing.
    let device;
    try { device = await context.openDevice({ create: false }); }
    catch (error) {
      if (storeInUse(error)) throw Object.assign(Error('The earlier import of this exact package is verified, but its release of this page’s device store is not proven and the store is still held. No result is claimed and no marker was published. Stop whatever holds the store (this importer or the agent program), then repeat the same command.', { cause: error }), { code: 'provisioning_release_uncertain' });
      throw error;
    }
    try {
      const authority = await authorityFor(context, device);
      if (device.identity.publicKey !== saved.publicKey || !authority.grant(device.identity.publicKey)?.reader || authority.epochKey(authority.currentMembership.epoch) === null
        || authority.descriptor.executionManifestDigest !== saved.executionManifestDigest) throw Error('The cached authority or current epoch key does not match the verified import receipt; nothing was published');
    } finally { await device.close(); }
    const proof = await recordRelease(context, saved, releasedName);
    await publishMarker(context, proof);
    return importResult(proof);
  }
  if (!await context.readPrivate(`provisioning-import-${packageDigest}.json`, true)) await context.savePrivate(`provisioning-import-${packageDigest}.json`, value);
  let device;
  try { device = await context.openDevice({ create: false }); }
  catch (error) {
    if (storeInUse(error)) {
      throw Object.assign(Error('This page’s device store is in use by its running owner. A new, different provisioning package cannot be imported while the agent program owns the page; nothing was changed. Stop the agent program, import, then start it again. An exact repeat of an already imported package needs no stop.', { cause: error }), { code: 'page_store_in_use' });
    }
    throw error;
  }
  let session, receipt;
  try {
    const authority = await authorityFor(context, device);
    session = await createApplicationSession({ device, definition, authority });
    await session.provisioning.importProvisioning(decodeRecord(authorityRecordBytes(value)));
    if (!authority.grant(device.identity.publicKey)?.reader || authority.epochKey(authority.currentMembership.epoch) === null) throw Error('The package did not establish this page’s explicit reader grant and current epoch key');
    receipt = { schemaVersion: 1, kind: 'imported', applicationId: context.page.applicationId, publicKey: device.identity.publicKey, packageDigest,
      executionManifestDigest: authority.descriptor.executionManifestDigest, epoch: authority.currentMembership.epoch };
    // Durable proof that exactly this package was verified and applied (not that the lease is free).
    await context.savePrivate(importedName, receipt);
  } finally { if (session) await session.close(); else await device.close(); }
  // Reached only after the awaited close succeeded: now the release is provable, then the marker may be published.
  const proof = await recordRelease(context, receipt, releasedName);
  await publishMarker(context, proof);
  return importResult(proof);
}
