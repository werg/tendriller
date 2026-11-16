import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const script = join(dirname(fileURLToPath(import.meta.url)), '../../../dist/claude-channel.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const value = fn(); if (value) return value; await pause(50); } throw Error('Timed out'); }

test('Claude channel attaches the current session, sends count-only wake, reads and acknowledges events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-claude-test-'));
  const id = 'abc234abc234';
  let current = [];
  const http = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer secret_token');
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/events')) {
      const after = Number(url.searchParams.get('after') || 0);
      assert.equal(url.searchParams.get('wait'), '0');
      const events = current.filter(e => e.seq > after);
      response.end(JSON.stringify({ events, cursor: events.at(-1)?.seq || after }));
    } else response.end(JSON.stringify({ agent_delivery: { mode: 'live_socket' } }));
  });
  const wss = new WebSocketServer({ server: http });
  let socket;
  wss.on('connection', ws => { socket = ws; });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const api = `http://localhost:${http.address().port}/api/t/${id}`;
  const handle = join(dir, 'handle.json');
  writeFileSync(handle, JSON.stringify({ id, api, token: 'secret_token', page_url: 'https://example.test/page' }));
  const old = process.env.TENDRIL_CHANNEL_DIR;
  process.env.TENDRIL_CHANNEL_DIR = dir;
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  const notifications = [];
  client.setNotificationHandler(z.object({ method: z.literal('notifications/claude/channel'), params: z.any() }), message => { notifications.push(message.params); });
  const transport = new StdioClientTransport({ command: process.execPath, args: [script], env: { ...process.env, TENDRIL_CHANNEL_DIR: dir } });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'tendriller_attach'));
    const attach = await client.callTool({ name: 'tendriller_attach', arguments: { handle_path: handle } });
    assert.equal(JSON.parse(attach.content[0].text).attached, true);
    current = [{ seq: 1, role: 'owner', type: 'event', wake: false, data: { type: 'telemetry' } }];
    await pause(200);
    assert.equal(notifications.length, 0, 'non-waking owner telemetry must not start an agent turn');
    current.push({ seq: 2, role: 'owner', type: 'instruction', wake: true, data: { text: 'DO_NOT_LEAK_PAGE_TEXT' } });
    socket.send(JSON.stringify({ t: 'wake', seq: 2 }));
    const notice = await until(() => notifications[0]);
    assert.match(notice.content, /1 page event/);
    assert.doesNotMatch(JSON.stringify(notice), /DO_NOT_LEAK_PAGE_TEXT|secret_token/);
    const events = await client.callTool({ name: 'tendriller_events', arguments: { page_id: id } });
    assert.equal(JSON.parse(events.content[0].text).events[1].data.text, 'DO_NOT_LEAK_PAGE_TEXT');
    const ack = await client.callTool({ name: 'tendriller_ack', arguments: { page_id: id, sequence: 2 } });
    assert.equal(JSON.parse(ack.content[0].text).acknowledged, 2);
    await pause(200);
    assert.equal(notifications.length, 1);
    current.push({ seq: 3, role: null, wake: true, by: 'agent_probe', type: 'event', data: { kind: 'delivery_probe', payload: 'SECOND_PRIVATE_EVENT' } });
    socket.send(JSON.stringify({ t: 'wake', seq: 3 }));
    const second = await until(() => notifications[1]);
    assert.match(second.content, /sequence 3/);
    assert.doesNotMatch(JSON.stringify(second), /SECOND_PRIVATE_EVENT/);
    const secondRead = await client.callTool({ name: 'tendriller_events', arguments: { page_id: id } });
    assert.deepEqual(JSON.parse(secondRead.content[0].text).events.map(event => event.seq), [3]);
    const secondAck = await client.callTool({ name: 'tendriller_ack', arguments: { page_id: id, sequence: 3 } });
    assert.equal(JSON.parse(secondAck.content[0].text).acknowledged, 3);
    const detach = await client.callTool({ name: 'tendriller_detach', arguments: { page_id: id } });
    assert.equal(JSON.parse(detach.content[0].text).detached, true);
  } finally {
    await client.close(); socket?.terminate(); await new Promise(resolve => wss.close(resolve)); http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
    if (old === undefined) delete process.env.TENDRIL_CHANNEL_DIR; else process.env.TENDRIL_CHANNEL_DIR = old;
  }
});
