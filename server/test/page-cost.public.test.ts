import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { errorResponse } from '../src/http';
import { sha256Hex } from '../src/ids';
import { PAGE_ACCESS_HEADER } from '../src/page';
import { route } from '../src/router';
import runtimeRelease from '../src/runtime-release.json';
import { pageUrl } from '../src/urls';
import { create, inDO, ownerHeaders } from './helpers';

/** Count actual Worker -> DO requests while retaining the real object implementation. */
function countedRouter(reply?: (request: Request) => Response) {
  const calls: string[] = [];
  const config: Env = { ...env, TENDRIL: {
    idFromName: (name: string) => env.TENDRIL.idFromName(name),
    get: (id: DurableObjectId) => ({ fetch: (request: Request) => {
      calls.push(new URL(request.url).pathname);
      return reply ? Promise.resolve(reply(request)) : env.TENDRIL.get(id).fetch(request);
    } }),
  } as unknown as DurableObjectNamespace };
  return { calls, fetch: (url: string, init?: RequestInit) => route(new Request(url, init), config) };
}

const runtimePath = `_tendril/runtime/${runtimeRelease.id}/tendril.js`;
const unknownPage = pageUrl(env, 'abcdefghijkl', 'a'.repeat(26));

describe('page request cost and admission', () => {
  it('serves page documents and APIs with one object request and preserves endpoint errors', async () => {
    const h = await create();
    const router = countedRouter();
    for (const [path, status] of [['', 200], ['_tendril/application', 200], ['missing.js', 404], ['_tendril/missing', 404]] as const) {
      router.calls.length = 0;
      const response = await router.fetch(h.page_url + path, { headers: ownerHeaders(h.page_url) });
      expect(response.status, path).toBe(status);
      expect(response.headers.has(PAGE_ACCESS_HEADER)).toBe(false);
      expect(response.headers.has('Location')).toBe(false);
      await response.text();
      expect(router.calls, path).toEqual(['/page']);
    }
  });

  it('serves already-public runtime and brand bytes without any object call', async () => {
    const router = countedRouter();
    for (const url of [unknownPage + runtimePath, unknownPage + '_tendril/brand/icon-64.png',
      new URL('/' + runtimePath, unknownPage).href, new URL('/_tendril/brand/icon-64.png', unknownPage).href]) {
      const response = await router.fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('Strict-Transport-Security')).toContain('includeSubDomains');
      await response.arrayBuffer();
    }
    const head = await router.fetch(unknownPage + runtimePath, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(router.calls).toEqual([]);
  });

  it('still rejects invalid page hosts and non-page paths before serving public assets', async () => {
    const router = countedRouter();
    for (const url of [
      unknownPage.replace('abcdefghijkl.', 'not-a-page.') + runtimePath,
      unknownPage.replace('abcdefghijkl.', 'nested.abcdefghijkl.') + runtimePath,
      unknownPage.replace('tendriller.site', 'tendriller.site.example.com') + runtimePath,
      new URL('/_tendril/sw.js', unknownPage).href,
    ]) {
      expect((await router.fetch(url)).status).toBe(404);
    }
    expect(router.calls).toEqual([]);
  });

  it('retains sign-in redirects and mutation denial without trusting client admission headers', async () => {
    const h = await create();
    const router = countedRouter();
    const forged = { [PAGE_ACCESS_HEADER]: 'allowed', 'x-tendril-key': 'a'.repeat(26), Origin: new URL(h.page_url).origin };
    for (const method of ['GET', 'HEAD', 'POST']) {
      router.calls.length = 0;
      const response = await router.fetch(h.page_url + '_tendril/application', { method, headers: forged });
      expect(response.status).toBe(method === 'POST' ? 401 : 302);
      expect(response.headers.has(PAGE_ACCESS_HEADER)).toBe(false);
      if (method !== 'POST') expect(response.headers.get('Location')).toContain('/auth/page?tendril=' + h.id);
      expect(router.calls).toEqual(['/page']);
      await response.text();
    }
    const missing = await router.fetch(unknownPage);
    expect(missing.status).toBe(302);
    expect(missing.headers.has(PAGE_ACCESS_HEADER)).toBe(false);
  });

  it.each(['session revoked', 'session expired', 'link revoked'])(
    'still denies private publications immediately when %s', async reason => {
      const h = await create();
      await inDO(h.id, t => {
        if (reason === 'session revoked') t.db.run('DELETE FROM page_sessions');
        if (reason === 'session expired') t.db.run('UPDATE page_sessions SET expires_at=?', t.now());
        if (reason === 'link revoked') t.db.run("DELETE FROM links WHERE id='l_main'");
      });
      const router = countedRouter();
      const response = await router.fetch(h.page_url + '_publications/1/private.mjs', { headers: ownerHeaders(h.page_url) });
      expect(response.status).toBe(302);
      expect(response.headers.has(PAGE_ACCESS_HEADER)).toBe(false);
      expect(router.calls).toEqual(['/page']);
    },
  );

  it('refreshes ad-hoc expiry only after successful page admission', async () => {
    const h = await create();
    const before = await inDO(h.id, t => {
      t.db.set('last_access', t.now());
      const saved = t.db.get('last_access', 0);
      t.skew += 60_000;
      return saved;
    });
    const router = countedRouter();
    const anonymous = await router.fetch(h.page_url);
    expect(anonymous.status).toBe(302);
    expect(await inDO(h.id, t => t.db.get('last_access', 0))).toBe(before);
    const owner = await router.fetch(h.page_url, { headers: ownerHeaders(h.page_url) });
    expect(owner.status).toBe(200); await owner.text();
    expect(await inDO(h.id, t => t.db.get('last_access', 0))).toBeGreaterThanOrEqual(before + 60_000);
    expect(router.calls).toEqual(['/page', '/page']);
  });

  it('keeps held pages unavailable without changing application-level forbidden errors', async () => {
    const h = await create();
    const display = await inDO(h.id, async t => t.renderLink(await t.createLink('display', null, null)));
    const router = countedRouter();
    const forbidden = await router.fetch(display.url + '_tendril/guests');
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: 'forbidden' } });
    const owner = await inDO(h.id, t => t.db.get('owner_account', ''));
    await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), owner).run();
    router.calls.length = 0;
    const held = await router.fetch(h.page_url, { headers: ownerHeaders(h.page_url) });
    expect(held.status).toBe(403);
    expect(await held.text()).toBe('This page is unavailable pending review.');
    expect(held.headers.has(PAGE_ACCESS_HEADER)).toBe(false);
    expect(router.calls).toEqual(['/page']);
  });

  it('retains guest approval and owner-only authorization in the single request', async () => {
    const h = await create(), account = crypto.randomUUID(), secret = crypto.randomUUID();
    await env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(account, Date.now(), account + '@example.test').run();
    const guest = await inDO(h.id, async t => {
      const link = await t.createLink('guest', null, null);
      t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,1,?)', account, link.id, t.now());
      t.db.run('INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,?,?)', await sha256Hex(secret), account, 'guest', t.now() + 86400_000);
      return t.renderLink(link);
    });
    const router = countedRouter(), headers = { Cookie: `__Host-tendril=${secret}` };
    const reads: string[] = [];
    let admitted = 0;
    const restore = await inDO(h.id, t => {
      const original = t.env.ACCOUNTS, rate = t.env.PAGE_RATE;
      t.env.PAGE_RATE = { async limit() { admitted++; return { success: true }; } };
      t.env.ACCOUNTS = new Proxy(original, { get(target, key) {
        if (key === 'prepare') return (query: string) => { reads.push(query); return target.prepare(query); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return () => { t.env.ACCOUNTS = original; t.env.PAGE_RATE = rate; };
    });
    try {
      for (const [url, requestHeaders] of [[h.page_url, ownerHeaders(h.page_url)], [guest.url, headers]] as const) {
        reads.length = 0;
        const allowed = await router.fetch(url + '_tendril/application', { headers: requestHeaders });
        expect(allowed.status).toBe(200); await allowed.text();
        expect(reads).toHaveLength(url === h.page_url ? 1 : 2);
        expect(reads[0]).toContain('visitor_active');
      }
      await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(), account).run();
      const beforeDenial = admitted;
      const denied = await router.fetch(guest.url + '_tendril/application', { headers });
      expect(denied.status).toBe(302);
      expect(admitted).toBe(beforeDenial);
      // A suspended guest does not put the owner's page on hold.
      expect((await router.fetch(h.page_url, { headers: ownerHeaders(h.page_url), method: 'HEAD' })).status).toBe(200);
      await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=NULL WHERE id=?').bind(account).run();
    } finally { await inDO(h.id, restore); }
    const forbidden = await router.fetch(guest.url + '_tendril/guests', { headers });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: 'forbidden' } });
    await inDO(h.id, t => t.db.run('UPDATE guest_accounts SET approved=0 WHERE account_id=?', account));
    const revoked = await router.fetch(guest.url + '_tendril/application', { headers });
    expect(revoked.status).toBe(302);
    expect(router.calls).toHaveLength(6);
  });

  it('records display visitors on authored requests while shared assets remain free of page work', async () => {
    const h = await create();
    const display = await inDO(h.id, async t => t.renderLink(await t.createLink('display', null, null)));
    const router = countedRouter(), headers = { 'CF-Connecting-IP': '198.18.2.3' };
    const runtime = await router.fetch(display.url + runtimePath, { headers }); await runtime.text();
    expect(await inDO(h.id, t => t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM visitor_signals')!.n)).toBe(0);
    const page = await router.fetch(display.url, { headers });
    expect(page.status).toBe(200); await page.text();
    expect(await inDO(h.id, t => t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM visitor_signals')!.n)).toBe(1);
    expect(router.calls).toEqual(['/page']);
  });

  it('keeps optional resources and the service worker gated with their original scope', async () => {
    const h = await create(), resourceHash = 'c'.repeat(64);
    const resourcePath = `_tendril/assets/${resourceHash}/model.bin`;
    await env.FILES.put(`assets/${resourceHash}/model.bin`, new Uint8Array([1, 2, 3]));
    const router = countedRouter();
    for (const path of [resourcePath, '_tendril/sw.js']) {
      expect((await router.fetch(h.page_url + path)).status).toBe(302);
      const response = await router.fetch(h.page_url + path, { headers: ownerHeaders(h.page_url) });
      expect(response.status).toBe(200);
      if (path === '_tendril/sw.js') expect(response.headers.get('Service-Worker-Allowed')).toBe(new URL(h.page_url).pathname);
      await response.arrayBuffer();
    }
    expect(router.calls).toEqual(['/claim/check', '/claim/check', '/claim/check', '/claim/check']);
  });

  it('rechecks local session revocation after the asynchronous service write-state check', async () => {
    const h = await create();
    await inDO(h.id, async t => {
      const original = t.env.ACCOUNTS;
      let revoked = false;
      t.env.ACCOUNTS = { prepare(sql: string) {
        const statement = original.prepare(sql);
        if (!sql.includes('FROM service_state')) return statement;
        return { async first() {
          const result = await statement.first();
          t.db.run('DELETE FROM page_sessions'); revoked = true;
          return result;
        } } as D1PreparedStatement;
      } } as D1Database;
      try {
        const page = new URL(h.page_url);
        const response = await t.fetch(new Request('https://tendril.internal/page', {
          method: 'POST', headers: { ...ownerHeaders(h.page_url),
            'x-tendril-key': page.pathname.split('/')[2], 'x-tendril-origin': page.origin,
            'x-tendril-base': page.pathname, 'x-tendril-rest': 'agents/main/disconnect' },
        }));
        expect(revoked).toBe(true);
        expect(response.status).toBe(401);
        expect(response.headers.get(PAGE_ACCESS_HEADER)).toBe('signin');
        expect(t.db.one("SELECT 1 AS present FROM agent_grants")).not.toBeNull();
      } finally { t.env.ACCOUNTS = original; }
    });
  });

  it('checks mutation and WebSocket origins before public paths or object routing', async () => {
    const h = await create();
    const router = countedRouter();
    const attempts: RequestInit[] = [
      { method: 'POST', headers: { Origin: 'https://sibling.tendriller.site' } },
      { headers: { Origin: 'https://sibling.tendriller.site', Upgrade: 'websocket' } },
    ];
    for (const path of ['_tendril/application', runtimePath, '_tendril/sw.js']) {
      for (const init of attempts) {
        const response = await router.fetch(h.page_url + path, init);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'bad_origin' } });
      }
    }
    expect(router.calls).toEqual([]);
  });

  it.each([[429, 'page_rate_limited'], [503, 'unavailable'], [500, 'internal']] as const)(
    'preserves HTTP %s failures instead of turning them into sign-in redirects', async (status, code) => {
      const router = countedRouter(() => errorResponse(status, code));
      for (const path of ['_tendril/application', '_tendril/sw.js']) {
        const response = await router.fetch(unknownPage + path);
        expect(response.status).toBe(status);
        expect(response.headers.has('Location')).toBe(false);
        expect(await response.json()).toMatchObject({ error: { code } });
      }
    },
  );
});
