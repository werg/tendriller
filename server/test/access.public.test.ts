import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { AGENT_HEADER, AGENT_SCOPES_HEADER, authenticateAgent, readPageSession } from '../src/access';
import type { Tendril } from '../src/tendril';
import { agentPrincipal, api, create, inDO, ownerHeaders, req } from './helpers';

it('resolves the agent from internal headers and its local grant mirror only', async () => {
  const h = await create();
  await inDO(h.id, async t => {
    const scopes = agentPrincipal(t, h).scopes.join(' ');
    const internal = (agent: string, granted = scopes) => new Request('https://tendril.internal/agent', { headers: { [AGENT_HEADER]: agent, [AGENT_SCOPES_HEADER]: granted } });
    expect(authenticateAgent(t, internal(h.agent.id))).toEqual(agentPrincipal(t, h));
    expect(() => authenticateAgent(t, new Request('https://tendril.internal/agent', { headers: { Authorization: `Bearer ${h.token}` } }))).toThrow('Agent credential required');
    expect(() => authenticateAgent(t, internal('ag_' + 'b'.repeat(26)))).toThrow('No such granted page');
    expect(() => authenticateAgent(t, internal(h.agent.id, 'host:read'))).toThrow('grant changed');
  });
  expect((await api(h, 'GET', '')).status).toBe(200);
  // A forged internal header from the client never reaches the page object.
  const forged = await req(h.api, { anonymous: true, headers: { [AGENT_HEADER]: h.agent.id, [AGENT_SCOPES_HEADER]: 'host:read' } });
  expect(forged.status).toBe(401);
});
it.each(['session revoked', 'session expired', 'link revoked', 'owner deleting'])(
  'refuses host metadata when %s', async reason => {
    const h = await create();
    await inDO(h.id, t => {
      if (reason === 'session revoked') t.db.run('DELETE FROM page_sessions');
      if (reason === 'session expired') t.db.run('UPDATE page_sessions SET expires_at=?', t.now());
      if (reason === 'link revoked') t.db.run("DELETE FROM links WHERE id='l_main'");
    });
    if (reason === 'owner deleting') {
      const owner = await inDO(h.id, t => t.db.get('owner_account', ''));
      await env.ACCOUNTS.prepare('UPDATE accounts SET deleting_at=? WHERE id=?').bind(Date.now(), owner).run();
    }
    const response = await req(h.page_url + '_tendril/application', { redirect: 'manual' });
    expect([302, 403, 404]).toContain(response.status);
    expect(await response.text()).not.toContain(h.application.id);
  });

async function duringAccountRead<T>(t: Tendril, mutate: () => void, run: () => Promise<T>): Promise<T> {
  const original = t.env.ACCOUNTS; let changed = false;
  t.env.ACCOUNTS = { prepare(sql: string) {
    const statement = original.prepare(sql);
    if (!sql.includes('FROM accounts WHERE id')) return statement;
    return { bind(...args: unknown[]) { const bound = statement.bind(...args);
      return { async first() { const result = await bound.first(); changed = true; mutate(); return result; } }; } };
  } } as D1Database;
  try { const result = await run(); expect(changed).toBe(true); return result; }
  finally { t.env.ACCOUNTS = original; }
}
it('revalidates the local page session after asynchronous account lookup', async () => {
  const h = await create();
  await inDO(h.id, async t => {
    const session = await duringAccountRead(t, () => t.db.run('DELETE FROM page_sessions'),
      () => readPageSession(t, new Request(h.page_url, { headers: ownerHeaders(h.page_url) })));
    expect(session).toBeNull();
  });
});
