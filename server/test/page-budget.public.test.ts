import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/ids';
import type { Tendril } from '../src/tendril';
import { create, inDO, ownerHeaders, type Handle } from './helpers';

interface Budget {
  pages: string[];
  accounts: string[];
  pageAllowed: boolean;
  accountAllowed: boolean;
  beforePage?: () => void;
}
type PageRequest = (url?: string, init?: RequestInit, rest?: string) => Promise<Response>;

async function withBudget(handle: Handle, test: (t: Tendril, budget: Budget, request: PageRequest) => Promise<void>) {
  await inDO(handle.id, async t => {
    const pageRate = t.env.PAGE_RATE, accountRate = t.env.ACCOUNT_RATE;
    const budget: Budget = { pages: [], accounts: [], pageAllowed: true, accountAllowed: true };
    t.env.PAGE_RATE = { async limit({ key }) {
      budget.pages.push(key); budget.beforePage?.(); return { success: budget.pageAllowed };
    } } as RateLimit;
    t.env.ACCOUNT_RATE = { async limit({ key }) {
      budget.accounts.push(key); return { success: budget.accountAllowed };
    } } as RateLimit;
    const request: PageRequest = (url = handle.page_url, init = {}, rest = '_tendril/application') => {
      const page = new URL(url), headers = new Headers(init.headers ?? ownerHeaders(url));
      headers.set('x-tendril-key', page.pathname.split('/')[2]);
      headers.set('x-tendril-origin', page.origin);
      headers.set('x-tendril-base', page.pathname);
      headers.set('x-tendril-rest', encodeURIComponent(rest));
      return t.fetch(new Request('https://tendril.internal/page', { ...init, headers }));
    };
    try { await test(t, budget, request); }
    finally { t.env.PAGE_RATE = pageRate; t.env.ACCOUNT_RATE = accountRate; }
  });
}

describe('page request budgets follow admission', () => {
  it('does not let anonymous or revoked requests consume the page or shared owner allowance', async () => {
    const h = await create();
    await withBudget(h, async (t, budget, request) => {
      expect((await request(h.page_url, { headers: {} })).status).toBe(401);
      expect((await request(h.page_url, { headers: { Cookie: '__Host-tendril=invalid' } })).status).toBe(401);
      expect((await request(h.page_url.replace(/\/s\/[^/]+\//, `/s/${'a'.repeat(26)}/`))).status).toBe(401);
      expect(budget.pages).toEqual([]); expect(budget.accounts).toEqual([]);
      const owner = await request();
      expect(owner.status).toBe(200); await owner.text();
      expect(budget.pages).toEqual([h.id]);
      expect(budget.accounts).toEqual([t.db.get('owner_account', '')]);
      t.db.run('DELETE FROM page_sessions');
      expect((await request()).status).toBe(401);
      t.db.run('DELETE FROM links');
      expect((await request()).status).toBe(401);
      expect(budget.pages).toEqual([h.id]); expect(budget.accounts).toHaveLength(1);
    });
  });

  it('charges approved guests and display links once but excludes unapproved or held traffic', async () => {
    const h = await create(), account = crypto.randomUUID(), token = crypto.randomUUID();
    await env.ACCOUNTS.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(account, Date.now(), account + '@example.test').run();
    await withBudget(h, async (t, budget, request) => {
      const link = await t.createLink('guest', null, null), guest = t.renderLink(link);
      t.db.run('INSERT INTO guest_accounts(account_id,link_id,approved,created_at) VALUES(?,?,0,?)', account, link.id, t.now());
      t.db.run('INSERT INTO page_sessions(hash,account_id,role,expires_at) VALUES(?,?,?,?)', await sha256Hex(token), account, 'guest', t.now() + 60_000);
      const headers = { Cookie: `__Host-tendril=${token}` };
      expect((await request(guest.url, { headers })).status).toBe(401);
      expect(budget.pages).toEqual([]); expect(budget.accounts).toEqual([]);
      t.db.run('UPDATE guest_accounts SET approved=1 WHERE account_id=?', account);
      const approved = await request(guest.url, { headers });
      expect(approved.status).toBe(200); await approved.text();
      const display = t.renderLink(await t.createLink('display', null, null));
      const shown = await request(display.url, { headers: {} }, '');
      expect(shown.status).toBe(200); await shown.text();
      const forbidden = await request(display.url, { headers: {} }, '_tendril/guests');
      expect(forbidden.status).toBe(403); await forbidden.text();
      // An admitted caller's endpoint permission error still consumes traffic.
      expect(budget.pages).toEqual([h.id, h.id, h.id]);
      expect(budget.accounts).toEqual(Array(3).fill(t.db.get('owner_account', '')));
      t.db.set('disabled', true);
      expect((await request(display.url, { headers: {} })).status).toBe(403);
      expect(budget.pages).toHaveLength(3); expect(budget.accounts).toHaveLength(3);
    });
  });

  it('keeps legitimate page and account limits effective without spending them on anonymous requests', async () => {
    const h = await create();
    await withBudget(h, async (t, budget, request) => {
      const activity = t.db.get('last_access', 0);
      t.skew += 120_000;
      budget.pageAllowed = false;
      expect((await request(h.page_url, { headers: {} })).status).toBe(401);
      expect(budget.pages).toEqual([]); expect(budget.accounts).toEqual([]);
      const pageLimited = await request();
      expect(pageLimited.status).toBe(429);
      expect(await pageLimited.json()).toMatchObject({ error: { code: 'page_rate_limited' } });
      expect(budget.pages).toEqual([h.id]); expect(budget.accounts).toEqual([]);
      budget.pageAllowed = true; budget.accountAllowed = false;
      const accountLimited = await request();
      expect(accountLimited.status).toBe(429);
      expect(await accountLimited.json()).toMatchObject({ error: { code: 'account_rate_limited' } });
      expect(budget.pages).toHaveLength(2); expect(budget.accounts).toHaveLength(1);
      expect(t.db.get('last_access', 0)).toBe(activity);
      budget.accountAllowed = true;
      const admitted = await request();
      expect(admitted.status).toBe(200); await admitted.text();
      expect(budget.pages).toHaveLength(3); expect(budget.accounts).toHaveLength(2);
      expect(t.db.get('last_access', 0)).toBeGreaterThan(activity);
    });
  });

  it('rechecks session revocation while the asynchronous traffic admission is pending', async () => {
    const h = await create();
    await withBudget(h, async (t, budget, request) => {
      budget.beforePage = () => t.db.run('DELETE FROM page_sessions');
      const response = await request();
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('');
    });
  });
});
