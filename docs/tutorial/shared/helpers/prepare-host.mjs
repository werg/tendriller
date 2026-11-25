import { describeApplication } from '@chronolog/peer-session';
/** Prepare publication authority with the workspace's existing opaque signer.
 * No page device, SQL schema, data root or epoch key is created by this step. */
export async function prepareHost(context, { definition, executionManifestDigest, executionProfile, requestedFinality } = {}) {
  const configuration = { executionManifestDigest, executionProfile, publisherKeys: [context.signer.publicKey], tools: describeApplication(definition), ...(requestedFinality ? { requestedFinality } : {}) };
  const previous = await context.readPrivate('host-configuration.json', true);
  if (previous && JSON.stringify(previous) !== JSON.stringify(configuration)) throw Error('Retained preparation differs. Preserve the original workspace signer, execution graph and chosen finality policy.');
  await context.savePrivate('host-configuration.json', configuration);
  const metadata = await context.host.peers.prepare(configuration);
  if (metadata.selection.id !== context.page.applicationId || !metadata.publicationAuthority?.publisherKeys.includes(context.signer.publicKey)) throw Error('Host publication scope differs from this explicitly granted page');
  await context.savePrivate('prepared.json', { applicationId: context.page.applicationId, publisherKey: context.signer.publicKey, executionManifestDigest });
  return { prepared: true, initialized: false, dataInitialized: metadata.authority !== null, page_url: context.page.pageUrl,
    next: `npm run deploy -- ${context.page.slug}. Give the ready URL to the owner; their first authorized browser initializes local data keys. The native agent is optional and requires explicit per-page key provisioning.` };
}
