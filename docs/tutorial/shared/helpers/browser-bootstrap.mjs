import { createAuthorityProvider, encodeRecord, decodeRecord, signEnrollmentRequest, verifyAuthorityBundle, epochKeyCommitment } from '@chronolog/authority';
import { createPeersClient } from '@tendriller/core/peers';
import { authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';
/** Retained identity, keys and authority open before optional host discovery. */
export async function bootstrapBrowser({ configuration, device, signal }) {
  const base = new URL('_tendril/', configuration.page_url);
  if (base.origin !== globalThis.location.origin) throw Error('Open the signed page at its own authorized origin');
  const peers = createPeersClient({ base: base.href, applicationId: configuration.applicationId,
    async request(path, { method = 'GET', body, signal: requestSignal } = {}) {
      const response = await fetch(new URL(path, base), { method, credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000), ...[requestSignal].filter(Boolean)]),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const value = await response.json();
      if (!response.ok) throw Object.assign(Error(value.error?.message ?? `Host request failed (${response.status})`), { code: value.error?.code, status: response.status });
      return value;
    } });
  let authority;
  try { authority = await createAuthorityProvider({ store: device.store, applicationId: configuration.applicationId }); }
  catch (error) {
    if ((error.code ?? error.message) !== 'AUTHORITY_CACHE_MISSING') throw error;
    let metadata = await peers.application({ signal });
    const intentKey = `starter/bootstrap/${configuration.applicationId}`;
    let intent = await device.store.get(intentKey);
    if (metadata.authority === null && intent === null) {
      // Save key BEFORE sending the first enrollment proof. A lost host reply resumes this same key.
      intent = encodeRecord({ publicKey: device.identity.publicKey, epochKey: crypto.getRandomValues(new Uint8Array(32)) });
      await device.store.put(intentKey, intent);
    }
    let epoch = 0, epochKeyDigest;
    if (metadata.authority === null) {
      if (intent === null) throw Error('Original bootstrap key is missing');
      epochKeyDigest = await epochKeyCommitment(configuration.applicationId, epoch, decodeRecord(intent).epochKey);
    } else {
      const previous = decodeRecord(authorityRecordBytes(metadata.authority));
      await verifyAuthorityBundle(previous);
      if (previous.descriptor.payload.applicationId !== configuration.applicationId || previous.descriptor.payload.executionManifestDigest !== configuration.executionManifestDigest) throw Error('Application scope mismatch');
      ({ epoch, epochKeyDigest } = previous.memberships.at(-1).payload);
    }
    const challenge = await peers.challenge(device.identity.publicKey);
    const proof = await signEnrollmentRequest({ applicationId: challenge.applicationId, publicKey: challenge.publicKey, challenge: challenge.challenge, epoch, epochKeyDigest }, device.identity);
    metadata = await peers.enroll(authorityRecord(encodeRecord(proof)));
    if (!metadata.authority) throw Error('The owner must sign in before initializing application authority');
    const bundle = decodeRecord(authorityRecordBytes(metadata.authority));
    await verifyAuthorityBundle(bundle);
    if (bundle.descriptor.payload.applicationId !== configuration.applicationId || bundle.descriptor.payload.executionManifestDigest !== configuration.executionManifestDigest) throw Error('The host returned a different application execution scope');
    authority = await createAuthorityProvider({ store: device.store, bundle });
  }
  if (authority.descriptor.rootPrincipal === device.identity.publicKey && authority.epochKey(0) === null) {
    const intent = await device.store.get(`starter/bootstrap/${configuration.applicationId}`);
    if (intent === null) throw Object.assign(Error('This device is missing its original data key. Restore its retained bootstrap record; do not generate a replacement.'), { code: 'BOOTSTRAP_KEY_MISSING' });
    const retained = decodeRecord(intent);
    if (retained.publicKey !== device.identity.publicKey) throw Error('Bootstrap identity mismatch');
    await authority.installEpochKey(0, retained.epochKey);
  }
  if (authority.descriptor.executionManifestDigest !== configuration.executionManifestDigest) throw Error('Retained execution manifest differs from this publication');
  return { authority, peers };
}
