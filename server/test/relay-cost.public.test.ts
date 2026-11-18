import { expect, it } from 'vitest';
import { evictDurableObject } from 'cloudflare:test';
import { createPeerRelay, PEER_RELAY_LIMITS } from '../../contract/peers.mjs';
import { currentPrincipal, type Principal } from '../src/access';
import { Db } from '../src/db';
import { advance, inDO, stub } from './helpers';
import { createTestPage } from './public-fixture';

const left = 'ab'.repeat(32), right = 'cd'.repeat(32);
type RemoteRole = 'agent' | 'owner' | 'guest';

async function pair(role: RemoteRole = 'guest') {
  const page = await createTestPage();
  const { id } = await (await page.api('GET', '')).json() as { id: string };
  const remote = role === 'guest' ? (await page.participant()).relaySocket
    : role === 'owner' ? page.ownerRelaySocket : page.relaySocket;
  const open = (socket: typeof page.relaySocket, peerId: string, remotePeerId: string) => createPeerRelay({
    reliable: socket('read-cost', peerId, remotePeerId, 'reliable'),
    live: socket('read-cost', peerId, remotePeerId, 'live'),
  }, { peerId, remotePeerId });
  const a = open(page.relaySocket, left, right), b = open(remote, right, left);
  const received = { a: 0, b: 0 };
  a.reliable.addEventListener('message', () => { received.a++; });
  b.reliable.addEventListener('message', () => { received.b++; });
  await Promise.all([a.ready, b.ready]);
  return { id, a, b, received,
    async exchange(count = 1) {
      const expected = { a: received.a + count, b: received.b + count };
      for (let i = 0; i < count; i++) { a.reliable.send(new Uint8Array([i])); b.reliable.send(new Uint8Array([i])); }
      await expect.poll(() => received).toEqual(expected);
      await expect.poll(() => a.reliable.bufferedAmount + b.reliable.bufferedAmount).toBe(0);
    },
    close() { a.close(); b.close(); },
  };
}

/** Count the actual SQLite cursor work without replacing the storage engine. */
async function meter(id: string) {
  const counts = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  let restore!: () => void;
  await inDO(id, t => {
    const original = t.db;
    const sql = new Proxy(t.ctx.storage.sql, { get(target, key) {
      if (key !== 'exec') return Reflect.get(target, key, target);
      return (query: string, ...bindings: unknown[]) => {
        counts.queries++;
        const cursor = target.exec(query, ...bindings);
        return new Proxy(cursor, { get(value, field) {
          if (field === 'toArray') return () => {
            try { return value.toArray(); }
            finally { counts.rowsRead += value.rowsRead; counts.rowsWritten += value.rowsWritten; }
          };
          return Reflect.get(value, field, value);
        } });
      };
    } });
    t.db = new Db({ sql, transactionSync: write => t.ctx.storage.transactionSync(write) });
    restore = () => { original.clearCache(); t.db = original; };
  });
  return { counts, reset() { counts.queries = counts.rowsRead = counts.rowsWritten = 0; },
    async close() { await inDO(id, restore); } };
}

it.each(['agent', 'owner', 'guest'] as const)('forwards a warm %s relay burst and receipts without SQLite reads or writes', async role => {
  const p = await pair(role), sql = await meter(p.id);
  try {
    await p.exchange();
    expect(sql.counts.queries).toBeGreaterThan(0);
    expect(sql.counts.rowsRead).toBeGreaterThan(0);
    expect(sql.counts.rowsWritten).toBe(0);
    sql.reset();
    // 32 delivered application packets plus their 32 recipient receipts.
    await p.exchange(16);
    expect(sql.counts).toEqual({ queries: 0, rowsRead: 0, rowsWritten: 0 });
  } finally { await sql.close(); p.close(); }
});

it.each(['token', 'link', 'session', 'guest approval', 'disabled', 'owner'] as const)(
  'invalidates warm relay authorization immediately after a local %s change', async reason => {
    const p = await pair(reason === 'owner' ? 'owner' : 'guest');
    try {
      await p.exchange();
      await inDO(p.id, t => {
        if (reason === 'token') t.db.run('DELETE FROM tokens');
        if (reason === 'link') t.db.all("DELETE FROM links WHERE role='guest' RETURNING id");
        if (reason === 'session') t.db.one("DELETE FROM page_sessions WHERE role='guest' RETURNING hash");
        if (reason === 'guest approval') t.db.run('UPDATE guest_accounts SET approved=0');
        if (reason === 'disabled') t.db.run("INSERT INTO meta(k,v) VALUES('disabled','true') ON CONFLICT(k) DO UPDATE SET v=excluded.v");
        if (reason === 'owner') t.db.one("UPDATE meta SET v='\"another-account\"' WHERE k='owner_account' RETURNING k");
      });
      p.a.reliable.send(new Uint8Array([1]));
      await expect.poll(() => p.a.signal.aborted && p.b.signal.aborted).toBe(true);
      expect(p.received).toEqual({ a: 1, b: 1 });
    } finally { p.close(); }
  },
);

it.each(['session', 'link', 'account admission'] as const)('checks %s expiry on each packet even with warm local rows', async reason => {
  const p = await pair();
  try {
    await inDO(p.id, t => {
      if (reason === 'session') t.db.run("UPDATE page_sessions SET expires_at=? WHERE role='guest'", t.now() + 10_000);
      if (reason === 'link') t.db.run("UPDATE links SET expires_at=? WHERE role='guest'", t.now() + 10_000);
    });
    await p.exchange();
    await advance(p.id, reason === 'account admission' ? PEER_RELAY_LIMITS.authorizationMs + 1 : 10_001);
    // No SQL mutation or policy-refresh alarm occurs between warming and expiry.
    p.a.reliable.send(new Uint8Array([1]));
    await expect.poll(() => p.a.signal.aborted && p.b.signal.aborted).toBe(true);
    expect(p.received).toEqual({ a: 1, b: 1 });
  } finally { p.close(); }
});

it('drops both positive and negative local authorization snapshots on transaction rollback', async () => {
  const p = await pair();
  try {
    await p.exchange();
    await inDO(p.id, t => {
      const guest = t.ctx.getWebSockets('peer-relay').map(ws => ws.deserializeAttachment().principal as Principal)
        .find(principal => principal.kind === 'page')!;
      expect(currentPrincipal(t, guest)).not.toBeNull();
      expect(() => t.transaction(() => {
        t.db.run('DELETE FROM guest_accounts');
        expect(currentPrincipal(t, guest)).toBeNull();
        throw new Error('roll back revocation');
      })).toThrow('roll back revocation');
      expect(currentPrincipal(t, guest)).not.toBeNull();
      const temporary: Principal = { kind: 'agent', name: 'temporary', credentialHash: '12'.repeat(32) };
      expect(currentPrincipal(t, temporary)).toBeNull();
      expect(() => t.transaction(() => {
        t.db.run('INSERT INTO tokens(name,hash,created_at) VALUES(?,?,?)', temporary.name, temporary.credentialHash, t.now());
        expect(currentPrincipal(t, temporary)).not.toBeNull();
        throw new Error('roll back grant');
      })).toThrow('roll back grant');
      expect(currentPrincipal(t, temporary)).toBeNull();
    });
    await p.exchange();
  } finally { p.close(); }
});

it('rebuilds local authorization after WebSocket hibernation and still honors subsequent revocation', async () => {
  const p = await pair();
  try {
    await p.exchange();
    await evictDurableObject(stub(p.id));
    await p.exchange();
    await inDO(p.id, t => t.db.run('DELETE FROM guest_accounts'));
    p.a.reliable.send(new Uint8Array([1]));
    await expect.poll(() => p.a.signal.aborted && p.b.signal.aborted).toBe(true);
    expect(p.received).toEqual({ a: 2, b: 2 });
  } finally { p.close(); }
});

it('memoizes absent metadata without retaining caller defaults or raw SQL mutations', async () => {
  const page = await createTestPage();
  const { id } = await (await page.api('GET', '')).json() as { id: string };
  await inDO(id, t => {
    expect(t.db.get('cost-cache-test', false)).toBe(false);
    expect(t.db.get('cost-cache-test', 'different default')).toBe('different default');
    t.db.run("INSERT INTO meta(k,v) VALUES('cost-cache-test','1')");
    expect(t.db.get('cost-cache-test', 0)).toBe(1);
    t.db.all("UPDATE meta SET v='2' WHERE k='cost-cache-test' RETURNING k");
    expect(t.db.get('cost-cache-test', 0)).toBe(2);
    t.db.one("DELETE FROM meta WHERE k='cost-cache-test' RETURNING k");
    expect(t.db.get('cost-cache-test', false)).toBe(false);
  });
});

it('bounds distinct metadata misses while retaining recent defaults and current SQL values', async () => {
  const page = await createTestPage();
  const { id } = await (await page.api('GET', '')).json() as { id: string };
  await inDO(id, t => {
    let reads = 0;
    const sql = new Proxy(t.ctx.storage.sql, { get(target, name) {
      if (name !== 'exec') return Reflect.get(target, name, target);
      return (query: string, ...bindings: (string | number | null | ArrayBuffer)[]) => {
        if (query.startsWith('SELECT v FROM meta')) reads++;
        return target.exec(query, ...bindings);
      };
    } });
    const db = new Db({ sql, transactionSync: write => t.ctx.storage.transactionSync(write) });
    const key = (n: number) => `peer_publication_record:${n.toString(16).padStart(64, '0')}`;
    for (let i = 0; i < 512; i++) expect(db.get(key(i), null)).toBeNull();
    expect(reads).toBe(512);
    // Old misses are evicted instead of accumulating; recent misses avoid SQL
    // while still returning each caller's own default.
    expect(db.get(key(0), 'another default')).toBe('another default');
    expect(reads).toBe(513);
    expect(db.get(key(511), false)).toBe(false);
    expect(reads).toBe(513);
    db.run('INSERT INTO meta(k,v) VALUES(?,?)', key(511), '7');
    expect(db.get(key(511), 0)).toBe(7);
    db.one('DELETE FROM meta WHERE k=? RETURNING k', key(511));
    expect(db.get(key(511), 'after deletion')).toBe('after deletion');
  });
});
