import { describeApplication } from '@chronolog/peer-session';

/**
 * Prepare host metadata with the workspace's existing opaque signer.
 * Chain genesis creation (`$reducers`, `$permissions`, `$keys`, `$finality`, `$publications`)
 * is the separate page-data step.
 */
export async function prepareHost(context, { definition, executionProfile = 'chronolog-v2', requestedFinality } = {}) {
  const configuration = {
    executionProfile,
    publisherKeys: [context.signer.publicKey],
    tools: describeApplication(definition),
    ...(requestedFinality ? { requestedFinality } : {}),
  };
  const previous = await context.readPrivate('host-configuration.json', true);
  if (previous && JSON.stringify(previous) !== JSON.stringify(configuration)) {
    throw Error('Retained preparation differs. Preserve the original workspace signer and chosen finality policy.');
  }
  await context.savePrivate('host-configuration.json', configuration);
  const metadata = await context.host.peers.prepare(configuration);
  if (metadata.selection.id !== context.page.applicationId) {
    throw Error('Host application scope differs from this explicitly granted page');
  }
  await context.savePrivate('prepared.json', { applicationId: context.page.applicationId, publisherKey: context.signer.publicKey });
  return { prepared: true, page_url: context.page.pageUrl };
}
