import { pathToFileURL, fileURLToPath } from 'node:url';
import { verifyAuthorityBundle, signTransitionRequest } from '@chronolog/peer-session';
import { openNativeApplication, openNativeDevice } from '@chronolog/peer-session/native';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { readTransportDiagnostics } from '@tendriller/core/transport-diagnostics';
import { participateNativeApplication } from '@tendriller/core/native-rtc';
import { createDevicePairingClient } from '@tendriller/core/pairing';
import { attachNativeSession, createNativeAttachmentKey, createNativeSessionSupervisor } from '@tendriller/core/native-owner';
import { definition } from './domain.mjs';
import { devicePath, privateDirectory, project, readPrivate, readHostHandle, savePrivate } from './local.mjs';
import { watchApplicationSetup } from '@tendriller/core/setup';
import { createCliLifetime } from './helpers/cli-lifetime.mjs';
import { superviseParticipant } from './helpers/participant-lifecycle.mjs';
import { createReviewedPairingProcessor } from './pairing-native.mjs';

function paths(profile = 'main') {
  if (!/^[A-Za-z0-9_-]{1,48}$/u.test(profile)) throw Error('Choose a retained native profile name.');
  return { profile, directory: fileURLToPath(new URL(`owner-${profile}`, privateDirectory)),
    device: profile === 'main' ? devicePath : fileURLToPath(new URL(`profiles/${profile}/device.sqlite`, privateDirectory)),
    credential: `native-attachment-${profile}.json` };
}

// Normal terminal calls attach and never open the signing store. An unavailable
// owner is an actionable error; the CLI does not fall back to another signer.
export async function attachSession({ signal, profile = 'main', context } = {}) {
  const selected = paths(profile), handle = await readHostHandle();
  const binding = await readPrivate(selected.credential, true);
  const token = process.env.TENDRIL_NATIVE_ATTACHMENT_KEY ?? binding?.token;
  if (!token) throw Error('Start npm run peer for this retained profile, then attach again.');
  return attachNativeSession({ directory: selected.directory, token, connect: connectApplicationOwner,
    applicationId: handle.application.id, definitionId: definition.id, definitionVersion: definition.version, context, signal });
}

// Explicit ownership is used by the long-running peer and --mode own. The
// supervisor's exclusive fence is acquired before opening any native device.
export async function openSession({ signal, mode = 'own', profile = 'main' } = {}) {
  signal?.throwIfAborted();
  if (mode === 'independent' && profile === 'main') throw Error('Independent mode requires a separately provisioned and enrolled profile.');
  const selected = paths(profile);
  let binding = await readPrivate(selected.credential, true);
  if (!binding) binding = await savePrivate(selected.credential, { id: 'local-terminal', token: createNativeAttachmentKey() });
  let session, control, pairing, processPairings, setupHandle;
  const supervisor = await createNativeSessionSupervisor({ directory: selected.directory, profileId: profile, signal,
    bindings: [binding], openOwner: async () => {
      const { host, handle } = await project({ signal });
      setupHandle = handle;
      const authority = await host.peers.application({ signal });
      const descriptor = await readPrivate('descriptor.json');
      await verifyAuthorityBundle(authority, descriptor);
      const device = await openNativeDevice({ path: selected.device });
      try {
        session = await openNativeApplication({ device, definition, authority,
          signals: { limits: { maxQueuedSignals: 1024, maxQueuedBytes: 8 * 1024 * 1024 } } });
        pairing = Object.freeze({ descriptor, applicationId: handle.application.id,
          serviceOrigin: new URL(handle.api).origin, pageOrigin: new URL(handle.page_url).origin,
          authority: options => host.peers.application(options),
          // The retained owner signs in place. No identity/private key is
          // exported to terminal attachments, browser pages or helper files.
          signTransition: payload => signTransitionRequest(payload, device.identity),
          client: createDevicePairingClient({ url: handle.api + '/peers/pairing',
            headers: { Authorization: `Bearer ${handle.token}` },
            fetch: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.any([
              AbortSignal.timeout(30000), ...[signal, options.signal].filter(Boolean)]) }),
          }),
        });
        processPairings = createReviewedPairingProcessor({ session, pairing });
        const controlHost = { exchange: (message, options) => host.peers.exchange(message, options) };
        control = session.connectControlParticipant(controlHost);
        participateNativeApplication(session, { peers: host.peers, control });
        signal?.throwIfAborted();
        return createApplicationOwner(session, { host: control });
      } catch (error) { if (session) await session.close(); else await device.close(); throw error; }
    } });
  return { session, control, supervisor, pairing, processPairings,
    watchSetup: callbacks => watchApplicationSetup({ api: setupHandle.api, token: setupHandle.token, ...callbacks }), close: () => supervisor.close() };
}

export async function runPeer({ signal, profile = 'main' } = {}, { onOwned, onClosed } = {}) {
  const owned = await openSession({ signal, profile });
  let lifecycle;
  try {
    onOwned?.();
    lifecycle = superviseParticipant({ owned, signal, watch: owned.watchSetup,
      report: status => console.log(JSON.stringify(status)) });
    console.log(JSON.stringify({ running: true, profile, deviceId: owned.session.deviceId,
      ownerInstanceId: owned.supervisor.ownerInstanceId, terminal: 'tendril --session ./session.mjs --mode attach self' }));
    owned.session.participation.onStatus(status => console.log(JSON.stringify({ connection: status.phase, error: status.error })));
    for await (const change of owned.session.changes({ signal })) {
      const snapshot = await owned.session.query('notes', null);
      console.log(JSON.stringify({ notes: snapshot.value.length, revision: snapshot.revision, change: change.kind }));
    }
  } finally { try { await lifecycle?.close(); } finally { await owned.close(); } onClosed?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cli = createCliLifetime();
  try {
    if (['status', 'diagnostics'].includes(process.argv[2])) {
      const attached = await attachSession({ signal: cli.signal, profile: process.argv[3] ?? 'main' }); cli.opened();
      try { console.log(JSON.stringify(await readTransportDiagnostics(attached.session.participation, { signal: cli.signal }))); }
      finally { await attached.detach(); cli.closed(); }
    } else await runPeer({ signal: cli.signal, profile: process.argv[2] ?? 'main' }, { onOwned: cli.opened, onClosed: cli.closed });
  }
  catch (error) { cli.fail(error); }
  process.exit(await cli.finish());
}
