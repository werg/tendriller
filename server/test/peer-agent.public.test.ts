import { expect, it } from 'vitest';
import { api, apiJson, create, inDO, req } from './helpers';
import { peerApi } from './peer-exchange';

it('creates an independent stable application identity and leaves control explicitly unconfigured', async () => {
  const h = await create();
  expect(h.application.id).toMatch(/^[0-9a-f]{64}$/); expect(h.application.id).not.toContain(h.id);
  expect(await apiJson(h, 'GET', 'application')).toEqual({ selection: h.application, configured: false });
  expect((await peerApi(h, 'control/read')).status).toBe(409);
  await inDO(h.id, t => { t.ctx.abort('Stable identity restart'); }).catch(() => {});
  expect(await apiJson(h, 'GET', 'application')).toEqual({ selection: h.application, configured: false });
  const other = await create(); expect(other.application.id).not.toBe(h.application.id);
});
it.each(['interactive', 'dashboard'])('uses the same owned application contract for %s pages', async mode => {
  const application = { id: '12'.repeat(32) }, h = await create({ application, mode });
  expect(h.application).toEqual(application);
  const setup = (h as unknown as { agent_setup: { application: string; next_step: string } }).agent_setup;
  expect(setup.application).toBe(application.id); expect(setup.next_step).toContain('public Chronolog application session');
  const html = await (await req(h.page_url)).text();
  const configuration = JSON.parse(/window\.__TENDRIL__=(.*?);<\/script>/.exec(html)![1]);
  expect(configuration.application).toEqual(application); expect(configuration).not.toHaveProperty('ws');
});
it('has no hosted application, binary relay, workflow or unsigned code mutation path', async () => {
  const h = await create();
  for (const [method, path] of [['GET', 'events'], ['GET', 'events/socket'], ['GET', 'state'], ['POST', 'application/commands'],
    ['POST', 'streams'], ['POST', 'uploads'], ['GET', 'members'], ['GET', 'records'], ['POST', 'publications'],
    ['POST', 'publications/rollback'], ['POST', 'workflows/module/command'], ['POST', 'wake/probe']])
    expect((await api(h, method, path)).status, path).toBe(404);
  expect((await req(h.page_url + '_tendril/ws', { headers: { Upgrade: 'websocket' } })).status).toBe(404);
  expect(await inDO(h.id, t => ({ sockets: t.ctx.getWebSockets().length,
    tables: t.db.all("SELECT name FROM sqlite_schema WHERE name IN ('state','events','application_changes','record_log_entries','devices','socket_tickets','stream_records','workflow_receipts')") })))
    .toEqual({ sockets: 0, tables: [] });
  expect((await api(h, 'GET', 'peers/bootstrap')).status).toBe(200);
});
it('MCP exposes the same filtered participant and lifecycle contract', async () => {
  const h = await create();
  const rpc = async (method: string, params: unknown = {}) => apiJson(h, 'POST', 'mcp', { jsonrpc: '2.0', id: 1, method, params });
  const initial = (await rpc('initialize')).result;
  expect(initial.capabilities).toEqual({ tools: {} });
  expect(initial.instructions).toContain('applied()'); expect(initial.instructions).toContain('shared()');
  expect(initial.instructions).toContain('Explicit recovery');
  const names = (await rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name);
  expect(names).toEqual(expect.arrayContaining(['peer_application', 'peer_definition', 'discover_peers', 'configure_peer_application',
    'select_peer_generation', 'administer_peer_generation', 'peer_publication', 'publish_peer_publication', 'tendril_info']));
  for (const old of ['read_events', 'say', 'get_state', 'create_timer', 'append_stream', 'write_shared_file']) expect(names).not.toContain(old);
  expect((await rpc('tools/call', { name: 'read_events' })).error.code).toBe(-32602);
  expect((await rpc('events/list')).error.code).toBe(-32601);
});
