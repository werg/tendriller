import { evictDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { bytesDigest, createPeerIdentity, participantGrant, signPublicationManifest,
  type AuthorityBundle, type SignedPublication } from '@chronolog/peer-generation/control';
import { advance, create, inDO, req, stub, type Handle } from './helpers';
import { peerApiJson } from './peer-exchange';
import { PUBLICATION_WATCH_PROTOCOL } from '../src/publication-watch';
import type { Tendril } from '../src/tendril';

const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': PUBLICATION_WATCH_PROTOCOL };
const endpoint = (h: Handle) => h.page_url + '_tendril/publication-ready';
async function subscribe(h: Handle) {
  const response = await req(endpoint(h), { headers });
  expect(response.status).toBe(101);
  expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(PUBLICATION_WATCH_PROTOCOL);
  const socket = response.webSocket!, messages: unknown[] = [];
  socket.addEventListener('message', event => { messages.push(JSON.parse(event.data as string)); });
  socket.accept();
  await expect.poll(() => messages.length).toBe(1);
  return { socket, messages };
}
const notice = (current: number) => ({ type: 'publication', version: 1, current });
const select = (h: Handle, current: number) => inDO(h.id, t => t.transaction(() => t.db.set('current', current)));

/** Pause one real policy result; retain actual D1, SQL and post-commit delivery. */
async function withPausedPolicy(t: Tendril, change: () => void | Promise<void>) {
  const database = t.env.ACCOUNTS, afterCommit = t.afterCommit, effects: Promise<unknown>[] = [];
  let entered!: () => void, release!: () => void, held = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const statement = (value: D1PreparedStatement, policy: boolean): D1PreparedStatement => new Proxy(value, {
    get(target, key) {
      if (key === 'bind') return (...args: unknown[]) => statement(target.bind(...args), policy);
      if (key === 'first' && policy) return async (...args: Parameters<D1PreparedStatement['first']>) => {
        const result = await target.first(...args);
        if (!held) { held = true; entered(); await gate; }
        return result;
      };
      const result = Reflect.get(target, key, target);
      return typeof result === 'function' ? result.bind(target) : result;
    },
  });
  t.env.ACCOUNTS = new Proxy(database, { get(target, key) {
    if (key === 'prepare') return (sql: string) => statement(target.prepare(sql), sql.includes('AS visitor_active'));
    const result = Reflect.get(target, key, target);
    return typeof result === 'function' ? result.bind(target) : result;
  } });
  // Observe completion without replacing the production commit/rollback boundary.
  t.afterCommit = effect => afterCommit.call(t, () => {
    const result = effect(); effects.push(Promise.resolve(result)); return result;
  });
  try {
    t.transaction(() => t.db.set('current', 2));
    await started;
    await change();
    await Promise.all(effects.slice(1));
    release();
    await Promise.all(effects);
  } finally { release(); t.env.ACCOUNTS = database; t.afterCommit = afterCommit; }
}

async function publisher(h: Handle) {
  const author = await createPeerIdentity();
  const authority = await peerApiJson<AuthorityBundle>(h, 'control/configure', {
    historyId: 'watch-history', executionManifestDigest: '12'.repeat(32),
    definition: { id: 'publication-watch', version: '1', schema: null, commands: [], queries: [] },
    schemaAdministrator: author.publicKey, epoch: 0, keyDigest: '34'.repeat(32),
    members: [{ grant: participantGrant(author.publicKey, { administrator: true, publisher: true }) }],
  });
  let previous: SignedPublication | null = null;
  return async (text: string) => {
    const data = new TextEncoder().encode(`<main>${text}</main>`), hash = await bytesDigest(data);
    const descriptor = authority.descriptor.payload;
    const publication = await signPublicationManifest({ applicationId: descriptor.applicationId,
      historyId: descriptor.historyId, profile: descriptor.profile, controlRevision: authority.controls.at(-1)!.payload.revision,
      author: author.publicKey, operationId: text, revision: previous ? previous.payload.revision + 1 : 0,
      previous: previous?.id ?? null, definitionDigest: descriptor.definitionDigest,
      executionManifestDigest: descriptor.executionManifestDigest, entry: 'index.html',
      files: [{ path: 'index.html', type: 'text/html', hash, size: data.length }] }, author);
    const result = await peerApiJson(h, 'publication/publish', { publication,
      assets: [{ hash, bytes: btoa(String.fromCharCode(...data)) }] });
    previous = publication;
    return result;
  };
}

it('pushes actual signed publications and rollback selections through a hibernated socket, with reconnect replay', async () => {
  const h = await create({ listener: false }), publish = await publisher(h), watch = await subscribe(h);
  let replay: Awaited<ReturnType<typeof subscribe>> | undefined;
  try {
    expect(watch.messages).toEqual([notice(0)]);
    const before = await inDO(h.id, async t => ({ alarm: await t.ctx.storage.getAlarm(),
      changes: t.db.one('SELECT total_changes() AS n') }));
    await advance(h.id, 48 * 3600_000);
    expect(await inDO(h.id, async t => ({ alarm: await t.ctx.storage.getAlarm(),
      changes: t.db.one('SELECT total_changes() AS n') }))).toEqual(before);
    // Restore the test clock before the authenticated page session expires.
    await advance(h.id, -48 * 3600_000);
    await evictDurableObject(stub(h.id));
    await publish('first');
    await expect.poll(() => watch.messages).toEqual([notice(0), notice(1)]);
    await publish('second');
    await expect.poll(() => watch.messages).toEqual([notice(0), notice(1), notice(2)]);
    await select(h, 1);
    await expect.poll(() => watch.messages).toEqual([notice(0), notice(1), notice(2), notice(1)]);
    replay = await subscribe(h);
    expect(replay.messages).toEqual([notice(1)]);
    await inDO(h.id, t => t.transaction(() => t.db.del('current')));
    await expect.poll(() => watch.messages).toEqual([notice(0), notice(1), notice(2), notice(1), notice(0)]);
    await expect.poll(() => replay!.messages).toEqual([notice(1), notice(0)]);
    const head = await req(endpoint(h), { method: 'HEAD' });
    expect(head.status).toBe(202); expect(head.headers.get('Tendril-Publication-Version')).toBe('0');
  } finally { watch.socket.close(); replay?.socket.close(); }
});

it('suppresses rolled-back and duplicate selections, including nested transaction rollback', async () => {
  const h = await create({ listener: false }), watch = await subscribe(h);
  try {
    await inDO(h.id, t => {
      expect(() => t.transaction(() => {
        t.transaction(() => t.db.set('current', 7));
        throw Error('outer rollback');
      })).toThrow('outer rollback');
      expect(t.db.get('current', 0)).toBe(0);
      t.transaction(() => {
        expect(() => t.transaction(() => { t.db.set('current', 8); throw Error('inner rollback'); })).toThrow('inner rollback');
        t.db.set('current', 1);
      });
    });
    await expect.poll(() => watch.messages).toEqual([notice(0), notice(1)]);
    await select(h, 1);
    await select(h, 2);
    await expect.poll(() => watch.messages).toEqual([notice(0), notice(1), notice(2)]);
  } finally { watch.socket.close(); }
});

it('requires page authentication, exact origin and protocol; caps subscriptions at 32', async () => {
  const h = await create({ listener: false }), watches: Awaited<ReturnType<typeof subscribe>>[] = [];
  try {
    expect((await req(endpoint(h), { headers, anonymous: true })).status).not.toBe(101);
    expect((await req(endpoint(h), { headers: { ...headers, Origin: 'https://hostile.tendriller.site' } })).status).toBe(403);
    expect((await req(endpoint(h), { headers: { Upgrade: 'websocket' } })).status).toBe(400);
    for (let i = 0; i < 32; i++) watches.push(await subscribe(h));
    expect((await req(endpoint(h), { headers })).status).toBe(429);
    const closed = new Promise<number>(resolve => watches[0].socket.addEventListener('close', event => resolve(event.code), { once: true }));
    watches[0].socket.send('{}');
    expect(await closed).toBe(1008);
    watches.push(await subscribe(h));
  } finally { for (const watch of watches) watch.socket.close(); }
});

it.each(['session', 'link', 'expiry', 'held'] as const)('rechecks %s revocation before publishing another selection after hibernation', async reason => {
  const h = await create({ listener: false }), watch = await subscribe(h);
  try {
    await evictDurableObject(stub(h.id));
    const closed = new Promise<number>(resolve => watch.socket.addEventListener('close', event => resolve(event.code), { once: true }));
    await inDO(h.id, t => t.transaction(() => {
      if (reason === 'session') t.db.run('DELETE FROM page_sessions');
      if (reason === 'link') t.db.run('DELETE FROM links');
      if (reason === 'expiry') t.db.run('UPDATE page_sessions SET expires_at = ?', t.now() - 1);
      if (reason === 'held') t.db.set('disabled', true);
      t.db.set('current', 1);
    }));
    expect(await closed).toBe(4003);
    expect(watch.messages).toEqual([notice(0)]);
  } finally { watch.socket.close(); }
});

it.each([1, 0])('does not replay paused selection 2 after selection changes to %s during policy authorization', async current => {
  const h = await create({ listener: false }), watch = await subscribe(h);
  try {
    await inDO(h.id, t => withPausedPolicy(t, () => { t.transaction(() => t.db.set('current', current)); }));
    // A nonzero final notice is an observed delivery barrier. Selection zero
    // equals the initial snapshot and must suppress both the newer and held sends.
    if (current) await expect.poll(() => watch.messages).toEqual([notice(0), notice(current)]);
    await select(h, 3);
    await expect.poll(() => watch.messages).toEqual(current
      ? [notice(0), notice(current), notice(3)] : [notice(0), notice(3)]);
  } finally { watch.socket.close(); }
});

it('revokes a session while its policy read is paused and delivers no post-revocation selection', async () => {
  const h = await create({ listener: false }), watch = await subscribe(h);
  try {
    const closed = new Promise<number>(resolve => watch.socket.addEventListener('close', event => resolve(event.code), { once: true }));
    await inDO(h.id, t => withPausedPolicy(t, () => { t.db.run('DELETE FROM page_sessions'); }));
    expect(await closed).toBe(4003);
    expect(watch.messages).toEqual([notice(0)]);
  } finally { watch.socket.close(); }
});
