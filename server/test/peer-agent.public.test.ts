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
    ['POST', 'publications/rollback'], ['POST', 'workflows/module/command'], ['POST', 'wake/probe'], ['POST', 'mcp']])
    expect((await api(h, method, path)).status, path).toBe(404);
  expect((await req(h.page_url + '_tendril/ws', { headers: { Upgrade: 'websocket' } })).status).toBe(404);
  expect(await inDO(h.id, t => ({ sockets: t.ctx.getWebSockets().length,
    tables: t.db.all("SELECT name FROM sqlite_schema WHERE name IN ('state','events','application_changes','record_log_entries','devices','socket_tickets','stream_records','workflow_receipts')") })))
    .toEqual({ sockets: 0, tables: [] });
  expect((await api(h, 'GET', 'peers/bootstrap')).status).toBe(200);
});
