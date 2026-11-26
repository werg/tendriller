import { expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { checklist, intake } from './specimens/sql-domains.mjs';
import { signSpecimenGenesis } from './specimens/genesis.mjs';
import type { PageClient } from '../../dist/sdk/client.mjs';

type Peers = PageClient['peers'];

/**
 * Two native SQL devices on the authored-time CRDT through the live host. Device A creates the page: its own key
 * signs the descriptor and genesis membership (naming device B), presented from the owner's signed-in page; the
 * host only verifies and stores it and never signs authority.
 * Concurrent edits are not ordered by a participant: both are accepted locally, and after exchange the
 * deterministic authored-time order revises exactly one outcome. Disconnected authoring converges on reconnect
 * with the original signed operation preserved; there is no recovery, takeover, abandonment or reapply.
 */
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
  const sessions: any[] = [], devices: any[] = [], links: any[] = [];
  const id = handle.application.id, key = new Uint8Array(randomBytes(32)), engine = sqlNative.createNativeSqlEngine();
  try {
    const openDevice = async (name: string, create = false) => {
      const device = await native.openNativeDevice({ path: join(directory, `${name}.sqlite`), create });
      devices.push(device);
      return device;
    };
    const aDevice = await openDevice('a', true), bDevice = await openDevice('b', true);
    const definition = privateIntake ? intake(log, aDevice.identity.publicKey) : checklist(log);
    const executionManifestDigest = log.bytesToHex((await log.executionManifestArtifacts(engine.executionManifest)).executionManifestDigest);
    const signer = await log.createSigningIdentity();
    const prepared = await peers.prepare({ executionManifestDigest, executionProfile: 'sql', publisherKeys: [signer.publicKey],
      tools: log.describeApplication(definition) });
    expect(prepared.selection.id).toBe(id);
    expect(prepared.authority, 'No device has created the page data yet').toBeNull();

    // The owner's signed-in page presents A's genesis: initialization is an owner-account (or root agent) action.
    const metadata = await page.evaluate(async () => (window as any).tendril.host.peers.application());
    expect(metadata.authority).toBeNull();
    const genesis = await signSpecimenGenesis(log, { metadata, identity: aDevice.identity, members: [bDevice.identity.publicKey], key });
    const initialized = await page.evaluate(async value => (window as any).tendril.host.peers.initialize(value),
      { record: Buffer.from(log.encodeRecord(genesis)).toString('hex') });
    expect(initialized.authority).not.toBeNull();
    const bundle = log.decodeRecord(Uint8Array.from(Buffer.from(initialized.authority.record, 'hex')));
    await log.verifyAuthorityBundle(bundle);
    expect(bundle.descriptor.payload.authorityPublicKey, 'The creating device, never the host, signs page authority').toBe(aDevice.identity.publicKey);
    expect(bundle.descriptor.payload.rootPrincipal).toBe(aDevice.identity.publicKey);
    expect(bundle.memberships.at(-1).payload.members.filter((member: { reader: boolean }) => member.reader)
      .map((member: { publicKey: string }) => member.publicKey).sort()).toEqual([aDevice.identity.publicKey, bDevice.identity.publicKey].sort());
    const browserControl = await page.evaluate(async () => (window as any).tendril.host.peers.application());
    expect(JSON.stringify(browserControl)).not.toContain('private answer');

    const open = async (device: any, name: string) => {
      const session = await log.createApplicationSession({ device, definition, authority: bundle, epochKeys: new Map([[0, key]]),
        async createMaterializer({ rootPrincipal }: { rootPrincipal: string }) {
          return sql.createSqlMaterializationRuntime({ engine, path: join(directory, `${name}-data.sqlite`), rootPrincipal });
        } });
      sessions.push(session);
      return session;
    };
    const connect = async (a: any, b: any) => {
      const channel = randomUUID();
      const connected = await Promise.all([[a, b], [b, a]].map(async ([local, remote]) => {
        const relay = peers.relay(channel, local.identity.publicKey, { remotePeerId: remote.identity.publicKey, signal: local.signal });
        const connection = await sockets.openWebSocketConnection(relay, { ready: relay.ready, signal: local.signal });
        const link = await local.connectPeer({ connection, peerIdentity: remote.identity.publicKey });
        links.push(link);
        return link;
      }));
      await Promise.all(connected.map(link => link.synchronize()));
      return connected;
    };
    // Local facts only: the command is stored first, then materialized here (revisable), never waiting for a peer.
    // An operation ID is the author's own request reference; every other peer addresses the replicated operation by
    // its signed proposal ID, so remember the mapping for the cross-device outcome reads below.
    const proposals = new Map<string, string>();
    const run = async (session: any, command: string, input: unknown, operationId: string) => {
      const outcome = await (await session.command(command, input, { operationId })).materialized({ signal: AbortSignal.timeout(12_000) });
      proposals.set(operationId, outcome.proposalId);
      return outcome;
    };
    // A revisable outcome after exchange: poll the local materialized fact, which an earlier-authored operation may revise.
    // Until the operation has replicated here this peer has no record of it yet, which reads as no outcome.
    const outcomeOf = async (session: any, operationId: string) => {
      let outcome = '';
      await expect.poll(async () => {
        const operation = await session.operations.get(proposals.get(operationId) ?? operationId);
        outcome = operation === null ? '' : (await operation.inspect()).materialized?.outcome ?? ''; return outcome;
      }, { timeout: 15_000 }).not.toBe('');
      return outcome;
    };
    const converge = async (pairLinks: any[]) => { await Promise.all(pairLinks.map(link => link.synchronize())); };
    const a = await open(aDevice, 'a'), b = await open(bDevice, 'b');
    // An ordinary authorized DDL/DML transaction by the root creates the tables; peers receive it like any operation.
    expect((await run(a, 'initialize', null, 'initialize')).outcome).toBe('accepted');
    // Crypto membership grants no SQL rights over the group's rows; the root grants them explicitly.
    if (!privateIntake) expect((await run(a, 'grantMember', { publicKey: bDevice.identity.publicKey }, 'grant-member')).outcome).toBe('accepted');
    const first = await connect(a, b);
    if (privateIntake) {
      expect((await run(a, 'submit', { body: 'Initial private answer', revision: 0 }, 'first')).outcome).toBe('accepted');
      await converge(first);
      await expect.poll(async () => JSON.stringify((await b.query('answer', null)).value)).toBe(JSON.stringify([['Initial private answer', 1]]));
      expect((await run(b, 'submit', { body: 'Facilitator cannot alter the answer', revision: 1 }, 'unauthorized')).outcome).toBe('rejected');
      expect((await run(a, 'submit', { body: 'Corrected private answer', revision: 1 }, 'correction')).outcome).toBe('accepted');
      expect((await run(a, 'submit', { body: 'Stale answer', revision: 1 }, 'stale')).outcome).toBe('rejected');
      await converge(first);
      await expect.poll(async () => JSON.stringify((await b.query('answer', null)).value)).toBe(JSON.stringify([['Corrected private answer', 2]]));
      const [count, revision] = (await b.query('summary', null)).value;
      return { count, revision };
    }
    expect((await run(a, 'add', { id: 1, title: 'Retained task' }, 'retained')).outcome).toBe('accepted');
    await converge(first);
    await expect.poll(async () => JSON.stringify((await b.query('tasks', null)).value)).toBe(JSON.stringify([[1, 'Retained task']]));
    expect((await run(b, 'add', { id: 2, title: 'Retained task' }, 'duplicate')).outcome).toBe('rejected');
    // Concurrent claims are both accepted locally; the deterministic authored-time order then revises exactly one.
    await Promise.all([run(a, 'claim', 1, 'claim-a'), run(b, 'claim', 1, 'claim-b')]);
    await converge(first);
    await expect.poll(async () => (await Promise.all([a, b].flatMap(session => ['claim-a', 'claim-b'].map(operation => outcomeOf(session, operation))))).join(','))
      .toMatch(/^(accepted,rejected,accepted,rejected|rejected,accepted,rejected,accepted)$/);
    const claims = await Promise.all(['claim-a', 'claim-b'].map(operation => outcomeOf(a, operation)));
    expect([...claims].sort()).toEqual(['accepted', 'rejected']);
    const [winner, loser] = claims[0] === 'accepted' ? [a, b] : [b, a];
    expect((await run(loser, 'finish', 1, 'wrong-user-finish')).outcome).toBe('rejected');
    expect((await run(winner, 'finish', 1, 'finish-by-claimant')).outcome).toBe('accepted');
    await converge(first);
    await expect.poll(async () => JSON.stringify((await b.query('assignment', 1)).value)).toBe(JSON.stringify([winner.identity.publicKey, 1]));
    const slot = 'Workshop bench · 15:00';
    await Promise.all([run(a, 'reserve', slot, 'reserve-a'), run(b, 'reserve', slot, 'reserve-b')]);
    await converge(first);
    const bookings = await Promise.all(['reserve-a', 'reserve-b'].map(operation => outcomeOf(a, operation)));
    await expect.poll(async () => (await Promise.all(['reserve-a', 'reserve-b'].map(operation => outcomeOf(b, operation)))).join(',')).toBe(bookings.join(','));
    expect([...bookings].sort()).toEqual(['accepted', 'rejected']);
    const [holder, waiting] = bookings[0] === 'accepted' ? [a, b] : [b, a];
    expect((await run(waiting, 'cancel', slot, 'not-holder')).outcome).toBe('rejected');
    expect((await run(holder, 'cancel', slot, 'release-slot')).outcome).toBe('accepted');
    // Booking after the release is a guarded insert on the waiting device's own view: it must have received the release.
    await converge(first);
    await expect.poll(async () => JSON.stringify((await waiting.query('reservations', null)).value)).toBe('[]');
    expect((await run(waiting, 'reserve', slot, 'book-after-release')).outcome).toBe('accepted');
    await converge(first);
    await expect.poll(async () => JSON.stringify((await b.query('reservations', null)).value)).toBe(JSON.stringify([[slot, waiting.identity.publicKey]]));
    await Promise.all(first.map(link => link.close()));
    // While disconnected, each device authors independently and keeps its own operation unchanged.
    const offline = await (await a.command('add', { id: 4, title: 'Local edit before loss' }, { operationId: 'offline-tail' }));
    expect((await offline.materialized({ signal: AbortSignal.timeout(12_000) })).outcome).toBe('accepted');
    const original = offline.inspect();
    expect((await run(b, 'add', { id: 3, title: 'Concurrent task' }, 'concurrent-b')).outcome).toBe('accepted');
    expect((await b.query('tasks', null)).value).toEqual([[1, 'Retained task'], [3, 'Concurrent task']]);
    const reconnected = await connect(a, b);
    await converge(reconnected);
    const everything = [[1, 'Retained task'], [3, 'Concurrent task'], [4, 'Local edit before loss']];
    for (const session of [a, b]) await expect.poll(async () => JSON.stringify((await session.query('tasks', null)).value)).toBe(JSON.stringify(everything));
    const after = (await a.operations.get('offline-tail')).inspect();
    expect(after.proposalId, 'convergence never resubmits or retimestamps the original signed operation').toBe(original.proposalId);
    expect(after.authorTimestampMs).toBe(original.authorTimestampMs);
    expect(after.materialized.outcome).toBe('accepted');
    await Promise.all(reconnected.map(link => link.close()));
    await b.close();
    const reopened = await open(await openDevice('b'), 'b');
    expect(reopened.identity.publicKey).toBe(bDevice.identity.publicKey);
    expect((await reopened.query('tasks', null)).value).toEqual(everything);
    expect((await (await reopened.operations.get('concurrent-b')).inspect()).materialized.outcome).toBe('accepted');
    expect((await reopened.query('assignment', 1)).value).toEqual([winner.identity.publicKey, 1]);
  } finally {
    await Promise.allSettled(links.map(link => link.close()));
    await Promise.allSettled(sessions.map(session => session.close()));
    await Promise.allSettled(devices.map(device => device.close()));
    await rm(directory, { recursive: true, force: true });
  }
}
