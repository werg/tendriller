import { expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { agentReq, api, create, createAgent, createPage, dashboard, grantAgent, inDO, joinAccountAgent, randomTestIp, req, revokeGrant, testWrapKey,
  signInAsOwner, testPublicKey, type Handle } from './helpers';
import { SETUP_WATCH_PROTOCOL } from '../src/setup-watch';
import { PEER_DISCOVERY_PROTOCOL } from '../../contract/discovery-watch.mjs';

const HUB = 'tendriller.hub.v1';
type Frame = Record<string, any>;

/** A test hub client: the real router upgrade, JSON frames and a frame queue. */
async function hub(token: string) {
  const response = await req('/api/agent/hub', { anonymous: true, headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${HUB}, ${token}` } });
  expect(response.status).toBe(101);
  expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(HUB);
  const socket = response.webSocket!, frames: Frame[] = [], waiting: ((frame: Frame) => void)[] = [];
  let closed: { code: number; reason: string } | null = null;
  const closing = new Promise<{ code: number; reason: string }>(resolve => socket.addEventListener('close', event => { closed = { code: event.code, reason: event.reason }; resolve(closed); }));
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data as string);
    const next = waiting.shift();
    if (next) next(frame); else frames.push(frame);
  });
  socket.accept();
  return {
    send: (frame: Frame) => socket.send(JSON.stringify(frame)),
    next: () => frames.length ? Promise.resolve(frames.shift()!) : new Promise<Frame>(resolve => waiting.push(resolve)),
    /** Waits for the next frame matching `match`, keeping the others queued. */
    async until(match: (frame: Frame) => boolean): Promise<Frame> {
      const index = frames.findIndex(match);
      if (index >= 0) return frames.splice(index, 1)[0];
      for (;;) {
        const frame = await new Promise<Frame>(resolve => waiting.push(resolve));
        if (match(frame)) return frame;
        frames.push(frame);
      }
    },
    closing, get closed() { return closed; },
    close: () => socket.close(1000, 'test done'),
  };
}

it('creates an unclaimed agent, lists only its granted pages and claims it and all its pages with the owner’s first page sign-in', async () => {
  const email = `agent-owner-${crypto.randomUUID()}@example.com`;
  const bad = await req('/api/agents', { method: 'POST', anonymous: true, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomTestIp() },
    body: JSON.stringify({ owner: email, handle: 'ab', publicKey: 'not a key' }) });
  expect(bad.status).toBe(400);
  const badHandle = await req('/api/agents', { method: 'POST', anonymous: true, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomTestIp() },
    body: JSON.stringify({ owner: email, handle: 'Bad Handle!', publicKey: testPublicKey() }) });
  expect(badHandle.status).toBe(400);
  const agent = await createAgent(email, 'garden-keeper', 'Tends the garden notes');
  expect(agent.token).toMatch(/^ta_[a-z2-7]{32}$/);
  expect(agent.agent).toMatchObject({ handle: 'garden-keeper', bio: 'Tends the garden notes', claimed: false, owner_email: email });
  expect(agent.agent.id).toMatch(/^ag_[a-z2-7]{26}$/);
  expect(await (await agentReq(agent.token, 'GET', '/api/agent')).json()).toMatchObject({
    agent: { id: agent.agent.id, claimed: false }, account: { claimed: false, owner_email: email }, grants: 0 });
  expect(await (await agentReq(agent.token, 'GET', '/api/agent/pages')).json()).toEqual({ pages: [], next_cursor: null });
  expect((await agentReq(agent.token, 'POST', '/api/agent/pages', { name: 'x', owner: 'other@example.com' })).status).toBe(400);
  const first = await createPage(agent, { name: 'First' }), second = await createPage(agent, { name: 'Second' });
  expect(first).toMatchObject({ name: 'First', claimed: false, api: `https://tendriller.dev/api/agent/pages/${first.id}` });
  const listed = await (await agentReq(agent.token, 'GET', '/api/agent/pages')).json() as { pages: any[]; next_cursor: string | null };
  const ids = [first.id, second.id].sort();
  expect(listed.pages.map(page => page.id)).toEqual(ids);
  expect(listed.pages[0]).toMatchObject({ scopes: expect.arrayContaining(['host:manage', 'publication:write']), granted_by: 'creator',
    lifetime: 'ad_hoc', claimed: false, application: { id: expect.stringMatching(/^[a-f0-9]{64}$/) }, page_url: expect.stringContaining('.tendriller.site/s/') });
  const after = await (await agentReq(agent.token, 'GET', `/api/agent/pages?cursor=${ids[0]}`)).json() as { pages: any[] };
  expect(after.pages.map(page => page.id)).toEqual([ids[1]]);
  expect((await agentReq(agent.token, 'GET', '/api/agent/pages?cursor=bad')).status).toBe(400);

  // Another agent of the same owner email has no grant: the page does not exist for it.
  const stranger = await createAgent(email, 'stranger');
  expect((await agentReq(stranger.token, 'GET', `/api/agent/pages/${first.id}`)).status).toBe(404);
  expect((await agentReq(stranger.token, 'GET', `/api/agent/pages/${first.id}/setup/watch`, undefined,
    { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': SETUP_WATCH_PROTOCOL })).status).toBe(404);

  // Pages of another agent for the same email, and of an agent for another email, stay unclaimed.
  const strangerPage = await createPage(stranger, { name: 'Stranger' });
  const elsewhere = await createAgent(`agent-other-${crypto.randomUUID()}@example.com`, 'elsewhere');
  const elsewherePage = await createPage(elsewhere, { name: 'Elsewhere' });

  const account = crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO accounts (id, created_at, email) VALUES (?, ?, ?)').bind(account, Date.now(), email).run();
  await signInAsOwner(first, account, email);
  // Signing in to one page claims every other page this agent created for the owner.
  for (const page of [first, second]) {
    expect(await env.ACCOUNTS.prepare('SELECT owner_account, claimed_at IS NOT NULL AS claimed FROM tendrils WHERE id=?').bind(page.id).first())
      .toEqual({ owner_account: account, claimed: 1 });
    expect(await inDO(page.id, t => [t.db.get('owner_account', null), typeof t.db.get('claimed_at', null)])).toEqual([account, 'number']);
  }
  const listedClaimed = await (await agentReq(agent.token, 'GET', '/api/agent/pages')).json() as { pages: any[] };
  expect(listedClaimed.pages.map(page => page.claimed)).toEqual([true, true]);
  for (const page of [strangerPage, elsewherePage]) {
    expect(await env.ACCOUNTS.prepare('SELECT owner_account FROM tendrils WHERE id=?').bind(page.id).first()).toEqual({ owner_account: null });
    expect(await inDO(page.id, t => t.db.get('owner_account', null))).toBe(null);
  }
  // The internal sibling claim refuses an agent without this page's creator grant.
  expect(await inDO(strangerPage.id, async t => (await t.fetch(new Request('https://tendril.internal/claim/agent-owner', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tendril-agent': agent.agent.id },
    body: JSON.stringify({ account_id: account, identities: [{ emails: [email] }] }) }))).status)).toBe(403);
  expect(await inDO(strangerPage.id, t => t.db.get('owner_account', null))).toBe(null);
  expect(await env.ACCOUNTS.prepare('SELECT account_id, claimed_at IS NOT NULL AS claimed FROM agents WHERE id=?').bind(agent.agent.id).first())
    .toEqual({ account_id: account, claimed: 1 });
  expect(await env.ACCOUNTS.prepare('SELECT account_id FROM agents WHERE id=?').bind(stranger.agent.id).first()).toEqual({ account_id: null });
  expect(await (await agentReq(agent.token, 'GET', '/api/agent')).json()).toMatchObject({ account: { claimed: true, email } });
  // A claimed agent creates pages the account already owns.
  const owned = await createPage(agent, { name: 'Owned' });
  expect(owned.claimed).toBe(true);
  expect(await inDO(owned.id, t => t.db.get('owner_account', null))).toBe(account);
  expect(await env.ACCOUNTS.prepare('SELECT owner_account, claimed_at IS NOT NULL AS claimed FROM tendrils WHERE id=?').bind(owned.id).first())
    .toEqual({ owner_account: account, claimed: 1 });
});

it('removes page tokens, adoption, setup and per-page agent routes outright', async () => {
  const h = await create();
  for (const [method, path] of [['POST', '/api/tendrils'], ['POST', '/api/adopt'], ['GET', '/api/adopt'], ['POST', '/api/setup'],
    ['GET', `/api/t/${h.id}`], ['POST', `/api/agent/pages/${h.id}/tokens`], ['GET', '/join/agent?code=x']] as const) {
    const response = await req(path, { method, anonymous: true, headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: '{}' } : {}) });
    expect(response.status, `${method} ${path}`).toBe(404);
  }
});

it('lets the page owner grant and remove account agents, pick primary, and propagate handle renames', async () => {
  const h = await create();
  const helper = await joinAccountAgent(h, 'helper', 'Reviews changes');
  const json = { 'Content-Type': 'application/json' };
  const listed = await (await req(h.page_url + '_tendril/agents')).json() as {
    primary_agent_id: string | null;
    agents: { id: string; handle: string; bio: string; is_primary: boolean }[];
    account_agents: { id: string; handle: string; bio: string; granted: boolean }[];
    can_manage: boolean;
    dashboard: string;
  };
  expect(listed.dashboard).toBe('https://tendriller.dev/dashboard#agents');
  expect(listed.can_manage).toBe(true);
  expect(listed.primary_agent_id).toBe(h.agent.id);
  expect(listed.agents).toHaveLength(1);
  expect(listed.account_agents.find(agent => agent.id === h.agent.id)).toMatchObject({ granted: true });
  expect(listed.account_agents.find(agent => agent.id === helper.agent.id)).toMatchObject({ id: helper.agent.id, handle: 'helper', bio: 'Reviews changes', granted: false });
  expect((await agentReq(helper.token, 'GET', `/api/agent/pages/${h.id}`)).status).toBe(404);

  const grant = await req(h.page_url + '_tendril/agents', { method: 'POST', headers: json, body: JSON.stringify({ agent: helper.agent.id, granted: true }) });
  expect(grant.status).toBe(200);
  expect((await agentReq(helper.token, 'GET', `/api/agent/pages/${h.id}`)).status).toBe(200);
  const after = await (await req(h.page_url + '_tendril/agents')).json() as { primary_agent_id: string | null; agents: { id: string; handle: string; is_primary: boolean }[]; account_agents: { id: string; granted: boolean }[] };
  expect(after.account_agents.find(agent => agent.id === helper.agent.id)?.granted).toBe(true);
  expect(after.primary_agent_id).toBe(h.agent.id);

  // Owner can switch primary agent to helper and back, and clear it.
  const setPrimary = await req(h.page_url + '_tendril/agents/primary', { method: 'PUT', headers: json, body: JSON.stringify({ agent_id: helper.agent.id }) });
  expect(setPrimary.status).toBe(200);
  expect((await setPrimary.json() as any).primary_agent_id).toBe(helper.agent.id);

  // Agent can update its own handle + bio via PATCH /api/agent, propagating to granted pages.
  const dup = await agentReq(helper.token, 'PATCH', '/api/agent', { handle: h.agent.handle.toUpperCase() });
  expect(dup.status).toBe(409);
  const renamed = await agentReq(helper.token, 'PATCH', '/api/agent', { handle: 'reviewer', bio: 'Code reviewer' });
  expect(renamed.status).toBe(200);
  const afterRename = await (await req(h.page_url + '_tendril/agents')).json() as { agents: { id: string; handle: string; bio: string }[] };
  expect(afterRename.agents.find(a => a.id === helper.agent.id)).toMatchObject({ handle: 'reviewer', bio: 'Code reviewer' });

  // Removing primary agent reconciles primary to the remaining granted agent.
  const remove = await req(h.page_url + '_tendril/agents', { method: 'POST', headers: json, body: JSON.stringify({ agent: helper.agent.id, granted: false }) });
  expect(remove.status).toBe(200);
  expect((await agentReq(helper.token, 'GET', `/api/agent/pages/${h.id}`)).status).toBe(404);
  const reconciled = await (await req(h.page_url + '_tendril/agents')).json() as { primary_agent_id: string | null };
  expect(reconciled.primary_agent_id).toBe(h.agent.id);

  const stranger = await req(h.page_url + '_tendril/agents', { method: 'POST', headers: json, body: JSON.stringify({ agent: 'ag_' + 'a'.repeat(26), granted: true }) });
  expect(stranger.status).toBe(404);
  // Visitors without a session get the page's sign-in screen, never the agent list.
  const visitor = await req(h.page_url + '_tendril/agents', { anonymous: true });
  expect(visitor.headers.get('content-type')).toMatch(/^text\/html/);
  expect(await visitor.text()).not.toContain(helper.agent.id);
});

it('enforces scopes per grant and closes an agent’s page sockets when its grant or the agent is revoked', async () => {
  const h = await create();
  const observer = await grantAgent(h, await joinAccountAgent(h, 'observer'), ['host:read']);
  expect((await api(observer, 'GET', '')).status).toBe(200);
  expect(await (await api(observer, 'GET', '')).json()).toMatchObject({ scopes: ['host:read'] });
  expect((await api(observer, 'PATCH', '', { name: 'forged' })).status).toBe(403);
  expect((await api(observer, 'GET', 'peers/bootstrap')).status).toBe(403);

  const watch = async (handle: Handle) => {
    const response = await req(`${handle.api}/setup/watch`, { anonymous: true,
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${SETUP_WATCH_PROTOCOL}, ${handle.token}` } });
    expect(response.status).toBe(101);
    expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(SETUP_WATCH_PROTOCOL);
    const socket = response.webSocket!;
    const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)));
    socket.accept();
    return { closed };
  };
  const writer = await grantAgent(h, await joinAccountAgent(h, 'writer'));
  const writerClosed = (await watch(writer)).closed, creatorClosed = (await watch(h)).closed;
  expect((await revokeGrant(h, writer.agent.id)).status).toBe(200);
  expect(await writerClosed).toBe(4003);
  expect((await api(writer, 'GET', '')).status).toBe(404);
  expect((await api(h, 'GET', '')).status).toBe(200);

  // Revoking the agent (not just one grant) kills its credential everywhere.
  const revoked = await dashboard(h, `/dashboard/agents/${h.agent.id}/revoke`, { method: 'POST' });
  expect(revoked.status).toBe(303);
  expect(await creatorClosed).toBe(4003);
  expect((await api(h, 'GET', '')).status).toBe(401);
  expect(await inDO(h.id, t => t.db.one('SELECT 1 AS x FROM agent_grants WHERE agent_id=?', h.agent.id))).toBeNull();
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM agent_grants WHERE agent_id=?').bind(h.agent.id).first()).toEqual({ n: 0 });
  // An agent can also revoke itself.
  expect((await agentReq(observer.token, 'DELETE', '/api/agent')).status).toBe(204);
  expect((await api(observer, 'GET', '')).status).toBe(401);
});

it('multiplexes control streams over one hub connection onto real page socket endpoints', async () => {
  const h = await create();
  const other = await create();
  const connection = await hub(h.token);
  connection.send({ t: 'ping' });
  expect(await connection.next()).toEqual({ t: 'pong' });

  connection.send({ t: 'open', s: 1, page: h.id, path: 'setup/watch', protocols: [SETUP_WATCH_PROTOCOL] });
  expect(await connection.next()).toEqual({ t: 'opened', s: 1, protocol: SETUP_WATCH_PROTOCOL });
  const snapshot = await connection.next();
  expect(snapshot).toMatchObject({ t: 'data', s: 1 });
  expect(JSON.parse(snapshot.text)).toEqual({ type: 'setup', version: 1, mcp: { connected: false, grants: [], updatedAt: 0 } });

  const peerId = 'ab'.repeat(32);
  connection.send({ t: 'open', s: 2, page: h.id, path: `peers/discovery/watch?peerId=${peerId}`, protocols: [PEER_DISCOVERY_PROTOCOL] });
  expect(await connection.until(frame => frame.s === 2 && frame.t === 'opened')).toEqual({ t: 'opened', s: 2, protocol: PEER_DISCOVERY_PROTOCOL });
  expect(JSON.parse((await connection.until(frame => frame.s === 2 && frame.t === 'data')).text)).toEqual({ type: 'ready' });
  const routed = await inDO(h.id, t => t.ctx.getWebSockets('peer-discovery').map(ws => ws.deserializeAttachment()));
  expect(routed).toEqual([expect.objectContaining({ peerId, owner: `agent:${h.agent.id}`, principal: expect.objectContaining({ agentId: h.agent.id }) })]);

  // Receive-only endpoints keep their own protocol rules behind the stream.
  connection.send({ t: 'data', s: 1, text: '{}' });
  expect(await connection.until(frame => frame.s === 1)).toMatchObject({ t: 'closed', s: 1, code: 1008 });
  connection.send({ t: 'close', s: 2, code: 1000, reason: 'done' });
  expect(await connection.until(frame => frame.s === 2)).toMatchObject({ t: 'closed', s: 2, code: 1000 });

  // Each open checks the grant; failures report 4000 + HTTP status and the error code.
  connection.send({ t: 'open', s: 3, page: other.id, path: 'setup/watch', protocols: [SETUP_WATCH_PROTOCOL] });
  expect(await connection.until(frame => frame.s === 3)).toEqual({ t: 'closed', s: 3, code: 4404, reason: 'not_found' });
  connection.send({ t: 'open', s: 4, page: h.id, path: 'peers/relay', protocols: [] });
  expect(await connection.until(frame => frame.s === 4)).toEqual({ t: 'closed', s: 4, code: 4400, reason: 'invalid_stream' });
  connection.send({ t: 'open', s: 5, page: h.id, path: 'setup/watch', protocols: [] });
  expect(await connection.until(frame => frame.s === 5)).toEqual({ t: 'closed', s: 5, code: 4400, reason: 'setup_protocol_required' });
  connection.send({ t: 'open', s: 6, page: h.id, path: 'setup/watch', protocols: [SETUP_WATCH_PROTOCOL, h.token] });
  expect(await connection.until(frame => frame.s === 6)).toEqual({ t: 'closed', s: 6, code: 4400, reason: 'invalid_stream' });
  connection.send({ t: 'data', s: 99, text: 'orphan' });
  expect(await connection.until(frame => frame.s === 99)).toMatchObject({ t: 'closed', s: 99, code: 1011 });

  // A newer connection replaces the older one and its streams.
  connection.send({ t: 'open', s: 7, page: h.id, path: 'setup/watch', protocols: [SETUP_WATCH_PROTOCOL] });
  await connection.until(frame => frame.s === 7 && frame.t === 'opened');
  const replacement = await hub(h.token);
  expect((await connection.closing).code).toBe(4000);
  replacement.send({ t: 'ping' });
  expect(await replacement.next()).toEqual({ t: 'pong' });
  replacement.close();
});

it('delivers grant, revoked, page-deleted and publication-free events to granted agents and closes revoked streams', async () => {
  const h = await create(), page = await createPage({ token: h.token, agent: h.agent }, { name: 'Second' });
  const joined = await joinAccountAgent(h, 'helper');
  const connection = await hub(joined.token);
  connection.send({ t: 'open', s: 1, page: h.id, path: 'setup/watch', protocols: [SETUP_WATCH_PROTOCOL] });
  expect(await connection.next()).toEqual({ t: 'closed', s: 1, code: 4404, reason: 'not_found' });
  const granted = await dashboard(h, `/dashboard/t/${h.id}/agents`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: joined.agent.id, granted: true }) });
  expect(granted.status).toBe(200);
  expect(await connection.until(frame => frame.t === 'event' && frame.kind === 'grant')).toEqual({ t: 'event', page: h.id, kind: 'grant', data: { scopes: expect.arrayContaining(['host:read']) } });
  connection.send({ t: 'open', s: 2, page: h.id, path: 'setup/watch', protocols: [SETUP_WATCH_PROTOCOL] });
  expect(await connection.until(frame => frame.s === 2 && frame.t === 'opened')).toMatchObject({ protocol: SETUP_WATCH_PROTOCOL });
  await connection.until(frame => frame.s === 2 && frame.t === 'data');
  expect((await revokeGrant(h, joined.agent.id)).status).toBe(200);
  expect(await connection.until(frame => frame.s === 2)).toMatchObject({ t: 'closed', s: 2, code: 4003 });
  expect(await connection.until(frame => frame.t === 'event' && frame.kind === 'revoked')).toEqual({ t: 'event', page: h.id, kind: 'revoked', data: {} });

  // The creator's hub hears about deletion of its page.
  const creator = await hub(h.token);
  expect((await agentReq(h.token, 'DELETE', `/api/agent/pages/${page.id}`)).status).toBe(204);
  expect(await creator.until(frame => frame.t === 'event' && frame.kind === 'page-deleted')).toEqual({ t: 'event', page: page.id, kind: 'page-deleted', data: {} });
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM agent_grants WHERE page_id=?').bind(page.id).first()).toEqual({ n: 0 });
  creator.close(); connection.close();
});

it('rejects hub connections without the protocol or a valid token and bounds frames', async () => {
  const h = await create();
  expect((await req('/api/agent/hub', { anonymous: true, headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': HUB } })).status).toBe(401);
  expect((await req('/api/agent/hub', { anonymous: true, headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': h.token } })).status).toBe(400);
  expect((await req('/api/agent/hub', { anonymous: true, headers: { Authorization: `Bearer ${h.token}` } })).status).toBe(426);
  const connection = await hub(h.token);
  connection.send({ t: 'data', s: 1, text: 'x'.repeat(1024 * 1024) });
  expect((await connection.closing).code).toBe(1009);
  const second = await hub(h.token);
  second.send({ t: 'open', s: 0, page: h.id, path: 'setup/watch' });
  expect((await second.closing).code).toBe(1008);
});

it('join codes are single-use, expire and add agents only to the issuing account', async () => {
  const h = await create();
  const issued = await (await dashboard(h, '/dashboard/agents/join', { method: 'POST' })).json() as { code: string };
  await env.ACCOUNTS.prepare('UPDATE agent_join_codes SET expires_at=? WHERE account_id=?').bind(Date.now() - 1, h.account).run();
  const expired = await req('/api/agents/join', { method: 'POST', anonymous: true, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': randomTestIp() },
    body: JSON.stringify({ code: issued.code, handle: 'late', publicKey: testPublicKey(), wrapKey: testWrapKey() }) });
  expect(expired.status).toBe(404);
  const joined = await joinAccountAgent(h, 'fresh');
  expect(await env.ACCOUNTS.prepare('SELECT account_id FROM agents WHERE id=?').bind(joined.agent.id).first()).toEqual({ account_id: h.account });
  // Joined agents create pages already owned by the account.
  const page = await createPage(joined, {});
  expect(page.claimed).toBe(true);
  expect(await inDO(page.id, t => t.db.get('owner_account', null))).toBe(h.account);
});
