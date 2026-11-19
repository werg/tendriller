import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPage, describeService, requireService } from '@tendriller/core';
import { bytesDigest, bytesToHex, describeApplication, eventExecutionManifest,
  executionManifestArtifacts, participantGrant, signTransitionRequest, verifyAuthorityBundle } from '@chronolog/peer-session';
import { openNativeApplication, openNativeDevice } from '@chronolog/peer-session/native';
import { definition } from './domain.mjs';
import { createEnrollmentManager } from './enrollment.mjs';
import { devicePath, bridgeDevicePath, project, readPrivate, savePrivate } from './local.mjs';

export async function createBridgeDevice() {
  const device = await openNativeDevice({ path: bridgeDevicePath, create: true });
  try { return { publicKey: device.identity.publicKey, next: 'Verify this dedicated bridge key, then run npm run enroll:bridge -- PUBLIC_KEY.' }; }
  finally { await device.close(); }
}

export async function createProject(service, owner, name = 'Kitchen assistance') {
  const existing = await readPrivate('handle.json', true);
  if (existing) return { page_url: existing.page_url, next: 'Open this page and sign in as its owner, then run npm run init.' };
  if (!service || !owner) throw Error('Usage: npm run create -- https://YOUR_HOST VERIFIED_OWNER_EMAIL "Kitchen assistance"');
  const url = new URL(service);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw Error('Supply an HTTPS service origin (HTTP is allowed only for localhost development).');
  }
  requireService(await describeService(url.origin));
  const handle = await createPage(url.origin, { owner, name });
  await savePrivate('handle.json', handle);
  return { page_url: handle.page_url, next: 'Open this page and sign in as its owner, then run npm run init.' };
}

export async function initializeProject() {
  const { handle, host } = await project();
  const info = await host.info();
  if (!info.owner) throw Error(`The owner must first open ${handle.page_url} and sign in to claim it.`);
  if (await readPrivate('initialized.json', true)) return { initialized: true, next: 'npm run build' };
  // Explicit first setup may create a signer. All normal opens omit create:true.
  const device = await openNativeDevice({ path: devicePath, create: true });
  let session;
  try {
    let initial = await readPrivate('initial-input.json', true);
    if (!initial) initial = await savePrivate('initial-input.json', {
      historyId: `kitchen-${randomUUID()}`, epochKey: randomBytes(32).toString('base64'),
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
    if (authority.descriptor.payload.applicationId !== handle.application.id) throw Error('Unexpected application identity.');
    const pinned = await readPrivate('descriptor.json', true);
    if (pinned) await verifyAuthorityBundle(authority, pinned);
    else await savePrivate('descriptor.json', authority.descriptor);
    const descriptor = authority.descriptor.payload;
    let request = await readPrivate('genesis-request.json', true);
    if (!request) {
      if (authority.generations.length) throw Error('This application already has a generation from a different setup. Do not reset it.');
      request = await signTransitionRequest({
        applicationId: descriptor.applicationId, profile: descriptor.profile, policy: descriptor.policy,
        transitionId: `create-${randomUUID()}`, expectedGeneration: null,
        coordinator: device.identity.publicKey, requester: device.identity.publicKey,
        controlRevision: 0, reason: 'create', base: null,
      }, device.identity);
      await savePrivate('genesis-request.json', request);
    }
    // Configuration alone is insufficient: openNativeApplication requires a
    // selected first generation. Save the signed request before its first send.
    await host.peers.selectGeneration(request);
    authority = await host.peers.application();
    await verifyAuthorityBundle(authority, await readPrivate('descriptor.json'));
    session = await openNativeApplication({ device, definition, authority, epochKeys: new Map([[0, epochKey]]) });
    const first = await session.query('kitchenContext', null); // Activates storage and persists the creator's keyring.
    await savePrivate('initialized.json', { applicationId: handle.application.id, deviceId: session.deviceId });
    return { initialized: true, applicationId: handle.application.id, requests: first.value.requests.length, next: 'npm run build' };
  } finally { if (session) await session.close(); else await device.close(); }
}

export async function enrollBrowser(publicKey, action = 'enroll', reviewDigest) {
  if (!/^[a-f0-9]{64}$/.test(publicKey ?? '')) throw Error('Copy the 64-character public key displayed by your own browser.');
  const { host } = await project(), descriptor = await readPrivate('descriptor.json');
  const manager = createEnrollmentManager({ host, descriptor, read: readPrivate, save: savePrivate,
    prepare: input => prepareEnrollment({ ...input, descriptor }) });
  if (action === 'review') return manager.review(publicKey);
  if (action === 'approve') return manager.approve(publicKey, reviewDigest);
  if (action !== 'enroll') throw Error('Unknown enrollment action.');
  return manager.enroll(publicKey);
}

async function prepareEnrollment({ publicKey, ownerAccountId, bundle: authority, verified, descriptor }) {
  const device = await openNativeDevice({ path: devicePath });
  let session;
  try {
    if (verified.current?.payload.coordinator !== device.identity.publicKey) {
      throw Error('Enrollment expects this local device to be the current coordinator. Inspect authority; do not select an older prefix.');
    }
    session = await openNativeApplication({ device, definition, authority });
    const base = await session.recoveryPoint();
    const current = verified.control.payload;
    // The first-app browser reads and writes, but cannot publish, administer,
    // select recovery or coordinate. Keep this native peer running for writes.
    const grant = { ...participantGrant(publicKey), coordinator: false, recovery: false };
    const control = { epoch: current.epoch, keyDigest: current.keyDigest,
      grants: [...current.grants, grant], recoveryFloor: current.recoveryFloor,
      accounts: [{ publicKey, accountId: ownerAccountId }] };
    const request = await signTransitionRequest({
      applicationId: descriptor.payload.applicationId, profile: descriptor.payload.profile,
      policy: descriptor.payload.policy, transitionId: `enroll-${randomUUID()}`,
      expectedGeneration: verified.current.id, coordinator: device.identity.publicKey,
      requester: device.identity.publicKey, controlRevision: current.revision + 1,
      reason: 'control-change', base,
    }, device.identity);
    return { request, control };
  } finally { if (session) await session.close(); else await device.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, ...args] = process.argv.slice(2);
  try {
    const result = action === 'create' ? await createProject(...args)
      : action === 'init' ? await initializeProject()
        : ['enroll', 'enroll-bridge'].includes(action) ? await enrollBrowser(args[0])
          : action === 'enroll-review' ? await enrollBrowser(args[0], 'review')
            : action === 'enroll-approve' ? await enrollBrowser(args[0], 'approve', args[1])
          : action === 'bridge-key' ? await createBridgeDevice()
          : (() => { throw Error('Use create, init, enroll, enroll-review, enroll-approve, bridge-key, or enroll-bridge. See README.md.'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; }
}
