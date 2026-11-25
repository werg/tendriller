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
  const device = await context.openDevice({ create: action === 'provisioning-request' });
  let session;
  try {
    const authority = await authorityFor(context, device);
    // Only the crypto provisioning surface is used, not an event/SQL query or
    // command. Actual SQL materialization belongs to the optional page agent.
    session = await createApplicationSession({ device, definition, authority });
    if (action === 'provisioning-request') {
      const request = authorityRecord(encodeRecord(await session.provisioning.createProvisioningRequest()));
      await context.savePrivate('provisioning-request.json', request);
      return request;
    }
    const value = JSON.parse(await readFile(file, 'utf8'));
    await context.savePrivate(`provisioning-import-${digest(value)}.json`, value);
    await session.provisioning.importProvisioning(decodeRecord(authorityRecordBytes(value)));
    if (!authority.grant(device.identity.publicKey)?.reader || authority.epochKey(authority.currentMembership.epoch) === null) throw Error('The package did not establish this page’s explicit reader grant and current epoch key');
    await context.savePrivate('initialized.json', { applicationId: context.page.applicationId, publicKey: device.identity.publicKey, executionManifestDigest: authority.descriptor.executionManifestDigest, provisioned: true });
    return { provisioned: true, applicationId: context.page.applicationId, publicKey: device.identity.publicKey, next: 'The optional single agent program may now open this page with its cached keys. Browser authoring never waited for it. SQL engine/materialization availability is a separate native capability.' };
  } finally { if (session) await session.close(); else await device.close(); }
}
