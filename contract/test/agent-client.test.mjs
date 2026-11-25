import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient, createAgentHub, registerAgent, joinAgent, HUB_LIMITS } from '../client.mjs';
import { watchApplicationSetup } from '../setup-watch.mjs';
import { PEER_DISCOVERY_PROTOCOL, PEER_RELAY_PROTOCOL, PEER_INVITATION_PROTOCOL } from '../peers.mjs';
import { fakeHub, TOKEN, PAGE } from './support/fake-hub.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const service = 'https://service.test';
const application = { id: 'ab'.repeat(32) };
const page = { id: PAGE, name: 'Notes', page_url: `https://${PAGE}.pages.test/s/${'a'.repeat(26)}/`, scopes: ['host:read'], application };

test('registration and join return a checked ta_ credential without any ambient authentication', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ id: 'ag_' + 'b'.repeat(26), name: 'laptop', token: TOKEN, account_state: 'unclaimed' }, { status: 201 }); };
  const publicKey = 'A'.repeat(43);
  const created = await registerAgent(service, { owner: 'owner@example.test', name: 'laptop', publicKey }, { fetch });
  assert.equal(created.token, TOKEN);
  assert.equal(calls[0].url, service + '/api/agents');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { owner: 'owner@example.test', name: 'laptop', publicKey });
  await joinAgent(service, { code: 'join-code', name: 'laptop', publicKey }, { fetch });
  assert.equal(calls[1].url, service + '/api/agents/join');
  await assert.rejects(registerAgent(service, { owner: 'bad', name: 'x', publicKey }, { fetch }), { name: 'ContractError' });
  await assert.rejects(registerAgent(service, { owner: 'owner@example.test', name: 'x', publicKey },
    { fetch: async () => Response.json({ id: 'ag_x', name: 'x', token: 'tk_old' }) }), { code: 'invalid_response' });
  await assert.rejects(registerAgent('https://service.test/api', { owner: 'owner@example.test', name: 'x', publicKey }, { fetch }), { code: 'invalid_service_origin' });
});

test('the agent client is inert until used and bases page routes at /api/agent/pages/<id>', async () => {
  const calls = [], hub = fakeHub();
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/agent/pages') && init.method === 'POST') return Response.json(page, { status: 201 });
    if (url.includes('/api/agent/pages?cursor=next')) return Response.json({ pages: [{ ...page, id: 'bbbbbbbbbbbb' }], next_cursor: null });
    if (url.endsWith('/api/agent/pages')) return Response.json({ pages: [page], next_cursor: 'next' });
    if (url.endsWith('/api/agent')) return Response.json({ id: 'ag_' + 'b'.repeat(26), grants: 2 });
    return Response.json({ id: PAGE });
  };
  const client = createAgentClient({ service, token: TOKEN }, { fetch, WebSocket: hub.WebSocket });
  assert.equal(calls.length, 0); assert.equal(hub.connections.length, 0);
  assert.deepEqual(Object.keys(client).sort(), ['close', 'hub', 'page', 'pages', 'request', 'self', 'service']);
  assert.equal((await client.self()).grants, 2);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + TOKEN);
  assert.deepEqual(await client.pages.create({ name: 'Notes' }), page);
  const all = []; for await (const value of client.pages.all()) all.push(value.id);
  assert.deepEqual(all, [PAGE, 'bbbbbbbbbbbb']);
  const one = client.page(PAGE, { applicationId: application.id });
  assert.equal(one, client.page(PAGE, { applicationId: application.id }));
  assert.deepEqual(Object.keys(one).sort(), ['base', 'id', 'info', 'peers', 'request', 'service', 'socket']);
  await one.info();
  assert.equal(calls.at(-1).url, `${service}/api/agent/pages/${PAGE}`);
  assert.throws(() => client.page('../agent'), { code: 'invalid_page' });
  assert.throws(() => createAgentClient({ service, token: 'tk_' + 'a'.repeat(32) }), { code: 'invalid_agent_token' });
  assert.equal(hub.connections.length, 0, 'HTTP work never opens the hub');
});

test('hub streams are WebSocket-compatible: open, text and binary data, close handshake', async t => {
  const hub = fakeHub(), events = [];
  const agent = createAgentHub({ service, token: TOKEN, WebSocket: hub.WebSocket });
  t.after(() => agent.close());
  const stream = agent.socket(PAGE, 'peers/rendezvous?channel=room&peerId=me', ['tendriller.rendezvous.v1']);
  assert.equal(stream.readyState, 0);
  assert.throws(() => stream.send('early'), { name: 'InvalidStateError' });
  const connection = hub.last;
  assert.equal(connection.url, 'wss://service.test/api/agent/hub');
  assert.deepEqual(connection.protocols, ['tendriller.hub.v1', TOKEN]);
  connection.accept();
  const [open] = connection.frames('open');
  assert.deepEqual(open, { t: 'open', s: 1, page: PAGE, path: 'peers/rendezvous?channel=room&peerId=me', protocols: ['tendriller.rendezvous.v1'] });
  stream.onopen = () => events.push('onopen');
  stream.addEventListener('open', () => events.push('open'));
  stream.addEventListener('message', event => events.push(event.data));
  stream.onclose = event => events.push(['close', event.code, event.reason]);
  connection.push({ t: 'opened', s: 1, protocol: 'tendriller.rendezvous.v1' });
  assert.equal(stream.readyState, 1); assert.equal(stream.protocol, 'tendriller.rendezvous.v1');
  connection.push({ t: 'data', s: 1, text: '{"t":"ready"}' });
  connection.push({ t: 'data', s: 1, base64: btoa('\x01\x02') });
  stream.send('hello'); stream.send(new Uint8Array([3, 4]));
  assert.deepEqual(connection.frames('data'), [{ t: 'data', s: 1, text: 'hello' }, { t: 'data', s: 1, base64: btoa('\x03\x04') }]);
  stream.close(1000, 'done');
  assert.equal(stream.readyState, 2);
  assert.deepEqual(connection.frames('close'), [{ t: 'close', s: 1, code: 1000, reason: 'done' }]);
  connection.push({ t: 'closed', s: 1, code: 1000, reason: 'done' });
  assert.equal(stream.readyState, 3);
  assert.equal(events[0], 'open'); assert.equal(events[1], 'onopen'); assert.equal(events[2], '{"t":"ready"}');
  assert.deepEqual([...new Uint8Array(events[3])], [1, 2]);
  assert.deepEqual(events[4], ['close', 1000, 'done']);
  assert.throws(() => agent.socket(PAGE, 'peers/relay?lane=live'), { code: 'invalid_hub_path' });
  assert.throws(() => agent.socket('bad', 'setup/watch'), { code: 'invalid_hub_page' });
  await flush();
  assert.equal(connection.readyState, 3, 'an idle hub without listeners disconnects');
});

test('hub loss fails streams closed and reconnects with backoff while needed; events reach listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const hub = fakeHub(), events = [], states = [];
  const agent = createAgentHub({ service, token: TOKEN, WebSocket: hub.WebSocket, retryMs: 100, maxRetryMs: 400 });
  t.after(() => agent.close());
  agent.onStatus(status => states.push(status.state));
  const stop = agent.events(event => events.push(event));
  hub.last.accept();
  const stream = agent.socket(PAGE, 'setup/watch', ['tendriller.setup.v1']);
  hub.last.push({ t: 'opened', s: 1, protocol: 'tendriller.setup.v1' });
  hub.last.push({ t: 'event', page: PAGE, kind: 'grant', data: { scopes: ['host:read'] } });
  assert.deepEqual(events, [{ page: PAGE, kind: 'grant', data: { scopes: ['host:read'] } }]);
  const closes = []; stream.addEventListener('close', event => closes.push(event.code));
  hub.last.drop(1006); await flush();
  assert.deepEqual(closes, [1006]); assert.equal(stream.readyState, 3);
  assert.equal(states.at(-1), 'reconnecting');
  assert.equal(hub.connections.length, 1);
  t.mock.timers.tick(100); await flush();
  assert.equal(hub.connections.length, 2);
  hub.last.drop(1006); await flush();
  t.mock.timers.tick(199); await flush(); assert.equal(hub.connections.length, 2);
  t.mock.timers.tick(1); await flush(); assert.equal(hub.connections.length, 3);
  hub.last.accept();
  assert.equal(states.at(-1), 'connected');
  hub.last.push({ t: 'ping' });
  assert.deepEqual(hub.last.frames('pong'), [{ t: 'pong' }]);
  stop(); await flush();
  assert.equal(hub.last.readyState, 3, 'no remaining demand closes the connection');
});

test('a replacement or revocation is terminal and enforced limits protect the hub', async t => {
  const hub = fakeHub();
  const agent = createAgentHub({ service, token: TOKEN, WebSocket: hub.WebSocket, retryMs: 10 });
  t.after(() => agent.close());
  agent.connect(); hub.last.accept();
  const streams = Array.from({ length: HUB_LIMITS.streams }, () => agent.socket(PAGE, 'setup/watch'));
  assert.throws(() => agent.socket(PAGE, 'setup/watch'), { code: 'hub_stream_limit' });
  assert.equal(new Set(streams.map(stream => stream.stream)).size, HUB_LIMITS.streams);
  hub.last.drop(4000); await flush();
  assert.equal(agent.state, 'replaced');
  assert(streams.every(stream => stream.readyState === 3));
  assert.throws(() => agent.socket(PAGE, 'setup/watch'), { code: 'hub_replaced' });
  const probed = fakeHub();
  const revoked = createAgentHub({ service, token: TOKEN, WebSocket: probed.WebSocket,
    probe: async () => { throw Object.assign(Error('revoked'), { status: 401 }); } });
  revoked.connect(); probed.last.drop(1006); await flush(); await flush();
  assert.equal(revoked.state, 'revoked');
});

test('page sockets route control streams over the hub and keep relay lanes direct with the token', async t => {
  const hub = fakeHub(), direct = [];
  class Socket extends hub.WebSocket {
    constructor(url, protocols) { if (url.includes('/peers/relay')) { super(url, protocols); direct.push({ url, protocols }); hub.connections.pop(); return; } super(url, protocols); }
  }
  const client = createAgentClient({ service, token: TOKEN }, { fetch: async () => Response.json({}), WebSocket: Socket });
  t.after(() => client.close());
  const one = client.page(PAGE, { applicationId: application.id });
  const peerId = 'cd'.repeat(32);
  const watch = one.peers.watchDiscovery(peerId);
  const connection = hub.last; connection.accept();
  assert.deepEqual(connection.frames('open')[0], { t: 'open', s: 1, page: PAGE,
    path: `peers/discovery/watch?peerId=${peerId}`, protocols: [PEER_DISCOVERY_PROTOCOL] });
  connection.push({ t: 'opened', s: 1, protocol: PEER_DISCOVERY_PROTOCOL });
  connection.push({ t: 'data', s: 1, text: '{"type":"ready"}' });
  await watch.ready; watch.close();
  const listener = one.peers.listenInvitations(peerId);
  assert.deepEqual(connection.frames('open')[1].protocols, [PEER_INVITATION_PROTOCOL]);
  listener.close();
  const relay = one.peers.relay('direct:room', peerId, { remotePeerId: 'ef'.repeat(32) });
  assert.equal(direct.length, 2);
  for (const lane of direct) {
    assert(lane.url.startsWith(`wss://service.test/api/agent/pages/${PAGE}/peers/relay?`));
    assert.deepEqual(lane.protocols, [PEER_RELAY_PROTOCOL, TOKEN]);
    assert(!lane.url.includes(TOKEN));
  }
  relay.close?.();
});

test('setup notices arrive over a hub stream and access failures are diagnosed with the agent credential', async t => {
  const hub = fakeHub(), probes = [];
  const client = createAgentClient({ service, token: TOKEN }, { WebSocket: hub.WebSocket,
    fetch: async (url, init) => { probes.push({ url, auth: init.headers.Authorization }); return Response.json({ error: { code: 'forbidden', message: 'Grant removed' } }, { status: 403 }); } });
  t.after(() => client.close());
  const notices = [], states = [];
  const watch = watchApplicationSetup({ page: client.page(PAGE), onChange: notice => notices.push(notice), onStatus: status => states.push(status.state) });
  const connection = hub.last; connection.accept();
  assert.equal(connection.frames('open')[0].path, 'setup/watch');
  connection.push({ t: 'opened', s: 1, protocol: 'tendriller.setup.v1' });
  const notice = { type: 'setup', version: 1, assistant: { proposalId: null, approved: false, revision: null } };
  connection.push({ t: 'data', s: 1, text: JSON.stringify(notice) });
  await flush();
  assert.deepEqual(notices, [notice]);
  connection.push({ t: 'closed', s: 1, code: 1006, reason: 'page restarted' });
  await watch.closed;
  assert.deepEqual(probes, [{ url: `${service}/api/agent/pages/${PAGE}/self`, auth: 'Bearer ' + TOKEN }]);
  assert.deepEqual(states, ['connected', 'access_revoked', 'closed']);
});
