import { pathToFileURL, fileURLToPath } from 'node:url';
import { verifyAuthorityBundle } from '@chronolog/peer-session';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { openSqlApplication } from '@chronolog/peer-session/sql';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeerIntroductions } from '@tendriller/core/peers';
import { attachNativeSession, createNativeAttachmentKey, createNativeSessionSupervisor } from '@tendriller/core/collaboration/native';
import { definition } from './domain.mjs';
import { createNativeEngine } from './engine.mjs';
import { databasePath, devicePath, privateDirectory, project, readPrivate, savePrivate } from './local.mjs';

function paths(profile = 'main') {
  if (!/^[A-Za-z0-9_-]{1,48}$/u.test(profile)) throw Error('Choose a retained native profile name.');
  return { profile, directory: fileURLToPath(new URL(`owner-${profile}`, privateDirectory)),
    device: profile === 'main' ? devicePath : fileURLToPath(new URL(`profiles/${profile}/device.sqlite`, privateDirectory)),
    database: profile === 'main' ? databasePath : fileURLToPath(new URL(`profiles/${profile}/materialized.sqlite`, privateDirectory)),
    credential: `native-attachment-${profile}.json` };
}

export async function attachSession({ signal, profile = 'main', context } = {}) {
  const selected = paths(profile), handle = await readPrivate('handle.json'), binding = await readPrivate(selected.credential, true);
  const token = process.env.TENDRIL_NATIVE_ATTACHMENT_KEY ?? binding?.token;
  if (!token) throw Error('Start npm run peer for this retained profile, then attach again.');
  return attachNativeSession({ directory: selected.directory, token, connect: connectApplicationOwner,
    applicationId: handle.application.id, definitionId: definition.id, definitionVersion: definition.version, context, signal });
}

// The same supervisor fence protects both the signer and SQL materialization.
export async function openSession({ signal, mode = 'own', profile = 'main' } = {}) {
  signal?.throwIfAborted();
  if (mode === 'independent' && profile === 'main') throw Error('Independent mode requires a separately provisioned and enrolled profile.');
  const selected = paths(profile);
  let binding = await readPrivate(selected.credential, true);
  if (!binding) binding = await savePrivate(selected.credential, { id: 'local-terminal', token: createNativeAttachmentKey() });
  let session, control;
  const supervisor = await createNativeSessionSupervisor({ directory: selected.directory, profileId: profile, signal,
    bindings: [binding], openOwner: async () => {
      const { host } = await project({ signal }), authority = await host.peers.application();
      await verifyAuthorityBundle(authority, await readPrivate('descriptor.json'));
      const device = await openNativeDevice({ path: selected.device });
      try {
        const prepared = await readPrivate('schema.json');
        session = await openSqlApplication({ device, definition, authority, schema: prepared.schema, databasePath: selected.database,
          async createEngine({ signal }) { signal.throwIfAborted(); return createNativeEngine(); },
        });
        const controlHost = { exchange: (message, options) => host.peers.exchange(message, options) };
        control = session.connectControlParticipant(controlHost);
        await session.participate({ control, ...createPeerIntroductions({ peers: host.peers, identity: session.deviceId,
          openDirectConnection: async () => { throw Error('TUTORIAL_NATIVE_RTC_NOT_CONFIGURED'); },
          openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
        }) });
        signal?.throwIfAborted(); return createApplicationOwner(session, { host: control });
      } catch (error) { if (session) await session.close(); else await device.close(); throw error; }
    } });
  return { session, control, supervisor, close: () => supervisor.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stopped = new AbortController(), stop = () => stopped.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let owned;
  try {
    owned = await openSession({ signal: stopped.signal, profile: process.argv[2] ?? 'main' });
    const { session, supervisor } = owned;
    console.log(JSON.stringify({ running: true, deviceId: session.deviceId, ownerInstanceId: supervisor.ownerInstanceId }));
    session.participation.onStatus(status => console.log(JSON.stringify({ connection: status.phase, error: status.error })));
    for await (const change of session.changes({ signal: stopped.signal })) {
      const snapshot = await session.query('inventory', null);
      console.log(JSON.stringify({ stock: snapshot.value.stock, revision: snapshot.revision, change: change.kind }));
    }
  } catch (error) {
    if (!stopped.signal.aborted) { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; }
  } finally { await owned?.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
