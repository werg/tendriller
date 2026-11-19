import { pathToFileURL } from 'node:url';
import { verifyAuthorityBundle } from '@chronolog/peer-session';
import { openNativeApplication, openNativeDevice } from '@chronolog/peer-session/native';
import { openWebSocketConnection } from '@chronolog/peer-session/websocket';
import { createPeerIntroductions } from '@tendriller/core/peers';
import { definition } from './domain.mjs';
import { devicePath, project, readPrivate } from './local.mjs';

// This is the complete bootstrap consumed by tendril --session ./session.mjs.
export async function openSession({ signal, deviceFile = devicePath } = {}) {
  signal?.throwIfAborted();
  const { host } = await project({ signal });
  const authority = await host.peers.application();
  await verifyAuthorityBundle(authority, await readPrivate('descriptor.json'));
  const device = await openNativeDevice({ path: deviceFile });
  let session;
  try {
    session = await openNativeApplication({ device, definition, authority });
    const control = session.connectControlParticipant({ exchange: (message, options) => host.peers.exchange(message, options) });
    await session.participate({ control, ...createPeerIntroductions({
      peers: host.peers, identity: session.deviceId,
      // The smallest default archive has no native RTC implementation. The
      // maintained adapter falls back to its authenticated encrypted relay.
      openDirectConnection: async () => { throw Error('TUTORIAL_NATIVE_RTC_NOT_CONFIGURED'); },
      openRelayConnection: ({ relay, signal }) => openWebSocketConnection(relay, { ready: relay.ready, signal }),
    }) });
    signal?.throwIfAborted();
    return { session, control };
  } catch (error) { if (session) await session.close(); else await device.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let session;
  try {
    ({ session } = await openSession({ signal: stopped.signal }));
    console.log('Native application peer running. Keep it open while using the page; Ctrl-C closes it.');
    session.participation.onStatus(status => console.log(JSON.stringify({ connection: status.phase, error: status.error })));
    for await (const change of session.changes({ signal: stopped.signal })) {
      const snapshot = await session.query('kitchenContext', null);
      console.log(JSON.stringify({ requests: snapshot.value.requests.length, revision: snapshot.revision, change: change.kind }));
    }
  } catch (error) {
    if (!stopped.signal.aborted) { console.error(`${error.code ?? error.name}: ${error.message}`); process.exitCode = 1; }
  } finally { await session?.close(); }
}
