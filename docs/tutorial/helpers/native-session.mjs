import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApplicationSession, describeApplication } from '@chronolog/peer-session';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { createAuthorityProvider, encodeRecord, decodeRecord, signEnrollmentRequest, signPublicationManifest, importSigningIdentity } from '@chronolog/authority';
import { authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';
import { watchApplicationSetup } from '@tendriller/core/setup';
import { readTransportDiagnostics } from '@tendriller/core/transport-diagnostics';
import { createNativeAttachmentKey, createNativeSessionSupervisor, attachNativeSession } from '@tendriller/core/native-owner';
import { participateNativeApplication } from '@tendriller/core/native-rtc';
import { createCliLifetime } from './cli-lifetime.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
/** Optional retained native participant. It never creates the application's first root or epoch key. */
export function createNativeBootstrap({ definition, local, createMaterializer }) {
  const { project, readPrivate, savePrivate, privateDirectory } = local;
  function paths(profile = 'main') {
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(profile)) throw Error('Use an explicit retained native profile name');
    return { profile, directory: fileURLToPath(new URL(`owner-${profile}/`, privateDirectory)),
      device: fileURLToPath(new URL(profile === 'main' ? 'device.sqlite' : `profiles/${profile}/device.sqlite`, privateDirectory)),
      credential: `native-attachment-${profile}.json` };
  }
  async function cachedSession({ profile = 'main', signal } = {}) {
    const selected = paths(profile), { handle, host } = await project({ signal });
    const device = await openNativeDevice({ path: selected.device }); let session;
    try {
      let authority;
      try { authority = await createAuthorityProvider({ store: device.store, applicationId: handle.application.id }); }
      catch (error) {
        if ((error.code ?? error.message) !== 'AUTHORITY_CACHE_MISSING') throw error;
        const metadata = await host.peers.application({ signal });
        if (!metadata.authority) throw Error('The first owner browser must initialize this application before optional native provisioning');
        const bundle = decodeRecord(authorityRecordBytes(metadata.authority));
        if (bundle.descriptor.payload.applicationId !== handle.application.id) throw Error('Application scope mismatch');
        authority = await createAuthorityProvider({ store: device.store, bundle });
      }
      session = await createApplicationSession({ device, definition, authority,
        ...(createMaterializer ? { createMaterializer: input => createMaterializer({ ...input, profile }) } : {}) });
      return { session, host, handle, selected };
    } catch (error) { if (session) await session.close(); else await device.close(); throw error; }
  }
  async function publicationControl(host) {
    return Object.freeze({
      async definition() { return { definition: describeApplication(definition) }; },
      publication: () => host.peers.publication(),
      async publicationOperation(operationId) {
        const publication = await readPrivate(`signed-publication-${digest(operationId)}.json`, true);
        return publication === null ? null : { publication, receipt: await host.peers.publication(publication.id) };
      },
      async preparePublication({ operationId, entry = 'index.html', files }) {
        if (typeof operationId !== 'string' || !operationId.length) throw Error('Retain an explicit publication operation ID');
        const name = `signed-publication-${digest(operationId)}.json`, existing = await readPrivate(name, true);
        if (existing) {
          if (JSON.stringify(existing.payload.files) !== JSON.stringify(files) || existing.payload.entry !== entry) throw Error('Publication operation ID already binds another graph');
          return existing;
        }
        const [metadata, previous] = await Promise.all([host.peers.application(), host.peers.publication()]);
        const scope = metadata.publicationAuthority, signer = await importSigningIdentity(await readPrivate('publisher.json'));
        if (!scope) throw Error('Prepare the independent publisher policy first');
        const publication = await signPublicationManifest({ applicationId: scope.applicationId, membershipId: scope.grantId,
          executionManifestDigest: scope.executionManifestDigest, author: signer.publicKey, operationId,
          revision: previous === null ? 0 : previous.publication.payload.revision + 1, previous: previous?.publication.id ?? null, entry, files }, signer);
        await savePrivate(name, publication); return publication;
      },
      publish: (publication, assets) => host.peers.publish(publication, assets),
    });
  }
  async function attachSession({ signal, profile = 'main', context } = {}) {
    const selected = paths(profile), handle = await readPrivate('handle.json'), credential = await readPrivate(selected.credential);
    if (!/^[a-f0-9]{64}$/.test(handle?.application?.id ?? '')) throw Error('Restore the original private application handle before attaching; no new signer was opened');
    return attachNativeSession({ directory: selected.directory, token: credential.token, applicationId: handle.application.id, connect: connectApplicationOwner, context, signal });
  }
  async function openSession({ signal, profile = 'main', mode = 'own' } = {}) {
    if (mode === 'attach') return attachSession({ signal, profile });
    const selected = paths(profile), { handle, host } = await project({ signal });
    let credential = await readPrivate(selected.credential, true);
    if (!credential) credential = await savePrivate(selected.credential, { token: createNativeAttachmentKey() });
    let participation, nativeSession;
    const control = await publicationControl(host);
    const supervisor = await createNativeSessionSupervisor({ directory: selected.directory, profileId: `${handle.application.id}:${profile}`,
      bindings: [{ id: 'terminal', token: credential.token }], signal,
      async openOwner() {
        const owned = await cachedSession({ profile, signal });
        nativeSession = owned.session;
        participation = participateNativeApplication(owned.session, { peers: owned.host.peers });
        return Object.assign(createApplicationOwner(owned.session), { control });
      },
    });
    return { session: nativeSession, participation, control, supervisor, mode: 'own',
      watchSetup: options => watchApplicationSetup({ ...options, api: handle.api, token: handle.token }),
      async close() { await supervisor.close(); await participation?.close(); } };
  }
  async function main(args = process.argv.slice(2), { lifetime: suppliedLifetime } = {}) {
    const lifetime = suppliedLifetime ?? createCliLifetime();
    try {
      const [action = 'run', input, namedProfile] = args;
      const profile = ['sign-enrollment', 'import-provisioning'].includes(action) ? namedProfile ?? 'main' : input ?? 'main', selected = paths(profile);
      if (action === 'status' || action === 'diagnostics') {
        const attached = await attachSession({ profile, signal: lifetime.signal });
        try { return await readTransportDiagnostics(attached.session, { signal: lifetime.signal }); }
        finally { await attached.detach(); }
      }
      if (action === 'init-device') {
        await mkdir(fileURLToPath(new URL(profile === 'main' ? './' : `profiles/${profile}/`, privateDirectory)), { recursive: true, mode: 0o700 });
        const device = await openNativeDevice({ path: selected.device, create: true });
        try { return { publicKey: device.identity.publicKey, next: 'In an existing owner browser, create an account-bound challenge for this public key. Sign it here with sign-enrollment CHALLENGE.json, then record that proof in the browser.' }; }
        finally { await device.close(); }
      }
      if (action === 'sign-enrollment') {
        const challenge = JSON.parse(await readFile(input, 'utf8')), device = await openNativeDevice({ path: selected.device });
        try {
          const { host, handle } = await project(), metadata = await host.peers.application(), bundle = decodeRecord(authorityRecordBytes(metadata.authority));
          if (challenge.applicationId !== handle.application.id || challenge.publicKey !== device.identity.publicKey) throw Error('Challenge belongs to another application/key');
          const { epoch, epochKeyDigest } = bundle.memberships.at(-1).payload;
          return authorityRecord(encodeRecord(await signEnrollmentRequest({ applicationId: handle.application.id, publicKey: device.identity.publicKey, challenge: challenge.challenge, epoch, epochKeyDigest }, device.identity)));
        } finally { await device.close(); }
      }
      if (action === 'provisioning-request' || action === 'import-provisioning') {
        const { session } = await cachedSession({ profile, signal: lifetime.signal });
        try {
          if (action === 'provisioning-request') return authorityRecord(encodeRecord(await session.provisioning.createProvisioningRequest()));
          await session.provisioning.importProvisioning(decodeRecord(authorityRecordBytes(JSON.parse(await readFile(input, 'utf8')))));
          return { imported: true, next: 'Run the optional native participant with its same retained store. Browser edits do not require this process.' };
        } finally { await session.close(); }
      }
      if (action !== 'run') throw Error('Use status [PROFILE], diagnostics [PROFILE], init-device [PROFILE], sign-enrollment FILE [PROFILE], provisioning-request [PROFILE], import-provisioning FILE [PROFILE], or run [PROFILE]');
      const owned = await openSession({ signal: lifetime.signal }); lifetime.opened();
      try { console.log(JSON.stringify({ state: 'running', applicationId: owned.session.applicationId, publicKey: owned.session.identity.publicKey, optional: true })); await new Promise(resolve => { if (lifetime.signal.aborted) resolve(); else lifetime.signal.addEventListener('abort', resolve, { once: true }); }); }
      finally { await owned.close(); lifetime.closed(); }
      return { stopped: true };
    } finally { if (!suppliedLifetime) await lifetime.finish(); }
  }
  return { openSession, attachSession, main };
}
