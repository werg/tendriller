import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const script = join(dirname(fileURLToPath(import.meta.url)), '../bin/tendril-wait.mjs');
test('background socket wait exits only for a waking event', async () => {
  const token = 'tk_' + 'a'.repeat(32);
  let waking = false, socket;
  const server = createServer((req, res) => {
    if (req.url === "/api/service") { res.setHeader("content-type","application/json"); res.end(JSON.stringify({contract:2,core_release:"0.2.0-rc.6",workflows:[{id:"sessions",interface_version:"1",schema_version:"1"}]})); return; }
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const events = [{ seq: 1, wake: false }, ...(waking ? [{ seq: 2, wake: true }] : [])];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ events, cursor: events.at(-1).seq }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => { socket = ws; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [script], { env: { ...process.env,
    TENDRIL_API: `http://127.0.0.1:${server.address().port}/api/t/aaaaaaaaaaaa`, TENDRIL_TOKEN: token,
  } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    for (let i = 0; i < 100 && !socket; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(socket, stderr);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(stdout, '');
    waking = true;
    socket.send(JSON.stringify({ t: 'wake', seq: 2 }));
    const exit = await Promise.race([
      new Promise((resolve) => child.on('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(Error('wait did not exit')), 3000)),
    ]);
    assert.equal(exit, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).events.map((event) => event.seq), [1, 2]);
  } finally {
    child.kill('SIGKILL'); socket?.terminate(); await new Promise((r) => wss.close(r));
    server.closeAllConnections(); await new Promise((r) => server.close(r));
  }
});
