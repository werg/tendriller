import { expect, it } from 'vitest';
import { api, apiJson, create, inDO, req } from './helpers';
import { peerApi } from './peer-exchange';

it('creates an independent stable application identity and leaves authority explicitly unprepared', async () => {
  const h = await create();
  expect(h.application.id).toMatch(/^[0-9a-f]{64}$/); expect(h.application.id).not.toContain(h.id);
  const unprepared = { selection: h.application, configuration: null, publicationAuthority: null, authority: null };
  expect(await apiJson(h, 'GET', 'application')).toEqual(unprepared);
  expect((await peerApi(h, 'publication/read')).status).toBe(409);
  await inDO(h.id, t => { t.ctx.abort('Stable identity restart'); }).catch(() => {});
  expect(await apiJson(h, 'GET', 'application')).toEqual(unprepared);
  const other = await create(); expect(other.application.id).not.toBe(h.application.id);
});
it.each(['interactive', 'dashboard'])('uses the same owned application contract for %s pages', async mode => {
  const application = { id: '12'.repeat(32) }, h = await create({ application, mode });
  expect(h.application).toEqual(application);
  const created = h as unknown as { next_step: string; api: string; claimed: boolean };
  expect(created.api).toBe(`https://tendriller.dev/api/agent/pages/${h.id}`); expect(created.claimed).toBe(false);
  expect(created.next_step).toContain('claims this page and this agent');
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
