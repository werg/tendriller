import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPage, describeService, requireService, requireServiceOrigin, describeReadiness, requireCreationReady } from '@tendriller/core';
import { bytesDigest, describeApplication, participantGrant, signTransitionRequest, verifyAuthorityBundle } from '@chronolog/peer-session';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { definition } from './domain.mjs';
import { createNativeEngine } from './engine.mjs';
import { databasePath, devicePath, project, readPrivate, savePrivate, requireFreshProject } from './local.mjs';

export async function createProject(service, owner, name = 'Shared inventory') {
  if (!service || !owner) throw Error('Usage: npm run create -- https://YOUR_HOST VERIFIED_OWNER_EMAIL "Shared inventory"');
  const origin = requireServiceOrigin(service);
  const existing = await readPrivate('handle.json', true);
  if (existing) {
    if (new URL(existing.api).origin !== origin) throw Object.assign(Error('The saved handle belongs to another service origin. Resume it only with its matching connector, or use a separate directory for the requested service; never copy private device state between services.'), { code: 'service_origin_mismatch' });
    return { serviceOrigin: origin, page_url: existing.page_url, resumed: true, next: 'Run npm run init now and prepare/publish the app while the owner signs in; do not wait for a claimed reply.' };
  }
  await requireFreshProject();
  requireCreationReady(await describeReadiness(origin), { service: origin });
  requireService(await describeService(origin));
  // Load optional native code only after same-origin readiness and compatibility
  // pass, but diagnose its absence before creating any hosted page.
  await createNativeEngine();
  // A checkpoint restored during readiness or engine loading still prevents
  // allocating a replacement page for this private application directory.
  await requireFreshProject();
  const handle = await createPage(origin, { owner, name });
  await savePrivate('handle.json', handle);
  return { serviceOrigin: origin, page_url: handle.page_url, next: 'Run npm run init now and prepare/publish the app while the owner signs in; do not wait for a claimed reply.' };
}

export async function initializeProject() {
  const { handle, host } = await project();
  if (await readPrivate('initialized.json', true)) return { initialized: true, next: 'npm run demo' };
  // Explicit first setup may create a signer. All normal opens omit create:true.
  const device = await openNativeDevice({ path: devicePath, create: true });
  let session;
  try {
    let initial = await readPrivate('initial-input.json', true);
    if (!initial) initial = await savePrivate('initial-input.json', {
      historyId: `inventory-${randomUUID()}`, epochKey: randomBytes(32).toString('base64'),
    });
    const epochKey = new Uint8Array(Buffer.from(initial.epochKey, 'base64'));
    const engine = await createNativeEngine();
    const { prepareSqlApplication, openSqlApplication } = await import('@chronolog/peer-session/sql');
    let prepared = await readPrivate('schema.json', true);
    if (!prepared) prepared = await savePrivate('schema.json', await prepareSqlApplication({
      engine, applicationId: handle.application.id, definition, schemaAdministrator: device.identity,
    }));
    const configuration = {
      historyId: initial.historyId, definition: describeApplication(definition), schema: prepared.schema,
      executionManifestDigest: prepared.binding.executionManifestDigest,
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
    // Configuration alone is insufficient: openSqlApplication requires a
    // selected first generation. Save the signed request before its first send.
    await host.peers.selectGeneration(request);
    authority = await host.peers.application();
    await verifyAuthorityBundle(authority, await readPrivate('descriptor.json'));
    session = await openSqlApplication({ device, definition, authority, schema: prepared.schema, databasePath,
      createEngine: () => engine, epochKeys: new Map([[0, epochKey]]) });
    const first = await session.query('inventory', null); // Activates storage and persists the creator's keyring.
    await savePrivate('initialized.json', { applicationId: handle.application.id, deviceId: session.deviceId });
    return { initialized: true, applicationId: handle.application.id, bins: first.value.stock.length, next: 'npm run demo' };
  } finally { if (session) await session.close(); else await device.close(); }
}

export async function enrollBrowser(publicKey) {
  if (!/^[a-f0-9]{64}$/.test(publicKey ?? '')) throw Error('Copy the 64-character public key displayed by your own browser.');
  const { host } = await project(), descriptor = await readPrivate('descriptor.json');
  const info = await host.info();
  if (typeof info.owner_account_id !== 'string') {
    throw Error('This host must expose authenticated info.owner_account_id; update the host before using this tutorial enrollment.');
  }
  const savedName = `enroll-${publicKey}.json`;
  const previous = await readPrivate(savedName, true);
  if (previous) {
    // Lost replies resend the exact signed request, grants and account binding.
    await host.peers.selectGeneration(previous.request, { control: previous.control });
    await verifyAuthorityBundle(await host.peers.application(), descriptor);
    return { enrolled: publicKey, next: 'Run npm run peer, then open or reload the page; it connects by itself.' };
  }
  const authority = await host.peers.application();
  const verified = await verifyAuthorityBundle(authority, descriptor);
  if (verified.grant(publicKey)) throw Error('This device already has a grant. Inspect its current rights instead of replacing them.');
  const device = await openNativeDevice({ path: devicePath });
  let session;
  try {
    if (verified.current?.payload.coordinator !== device.identity.publicKey) {
      throw Error('Enrollment expects this local device to be the current coordinator. Inspect authority; do not select an older prefix.');
    }
    const prepared = await readPrivate('schema.json');
    const { openSqlApplication } = await import('@chronolog/peer-session/sql');
    session = await openSqlApplication({ device, definition, authority, schema: prepared.schema, databasePath,
      createEngine: () => createNativeEngine() });
    const base = await session.recoveryPoint();
    const current = verified.control.payload;
    // The first-app browser reads and writes, but cannot publish, administer,
    // select recovery or coordinate. Keep this native peer running for writes.
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
    await savePrivate(savedName, { request, control });
    await host.peers.selectGeneration(request, { control });
    await verifyAuthorityBundle(await host.peers.application(), descriptor);
    return { enrolled: publicKey, next: 'Run npm run peer, then open or reload the page; it connects by itself.' };
  } finally { if (session) await session.close(); else await device.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [action, ...args] = process.argv.slice(2);
  try {
    const result = action === 'create' ? await createProject(...args)
      : action === 'init' ? await initializeProject()
        : action === 'enroll' ? await enrollBrowser(args[0])
          : (() => { throw Error('Use create, init, or enroll. See /docs/STATE_MODELS.md on the selected service origin.'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; }
}
