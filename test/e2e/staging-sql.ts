import { expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import type { createClient } from '../../dist/sdk/client.mjs';

type Peers = ReturnType<typeof createClient>['peers'];

export async function runStagingSql({ consumer, handle, page, peers }: {
  consumer: string; handle: { application: { id: string } }; page: Page; peers: Peers;
}) {
  const packageRoot = resolve(consumer, 'node_modules/@chronolog/peer-session');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const load = (entry = '') => import(pathToFileURL(join(packageRoot, manifest.exports[`.${entry}`].import)).href);
  const [log, native, sql, sqlNative, sockets] = await Promise.all([
    load(), load('/native'), load('/sql'), load('/sql-native'), load('/websocket'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'tendriller-live-sql-'));
  const sessions = [], devices = [], links = [];
  const id = handle.application.id, key = new Uint8Array(randomBytes(32)), engine = sqlNative.createNativeSqlEngine();
  const collective = log.bytesToHex(log.APPLICATION_COLLECTIVE_ID);
  const definition = log.defineApplication({
    id: 'staging-shared-tasks', version: '1',
    schema: log.program('CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE)'),
    commands: {
      add: log.defineCommand({
        description: 'Add a task and record a corresponding event',
        input: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } }, required: ['id', 'title'] },
        prepare: ({ id, title }) => log.program(log.sqlStatement(
          `INSERT INTO tasks (id,title,chronolog_owner) VALUES (?,?,(SELECT id FROM chronolog_principals WHERE key=X'${collective}'))`,
          [id, title]), log.emit('task.added', { id, title })),
      }),
    },
    queries: {
      tasks: log.defineQuery({ description: 'Read ordered tasks', input: { type: 'null' },
        read: view => view.query('SELECT id,title FROM tasks ORDER BY id') }),
    },
  });
  try {
    const openDevice = async (name: string, create = false) => {
      const device = await native.openNativeDevice({ path: join(directory, `${name}.sqlite`), create });
      devices.push(device);
      return device;
    };
    const aDevice = await openDevice('a', true), bDevice = await openDevice('b', true);
    const prepared = await sql.prepareSqlApplication({ engine, applicationId: id, definition, schemaAdministrator: aDevice.identity });
    const base = await peers.configureApplication({ historyId: 'live-task-board',
      definition: log.describeApplication(definition), schema: prepared.schema, executionManifestDigest: prepared.binding.executionManifestDigest,
      schemaAdministrator: aDevice.identity.publicKey, epoch: 0, keyDigest: await log.bytesDigest(key),
      members: [aDevice, bDevice].map(device => ({ grant: log.participantGrant(device.identity.publicKey, { administrator: true }) })),
    });
    const descriptor = base.descriptor.payload;
    await peers.selectGeneration(await log.signTransitionRequest({ applicationId: id, profile: descriptor.profile, policy: descriptor.policy,
      expectedGeneration: null, requester: aDevice.identity.publicKey, coordinator: aDevice.identity.publicKey,
      controlRevision: 0, base: null, reason: 'create', transitionId: randomUUID() }, aDevice.identity));
    const definitionInBrowser = await page.evaluate(async () => (window as any).tendril.host.peers.definition());
    expect(definitionInBrowser.schema).toEqual(prepared.schema);
    expect(definitionInBrowser.descriptor).toEqual(base.descriptor);

    const open = async (device, name) => {
      const session = await sql.openSqlApplication({ createEngine: () => engine, device,
        databasePath: join(directory, `${name}-data.sqlite`), authority: await peers.application(),
        definition, schema: prepared.schema, epochKeys: new Map([[0, key]]) });
      sessions.push(session);
      return session;
    };
    const connect = async (a, b) => {
      const channel = randomUUID();
      const connected = await Promise.all([[a, b], [b, a]].map(async ([local, remote]) => {
        const relay = peers.relay(channel, local.deviceId, { remotePeerId: remote.deviceId, signal: local.signal });
        const connection = await sockets.openWebSocketConnection(relay, { ready: relay.ready, signal: local.signal });
        const link = await local.connectPeer({ connection, peerIdentity: remote.deviceId });
        links.push(link);
        return link;
      }));
      await Promise.all(connected.map(link => link.synchronize()));
      return connected;
    };
    const add = async (session, id, title, operationId) => (await session.command('add', { id, title }, { operationId }))
      .applied({ signal: AbortSignal.timeout(12_000) });
    const a = await open(aDevice, 'a'), b = await open(bDevice, 'b');
    const first = await connect(a, b);
    expect((await add(a, 1, 'Retained task', 'retained')).outcome).toBe('accepted');
    await Promise.all(first.map(link => link.synchronize()));
    expect((await b.query('tasks', null)).value.rows).toEqual([[1, 'Retained task']]);
    expect((await add(b, 2, 'Retained task', 'duplicate')).outcome).toBe('rejected');
    await Promise.all(first.map(link => link.close()));
    const reconnected = await connect(a, b);
    expect(await b.operations.get('retained', { author: a.deviceId })).toMatchObject({ outcome: 'accepted' });
    await Promise.all(reconnected.map(link => link.close()));
    await a.close();
    await b.recovery.takeover(peers, { transitionId: randomUUID() });
    expect((await add(b, 3, 'After takeover', 'after-takeover')).outcome).toBe('accepted');
    await b.close();
    const reopened = await open(await openDevice('b'), 'b');
    expect(reopened.deviceId).toBe(bDevice.identity.publicKey);
    expect((await reopened.query('tasks', null)).value.rows).toEqual([[1, 'Retained task'], [3, 'After takeover']]);
    expect((await reopened.operations.get('after-takeover')).outcome).toBe('accepted');
  } finally {
    await Promise.allSettled(links.map(link => link.close()));
    await Promise.allSettled(sessions.map(session => session.close()));
    await Promise.allSettled(devices.map(device => device.close()));
    await rm(directory, { recursive: true, force: true });
  }
}
