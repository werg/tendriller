// Explicit first setup of this page's application. Run through the workspace:
//   npm run init -- <slug>            npm run enroll -- <slug> BROWSER_PUBLIC_KEY
// The page context supplies its page client, private records and a device signed by
// the workspace's one agent key. Every retry reuses the saved records verbatim.
import { randomBytes, randomUUID } from 'node:crypto';
import { bytesDigest, bytesToHex, describeApplication, eventExecutionManifest,
  executionManifestArtifacts, participantGrant, signTransitionRequest, verifyAuthorityBundle } from '@chronolog/peer-session';
import { openNativeApplication } from '@chronolog/peer-session/native';
import { definition } from './domain.mjs';

export async function initializePage(context) {
  const { page, host } = context;
  if (await context.readPrivate('initialized.json', true)) return { initialized: true, next: `npm run build -- ${page.slug}` };
  // Only this first setup may create the page device; normal opens omit create.
  const device = await context.openDevice({ create: true });
  let session;
  try {
    let initial = await context.readPrivate('initial-input.json', true);
    if (!initial) initial = await context.savePrivate('initial-input.json', {
      historyId: `notes-${randomUUID()}`, epochKey: randomBytes(32).toString('base64'),
    });
    const epochKey = new Uint8Array(Buffer.from(initial.epochKey, 'base64'));
    const execution = await executionManifestArtifacts(await eventExecutionManifest());
    const configuration = {
      historyId: initial.historyId, definition: describeApplication(definition), schema: null,
      executionManifestDigest: bytesToHex(execution.executionManifestDigest),
      schemaAdministrator: device.identity.publicKey, epoch: 0, keyDigest: await bytesDigest(epochKey),
      members: [{ grant: participantGrant(device.identity.publicKey, { administrator: true, publisher: true }) }],
    };
    // The host accepts an exact configuration retry and rejects changed inputs.
    let authority = await host.peers.configureApplication(configuration);
    await verifyAuthorityBundle(authority);
    if (authority.descriptor.payload.applicationId !== page.applicationId) throw Error('Unexpected application identity.');
    const pinned = await context.readPrivate('descriptor.json', true);
    if (pinned) await verifyAuthorityBundle(authority, pinned);
    else await context.savePrivate('descriptor.json', authority.descriptor);
    const descriptor = authority.descriptor.payload;
    let request = await context.readPrivate('genesis-request.json', true);
    if (!request) {
      if (authority.generations.length) throw Error('This application already has a generation from a different setup. Do not reset it.');
      request = await signTransitionRequest({
        applicationId: descriptor.applicationId, profile: descriptor.profile, policy: descriptor.policy,
        transitionId: `create-${randomUUID()}`, expectedGeneration: null,
        coordinator: device.identity.publicKey, requester: device.identity.publicKey,
        controlRevision: 0, reason: 'create', base: null,
      }, device.identity);
      await context.savePrivate('genesis-request.json', request);
    }
    // Configuration alone is insufficient: openNativeApplication requires a
    // selected first generation. Save the signed request before its first send.
    await host.peers.selectGeneration(request);
    authority = await host.peers.application();
    await verifyAuthorityBundle(authority, await context.readPrivate('descriptor.json'));
    session = await openNativeApplication({ device, definition, authority, epochKeys: new Map([[0, epochKey]]) });
    // Activate durable storage and persist the creator's keyring without a domain query.
    const view = await session.readView();
    try {
      // The running agent program opens this page once initialized.json exists.
      await context.savePrivate('initialized.json', { applicationId: page.applicationId, deviceId: session.deviceId });
      return { initialized: true, applicationId: page.applicationId, revision: view.revision, next: `npm run build -- ${page.slug}` };
    } finally { view.release(); }
  } finally { if (session) await session.close(); else await device.close(); }
}

/** Manual enrollment of one browser key. Stop `tendril agent run` first: it owns this
 * page's device store while it runs. Reviewed pairing needs no manual step. */
export async function enrollBrowser(context, publicKey) {
  if (!/^[a-f0-9]{64}$/.test(publicKey ?? '')) throw Error('Copy the 64-character public key displayed by your own browser.');
  const { host, page } = context, descriptor = await context.readPrivate('descriptor.json');
  const info = await host.info();
  if (typeof info.owner_account_id !== 'string') {
    throw Error('This host must expose authenticated info.owner_account_id; update the host before using this tutorial enrollment.');
  }
  const next = `Start npm run agent, then open or reload the page; it connects by itself.`;
  const savedName = `enroll-${publicKey}.json`;
  const previous = await context.readPrivate(savedName, true);
  if (previous) {
    // Lost replies resend the exact signed request, grants and account binding.
    await host.peers.selectGeneration(previous.request, { control: previous.control });
    await verifyAuthorityBundle(await host.peers.application(), descriptor);
    return { enrolled: publicKey, page: page.slug, next };
  }
  const authority = await host.peers.application();
  const verified = await verifyAuthorityBundle(authority, descriptor);
  if (verified.grant(publicKey)) throw Error('This device already has a grant. Inspect its current rights instead of replacing them.');
  const device = await context.openDevice();
  let session;
  try {
    if (verified.current?.payload.coordinator !== device.identity.publicKey) {
      throw Error('Enrollment expects this workspace agent to be the current coordinator. Inspect authority; do not select an older prefix.');
    }
    session = await openNativeApplication({ device, definition, authority });
    const base = await session.recoveryPoint();
    const current = verified.control.payload;
    // The first-app browser reads and writes, but cannot publish, administer,
    // select recovery or coordinate.
    const grant = { ...participantGrant(publicKey), coordinator: false, recovery: false };
    const control = { epoch: current.epoch, keyDigest: current.keyDigest,
      grants: [...current.grants, grant], recoveryFloor: current.recoveryFloor,
      accounts: [{ publicKey, accountId: info.owner_account_id }] };
    const request = await signTransitionRequest({
      applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile,
      policy: descriptor.payload.policy, transitionId: `enroll-${randomUUID()}`,
      expectedGeneration: verified.current.id, coordinator: device.identity.publicKey,
      requester: device.identity.publicKey, controlRevision: current.revision + 1,
      reason: 'control-change', base,
    }, device.identity);
    await context.savePrivate(savedName, { request, control });
    await host.peers.selectGeneration(request, { control });
    await verifyAuthorityBundle(await host.peers.application(), descriptor);
    return { enrolled: publicKey, page: page.slug, next };
  } finally { if (session) await session.close(); else await device.close(); }
}
