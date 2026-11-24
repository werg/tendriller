import { pathToFileURL, fileURLToPath } from 'node:url';
import { verifyAuthorityBundle } from '@chronolog/peer-session';
import { openNativeDevice } from '@chronolog/peer-session/native';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { openSqlApplication } from '@chronolog/peer-session/sql';
import { readTransportDiagnostics } from '@tendriller/core/transport-diagnostics';
import { participateNativeApplication } from '@tendriller/core/native-rtc';
import { attachNativeSession, createNativeAttachmentKey, createNativeSessionSupervisor } from '@tendriller/core/native-owner';
import { createCliLifetime } from '../helpers/cli-lifetime.mjs';
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
  if (!binding) binding = await savePrivate(selected.credential, { id: 'local-terminal', token: createNativeAttachmentKey(),
    policy: { capabilities: ['commands', 'queries', 'events', 'content', 'signals', 'operations', 'diagnostics', 'publish'] } });
  // Reuse retained binding policy verbatim; resuming never broadens its authority.
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
        participateNativeApplication(session, { peers: host.peers, control });
        signal?.throwIfAborted(); return createApplicationOwner(session, { host: control });
      } catch (error) { if (session) await session.close(); else await device.close(); throw error; }
    } });
  return { session, control, supervisor, close: () => supervisor.close() };
}

export async function runPeer({ signal, profile = 'main' } = {}, { onOwned, onClosed, report = value => console.log(JSON.stringify(value)) } = {}) {
  let owned;
  try {
    owned = await openSession({ signal, profile }); onOwned?.();
    const { session, supervisor } = owned;
    report({ running: true, deviceId: session.deviceId, ownerInstanceId: supervisor.ownerInstanceId });
    session.participation.onStatus(status => report({ connection: status.phase, error: status.error }));
    for await (const change of session.changes({ signal }))
      report({ revision: change.revision, change: change.kind });
  } finally { await owned?.close(); if (owned) onClosed?.(); }
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
