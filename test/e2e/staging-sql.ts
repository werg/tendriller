import { expect, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import type { createClient } from '../../dist/sdk/client.mjs';

type Peers = ReturnType<typeof createClient>['peers'];

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
  const collective = log.bytesToHex(log.APPLICATION_COLLECTIVE_ID);
  const checklist = log.defineApplication({
    id: 'staging-shared-tasks', version: '1',
    schema: log.program('CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, claimed_by TEXT, done INTEGER NOT NULL DEFAULT 0)'),
    commands: {
      add: log.defineCommand({
        description: 'Add a task and record a corresponding event',
        input: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } }, required: ['id', 'title'] },
        prepare: ({ id, title }) => log.program(log.sqlStatement(
          `INSERT INTO tasks (id,title,chronolog_owner) VALUES (?,?,(SELECT id FROM chronolog_principals WHERE key=X'${collective}'))`,
          [id, title]), log.emit('task.added', { id, title })),
      }),
      claim: log.defineCommand({
        description: 'Claim an unfinished task', input: { type: 'integer' },
        prepare: id => log.program(
          log.sqlStatement("SELECT chronolog_assert((SELECT claimed_by IS NULL AND done=0 FROM tasks WHERE id=?),'task_unavailable')", [id]),
          log.sqlStatement('UPDATE tasks SET claimed_by=lower(hex(chronolog_actor())) WHERE id=?', [id]),
          log.emit('task.claimed', { id })),
      }),
      finish: log.defineCommand({
        description: 'Finish a task only as its claimant', input: { type: 'integer' },
        prepare: id => log.program(
          log.sqlStatement("SELECT chronolog_assert((SELECT claimed_by=lower(hex(chronolog_actor())) AND done=0 FROM tasks WHERE id=?),'claim_required')", [id]),
          log.sqlStatement('UPDATE tasks SET done=1 WHERE id=?', [id]),
          log.emit('task.finished', { id })),
      }),
    },
    queries: {
      assignment: log.defineQuery({ description: 'Read assignee and completion', input: { type: 'integer' },
        read: (view, id) => view.query('SELECT claimed_by,done FROM tasks WHERE id=?', [id]).rows[0] }),
      tasks: log.defineQuery({ description: 'Read ordered tasks', input: { type: 'null' },
        read: view => view.query('SELECT id,title FROM tasks ORDER BY id') }),
    },
  });
  const intake = (respondent: string) => log.defineApplication({
    id: 'staging-private-intake', version: '1',
    schema: log.program('CREATE TABLE answer (id INTEGER PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL)'),
    commands: {
      submit: log.defineCommand({
        description: 'Submit or correct a private answer at its expected revision',
        input: { type: 'object', properties: { body: { type: 'string', minLength: 1, maxLength: 2000 },
          revision: { type: 'integer', minimum: 0 } }, required: ['body', 'revision'] },
        prepare: ({ body, revision }) => log.program(
          log.sqlStatement("SELECT chronolog_assert(lower(hex(chronolog_actor()))=?,'respondent_required')", [respondent]),
          log.sqlStatement("SELECT chronolog_assert(coalesce((SELECT revision FROM answer WHERE id=1),0)=?,'stale_answer')", [revision]),
          log.sqlStatement(`INSERT INTO answer (id,body,revision,chronolog_owner)
            VALUES(1,?,?,(SELECT id FROM chronolog_principals WHERE key=X'${collective}'))
            ON CONFLICT(id) DO UPDATE SET body=excluded.body, revision=excluded.revision`, [body, revision + 1]),
          log.emit('answer.updated', { revision: revision + 1 })),
      }),
    },
    queries: {
      answer: log.defineQuery({ description: 'Read the current private answer', input: { type: 'null' },
        read: view => view.query('SELECT body,revision FROM answer WHERE id=1').rows }),
    },
  });
  try {
    const openDevice = async (name: string, create = false) => {
      const device = await native.openNativeDevice({ path: join(directory, `${name}.sqlite`), create });
      devices.push(device);
      return device;
    };
    const aDevice = await openDevice('a', true), bDevice = await openDevice('b', true);
    const definition = privateIntake ? intake(aDevice.identity.publicKey) : checklist;
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
      return;
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
    expect((await reopened.query('assignment', 1)).value).toEqual([winner.deviceId, 1]);
  } finally {
    await Promise.allSettled(links.map(link => link.close()));
    await Promise.allSettled(sessions.map(session => session.close()));
    await Promise.allSettled(devices.map(device => device.close()));
    await rm(directory, { recursive: true, force: true });
  }
}
