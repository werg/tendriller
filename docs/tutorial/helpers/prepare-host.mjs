import { createSigningIdentity, exportSigningIdentity, importSigningIdentity } from '@chronolog/authority';
/** Publication has its own signer; setup never creates a data device or receives epoch keys. */
export async function prepareHost({ handle, host, readPrivate, savePrivate, definition, describeApplication, executionManifestDigest, executionProfile, requestedFinality }) {
  let saved = await readPrivate('publisher.json', true);
  if (!saved) saved = await savePrivate('publisher.json', await exportSigningIdentity(await createSigningIdentity()));
  const publisher = await importSigningIdentity(saved);
  const configuration = { executionManifestDigest, executionProfile, publisherKeys: [publisher.publicKey], tools: describeApplication(definition),
    ...(requestedFinality ? { requestedFinality } : {}) };
  const previous = await readPrivate('host-configuration.json', true);
  if (previous && JSON.stringify(previous) !== JSON.stringify(configuration)) throw Error('The retained configuration differs. Preserve the original publication key and chosen finality policy.');
  await savePrivate('host-configuration.json', configuration);
  const metadata = await host.peers.prepare(configuration);
  if (metadata.selection.id !== handle.application.id || metadata.publicationAuthority?.publisherKeys[0] !== publisher.publicKey) throw Error('Unexpected host publication scope');
  await savePrivate('initialized.json', { applicationId: handle.application.id, publisherKey: publisher.publicKey });
  return { initialized: true, dataInitialized: metadata.authority !== null, page_url: handle.page_url,
    next: 'npm run deploy. Give the ready page URL to the owner; their signed-in browser initializes data keys locally. No native process is necessary.' };
}
