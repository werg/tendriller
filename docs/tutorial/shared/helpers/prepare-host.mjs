import { describeApplication } from '@chronolog/peer-session';
/** Prepare publication authority with the workspace's existing opaque signer.
 * Data creation (descriptor, membership and epoch key) is the separate page-data step. */
export async function prepareHost(context, { definition, executionManifestDigest, executionProfile, requestedFinality } = {}) {
  const configuration = { executionManifestDigest, executionProfile, publisherKeys: [context.signer.publicKey], tools: describeApplication(definition), ...(requestedFinality ? { requestedFinality } : {}) };
  const previous = await context.readPrivate('host-configuration.json', true);
  if (previous && JSON.stringify(previous) !== JSON.stringify(configuration)) throw Error('Retained preparation differs. Preserve the original workspace signer, execution graph and chosen finality policy.');
  await context.savePrivate('host-configuration.json', configuration);
  const metadata = await context.host.peers.prepare(configuration);
  if (metadata.selection.id !== context.page.applicationId || !metadata.publicationAuthority?.publisherKeys.includes(context.signer.publicKey)) throw Error('Host publication scope differs from this explicitly granted page');
  await context.savePrivate('prepared.json', { applicationId: context.page.applicationId, publisherKey: context.signer.publicKey, executionManifestDigest });
  return { prepared: true, page_url: context.page.pageUrl };
}
