import { expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { checklist, intake } from './specimens/sql-domains.mjs';
import type { PageClient } from '../../dist/sdk/client.mjs';

type Peers = PageClient['peers'];

export async function runStagingSql({ consumer, handle, page, peers, privateIntake = false }: {
  consumer: string; handle: { application: { id: string } }; page: Page; peers: Peers; privateIntake?: boolean;
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
  try {
    const openDevice = async (name: string, create = false) => {
      const device = await native.openNativeDevice({ path: join(directory, `${name}.sqlite`), create });
      devices.push(device);
      return device;
    };
    const aDevice = await openDevice('a', true), bDevice = await openDevice('b', true);
    const definition = privateIntake ? intake(log, aDevice.identity.publicKey) : checklist(log);
    const prepared = await sql.prepareSqlApplication({ engine, applicationId: id, definition, schemaAdministrator: aDevice.identity });
    const base = await peers.configureApplication({ historyId: privateIntake ? 'private-intake' : 'live-task-board',
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
    if (privateIntake) {
      const submit = async (session, body, revision, operationId) =>
        (await session.command('submit', { body, revision }, { operationId })).applied({ signal: AbortSignal.timeout(12_000) });
      expect((await submit(a, 'Initial private answer', 0, 'first')).outcome).toBe('accepted');
      await Promise.all(first.map(link => link.synchronize()));
      expect((await b.query('answer', null)).value).toEqual([['Initial private answer', 1]]);
      expect((await submit(b, 'Facilitator cannot alter the answer', 1, 'unauthorized')).outcome).toBe('rejected');
      expect((await submit(a, 'Corrected private answer', 1, 'correction')).outcome).toBe('accepted');
      expect((await submit(a, 'Stale answer', 1, 'stale')).outcome).toBe('rejected');
      await Promise.all(first.map(link => link.synchronize()));
      expect((await b.query('answer', null)).value).toEqual([['Corrected private answer', 2]]);
      const browserControl = await page.evaluate(async () => (window as any).tendril.host.peers.application());
      expect(JSON.stringify(browserControl)).not.toContain('private answer');
      expect(browserControl.controls[0].payload.grants.filter(grant => grant.dataRole === 'member').map(grant => grant.publicKey).sort())
        .toEqual([a.deviceId, b.deviceId].sort());
      const [count, revision] = (await b.query('summary', null)).value;
      return { count, revision };
    }
    expect((await add(a, 1, 'Retained task', 'retained')).outcome).toBe('accepted');
    await Promise.all(first.map(link => link.synchronize()));
    expect((await b.query('tasks', null)).value.rows).toEqual([[1, 'Retained task']]);
    expect((await add(b, 2, 'Retained task', 'duplicate')).outcome).toBe('rejected');
    const apply = async (session, command, operationId) =>
      (await session.command(command, 1, { operationId })).applied({ signal: AbortSignal.timeout(12_000) });
    const claims = await Promise.all([apply(a, 'claim', 'claim-a'), apply(b, 'claim', 'claim-b')]);
    expect(claims.map(result => result.outcome).sort()).toEqual(['accepted', 'rejected']);
    const [winner, loser] = claims[0].outcome === 'accepted' ? [a, b] : [b, a];
    expect((await apply(loser, 'finish', 'wrong-user-finish')).outcome).toBe('rejected');
    expect((await apply(winner, 'finish', 'finish-by-claimant')).outcome).toBe('accepted');
    await Promise.all(first.map(link => link.synchronize()));
    expect((await b.query('assignment', 1)).value).toEqual([winner.deviceId, 1]);
    const slot = 'Workshop bench · 15:00';
    const book = async (session, command, operationId) =>
      (await session.command(command, slot, { operationId })).applied({ signal: AbortSignal.timeout(12_000) });
    const reservations = await Promise.all([book(a, 'reserve', 'reserve-a'), book(b, 'reserve', 'reserve-b')]);
    expect(reservations.map(result => result.outcome).sort()).toEqual(['accepted', 'rejected']);
    const [holder, waiting] = reservations[0].outcome === 'accepted' ? [a, b] : [b, a];
    expect((await book(waiting, 'cancel', 'not-holder')).outcome).toBe('rejected');
    expect((await book(holder, 'cancel', 'release-slot')).outcome).toBe('accepted');
    expect((await book(waiting, 'reserve', 'book-after-release')).outcome).toBe('accepted');
    await Promise.all(first.map(link => link.synchronize()));
    expect((await b.query('reservations', null)).value).toEqual([[slot, waiting.deviceId]]);
    await Promise.all(first.map(link => link.close()));
    const reconnected = await connect(a, b);
    expect(await b.operations.get('retained', { author: a.deviceId })).toMatchObject({ outcome: 'accepted' });
    await Promise.all(reconnected.map(link => link.close()));
    expect((await add(a, 4, 'Local edit before loss', 'offline-tail')).outcome).toBe('accepted');
    expect((await b.query('tasks', null)).value.rows).toEqual([[1, 'Retained task']]);
    await a.close();
    await b.recovery.takeover(peers, { transitionId: randomUUID() });
    expect((await add(b, 3, 'After takeover', 'after-takeover')).outcome).toBe('accepted');
    const returning = await open(await openDevice('a'), 'a');
    const restored = await connect(returning, b);
    expect(await returning.operations.get('offline-tail')).toMatchObject({ status: 'abandoned' });
    expect((await b.query('tasks', null)).value.rows).toEqual([[1, 'Retained task'], [3, 'After takeover']]);
    const review = await returning.query('tasks', null);
    const retry = await returning.reapply('offline-tail', 'add', { id: 4, title: 'Reviewed edit' },
      { operationId: 'reviewed-tail', basedOn: review.revision });
    expect((await retry.applied({ signal: AbortSignal.timeout(12_000) })).outcome).toBe('accepted');
    await Promise.all(restored.map(link => link.synchronize()));
    expect((await b.query('tasks', null)).value.rows).toEqual([[1, 'Retained task'], [3, 'After takeover'], [4, 'Reviewed edit']]);
    await Promise.all(restored.map(link => link.close()));
    await b.close();
    const reopened = await open(await openDevice('b'), 'b');
    expect(reopened.deviceId).toBe(bDevice.identity.publicKey);
    expect((await reopened.query('tasks', null)).value.rows).toEqual([[1, 'Retained task'], [3, 'After takeover'], [4, 'Reviewed edit']]);
    expect((await reopened.operations.get('after-takeover')).outcome).toBe('accepted');
    expect((await reopened.query('assignment', 1)).value).toEqual([winner.deviceId, 1]);
  } finally {
    await Promise.allSettled(links.map(link => link.close()));
    await Promise.allSettled(sessions.map(session => session.close()));
    await Promise.allSettled(devices.map(device => device.close()));
    await rm(directory, { recursive: true, force: true });
  }
}
