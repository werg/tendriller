import { expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { api, create, inDO, req, type Handle } from './helpers';
import type { HostApproval } from '../src/host-adoption';

const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
const delegation = 'action=delegate-agent&name=retained-native&scopes=host%3Aread&scopes=participants%3Aconnect';

async function issue(h: Handle, body = delegation) {
  const response = await req(h.page_url + '_tendril/manage', { method: 'POST', headers: formHeaders, body });
  expect(response.status).toBe(200);
  return new RegExp(h.id + '-[0-9]{6}').exec(await response.text())![0];
}
function redeem(code: string, origin = 'https://tendriller.dev') {
  // The server must honor the stored review even when the caller supplies no
  // optional application/mode assertions and no owner browser session.
  return req(origin + '/api/adopt', { anonymous: true, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }) });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

for (const action of ['delegate-agent', 'connect-agent']) {
  it(`rejects ${action} when its owner session is revoked during a delayed form`, async () => {
    const h = await create();
    const restore = await inDO(h.id, t => {
      const originalFetch = t.fetch, originalAccess = t.recordAccess;
      t.fetch = async request => {
        // Cloudflare streams belong to their request's DO context. Delay the
        // forwarded form here, retaining the actual Worker and page auth route.
        const form = new TextDecoder().decode(await request.arrayBuffer()), authorized = deferred();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } }, { highWaterMark: 0 });
        t.recordAccess = () => { originalAccess.call(t); authorized.resolve(); };
        const pending = originalFetch.call(t, new Request(request, { body }));
        try {
          // recordAccess is after the page route's first authorization. A
          // stream pull alone would not establish that ordering.
          await Promise.race([authorized.promise, pending.then(() => { throw new Error('Page returned before reading the held form'); })]);
          t.db.run('DELETE FROM page_sessions');
          controller.enqueue(new TextEncoder().encode(form));
          controller.close();
          return await pending;
        } finally {
          t.recordAccess = originalAccess;
          try { controller.close(); } catch { /* Already closed. */ }
        }
      };
      return () => { t.fetch = originalFetch; t.recordAccess = originalAccess; };
    });
    try {
      const response = await req(h.page_url + '_tendril/manage', { method: 'POST', headers: formHeaders,
        body: action === 'delegate-agent' ? delegation : 'action=connect-agent' });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
      expect(await inDO(h.id, t => t.db.get('adopt', null))).toBeNull();
      expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM tokens'))).toEqual({ n: 1 });
    } finally { await inDO(h.id, restore); }
  });

  it(`rejects ${action} when hashing yields to owner-session revocation`, async () => {
    const h = await create();
    const revoke = await inDO(h.id, t => () => { t.db.run('DELETE FROM page_sessions'); });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let revoked = false;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const result = await digest(algorithm, data);
      if (new TextDecoder().decode(data).startsWith(h.id + '-')) { revoked = true; revoke(); }
      return result;
    });
    try {
      const response = await req(h.page_url + '_tendril/manage', { method: 'POST', headers: formHeaders,
        body: action === 'delegate-agent' ? delegation : 'action=connect-agent' });
      expect(revoked).toBe(true);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
      expect(await inDO(h.id, t => t.db.get('adopt', null))).toBeNull();
    } finally { spy.mockRestore(); }
  });
}

it('checks current account and write policy after approval hashing', async () => {
  for (const reason of ['read_only', 'suspended'] as const) {
    const h = await create();
    const restore = await inDO(h.id, t => {
      const database = t.env.ACCOUNTS; let changed = false;
      t.env.ACCOUNTS = new Proxy(database, { get(target, key) {
        if (key !== 'prepare') { const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; }
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes('FROM service_state s')) return statement;
          return { bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return { async first() {
              if (!changed) {
                changed = true;
                if (reason === 'read_only') await database.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
                else await database.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(t.now(), t.db.get('owner_account', '')).run();
              }
              return bound.first();
            } };
          } };
        };
      } });
      return () => { t.env.ACCOUNTS = database; };
    });
    try {
      const response = await req(h.page_url + '_tendril/manage', { method: 'POST', headers: formHeaders, body: delegation });
      expect(response.status, reason).toBe(reason === 'read_only' ? 503 : 403);
      expect(await response.json()).toMatchObject({ error: { code: reason === 'read_only' ? 'read_only' : 'disabled' } });
      expect(await inDO(h.id, t => t.db.get('adopt', null))).toBeNull();
    } finally {
      await inDO(h.id, restore);
      await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run();
    }
  }
});

it('retains the reviewed owner and application while allowing redemption after ordinary logout', async () => {
  const h = await create(), code = await issue(h);
  const binding = await inDO(h.id, t => {
    const approval = t.db.get<HostApproval>('adopt', {} as HostApproval);
    expect(approval).toMatchObject({ schemaVersion: 1, service_origin: 'https://tendriller.dev', page_id: h.id,
      application_id: h.application.id, owner_account: t.db.get('owner_account', ''), owner_claimed_at: t.db.get('claimed_at', 0),
      mode: 'delegate', name: 'retained-native', scopes: ['host:read', 'participants:connect'] });
    t.db.run('DELETE FROM page_sessions');
    return approval;
  });
  await env.ACCOUNTS.prepare('DELETE FROM sessions WHERE account_id=?').bind(binding.owner_account).run();
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='creation_paused' WHERE id=1").run();
  try {
    const response = await redeem(code);
    expect(response.status).toBe(200);
    const added = await response.json() as Handle;
    expect(added.application.id).toBe(h.application.id);
    expect((await api(h, 'GET', 'self')).status).toBe(200);
    expect((await api(added, 'GET', 'self')).status).toBe(200);
    expect(await inDO(h.id, t => t.db.get('agent_binding:retained-native', null)))
      .toMatchObject({ scopes: binding.scopes });
    expect(await inDO(h.id, t => t.db.get('adopt', null))).toBeNull();
  } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
});

it('refuses a retained code after its reviewed owner, claim incarnation, application or service changes', async () => {
  for (const reason of ['owner', 'claim', 'application', 'service'] as const) {
    const h = await create(), code = await issue(h);
    const approval = await inDO(h.id, t => t.db.get('adopt', null));
    const restore = await inDO(h.id, async t => {
      const oldOrigin = t.env.PUBLIC_BASE;
      if (reason === 'owner') {
        const replacement = crypto.randomUUID();
        await t.env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)')
          .bind(replacement, t.now(), `${replacement}@example.test`).run();
        await t.env.ACCOUNTS.prepare('UPDATE tendrils SET owner_account=? WHERE id=?').bind(replacement, h.id).run();
        t.db.set('owner_account', replacement);
      } else if (reason === 'claim') t.db.set('claimed_at', t.db.get<number>('claimed_at', 0) + 1);
      else if (reason === 'application') t.db.set('application', { ...t.db.get<object>('application', {}), id: 'f'.repeat(64) });
      else t.env.PUBLIC_BASE = 'https://other.example';
      return () => { t.env.PUBLIC_BASE = oldOrigin; };
    });
    try {
      const response = await redeem(code, reason === 'service' ? 'https://other.example' : undefined);
      expect(response.status, reason).toBe(reason === 'owner' || reason === 'claim' ? 403 : 409);
      expect(await response.json()).toMatchObject({ error: { code: reason === 'owner' || reason === 'claim'
        ? 'adoption_owner_changed' : reason === 'application' ? 'adoption_application_mismatch' : 'adoption_review_required' } });
      expect(await inDO(h.id, t => t.db.get('adopt', null))).toEqual(approval);
      expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM tokens'))).toEqual({ n: 1 });
    } finally { await inDO(h.id, restore); }
  }
});

it('requires new owner review for unbound legacy codes and incomplete delegated scopes', async () => {
  for (const reason of ['unbound', 'missing_scopes'] as const) {
    const h = await create(), code = await issue(h);
    const before = await inDO(h.id, t => {
      const approval = t.db.get<HostApproval>('adopt', {} as HostApproval);
      const retained = reason === 'unbound' ? { hash: approval.hash, expires_at: approval.expires_at, attempts: 0,
        mode: approval.mode, name: approval.name, scopes: approval.scopes } : { ...approval, scopes: undefined };
      t.db.set('adopt', retained);
      return t.db.get('adopt', null);
    });
    const response = await redeem(code);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'adoption_review_required' } });
    expect(await inDO(h.id, t => t.db.get('adopt', null))).toEqual(before);
    expect(await inDO(h.id, t => t.db.one('SELECT COUNT(*) AS n FROM tokens'))).toEqual({ n: 1 });
  }
});
