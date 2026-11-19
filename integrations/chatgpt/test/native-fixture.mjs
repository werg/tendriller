// Test-only public-package composition. No private Chronolog source imports and
// no production credentials. Callers must explicitly supply the built package.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadNativePackage(packagePath = process.env.CHRONOLOG_SESSION_PACKAGE) {
  if (!packagePath) throw Error('Set CHRONOLOG_SESSION_PACKAGE to the extracted public session artifact');
  const root = resolve(packagePath);
  const [peer, native] = await Promise.all([
    import(pathToFileURL(join(root, 'index.mjs')).href),
    import(pathToFileURL(join(root, 'native.mjs')).href),
  ]);
  return { peer, native, packagePath: root };
}

/** Two real native stores, signed test authority, and a public control exchange. */
export async function createNativeFixture(definition, { applicationId = 'a'.repeat(64), historyId = 'native-bridge-test', publisher = false } = {}) {
  const { peer, native, packagePath } = await loadNativePackage();
  const directory = await mkdtemp(join(tmpdir(), 'tendriller-native-'));
  const cleanup = []; let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures = [];
    try { for (const dispose of cleanup.reverse()) { try { await dispose(); } catch (error) { failures.push(error); } } }
    finally { await rm(directory, { recursive: true, force: true }); }
    if (failures.length) throw new AggregateError(failures, 'Native test fixture cleanup failed');
  };
  try {
    const hostSigner = await peer.createPeerIdentity();
    const paths = [join(directory, 'a.sqlite'), join(directory, 'b.sqlite')];
    const devices = [];
    for (const path of paths) {
      const device = await native.openNativeDevice({ path, create: true });
      devices.push(device); cleanup.push(() => device.close());
    }
    const epochKey = crypto.getRandomValues(new Uint8Array(32));
    const artifacts = await peer.executionManifestArtifacts(await peer.eventExecutionManifest());
    const descriptor = await peer.signApplicationDescriptor({ applicationId, historyId,
      profile: 'peer-generation-v1', policy: 'eligible-members-v1', controlPublicKey: hostSigner.publicKey,
      schemaAdministrator: devices[0].identity.publicKey, definitionDigest: await peer.applicationDefinitionDigest(definition),
      executionManifestDigest: peer.bytesToHex(artifacts.executionManifestDigest), schemaDigest: null }, hostSigner);
    const control = await peer.signControlRevision({ applicationId, profile: descriptor.payload.profile,
      policy: descriptor.payload.policy, revision: 0, previous: null, epoch: 0, keyDigest: await peer.bytesDigest(epochKey), recoveryFloor: null,
      grants: devices.map((device, index) => peer.participantGrant(device.identity.publicKey, {
        administrator: true, dataRole: 'member', publisher: publisher && index === 0 })) }, hostSigner);
    const registry = await peer.createGenerationRegistry({ store: new peer.MemoryBytesStore(), descriptor, controls: [control], signer: hostSigner });
    const select = async (device, base, transitionId) => {
      const bundle = await registry.read();
      return registry.select(await peer.signTransitionRequest({ applicationId, profile: descriptor.payload.profile,
        policy: descriptor.payload.policy, expectedGeneration: bundle.generations.at(-1)?.id ?? null,
        coordinator: device.identity.publicKey, requester: device.identity.publicKey, controlRevision: 0,
        base, transitionId, reason: base === null ? 'create' : 'takeover' }, device.identity));
    };
    await select(devices[0], null, 'initial');
    const publications = await peer.createPublicationRegistry({ store: new peer.MemoryBytesStore(), authority: () => registry.read() });
    const exchange = async request => {
      let result;
      if (request.facet === 'control' && request.action === 'read') result = await registry.read();
      else if (request.facet === 'publication' && request.action === 'read') {
        const saved = await publications.read();
        const selected = request.payload.id ? saved.find(value => value.id === request.payload.id) : saved.at(-1);
        result = selected ? { publication: selected, version: selected.payload.revision + 1 } : null;
      } else if (request.facet === 'publication' && request.action === 'publish') {
        const { publication, assets } = request.payload;
        for (const file of publication.payload.files) {
          const asset = assets.find(value => value.hash === file.hash);
          assert(asset, 'A publication must contain every referenced asset');
          await peer.verifyPublicationAsset(file, Buffer.from(asset.bytes, 'base64'));
        }
        const selected = await publications.publish(publication);
        result = { publication: selected, version: selected.payload.revision + 1 };
      } else throw Error('Unexpected native test control request');
      return peer.createParticipantResponse(request, result);
    };
    const open = async (index, resume = false) => {
      if (closed) throw Error('Native test fixture is closed');
      if (index !== 0 && index !== 1) throw Error('Native test fixture has two devices');
      const device = resume ? await native.openNativeDevice({ path: paths[index] }) : devices[index];
      const session = await native.openNativeApplication({ device, definition, authority: await registry.read(),
        ...(resume ? {} : { epochKeys: new Map([[0, epochKey]]) }) });
      cleanup.push(() => session.close());
      return { session, control: session.connectControlParticipant({ exchange }) };
    };
    const track = resource => { cleanup.push(() => resource.close()); return resource; };
    return { peer, native, packagePath, directory, paths, devices, descriptor, hostSigner, registry, publications, exchange, open, select, track, close };
  } catch (error) { await close(); throw error; }
}
