import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const script = join(dirname(fileURLToPath(import.meta.url)), '../bin/tendril-watch.mjs');
const token = 'tk_' + 'b'.repeat(32);
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw Error('timed out');
};

async function setup({ refuse = false } = {}) {
  const server = createServer((req, res) => {
    if (req.url === "/api/service") { res.setHeader("content-type","application/json"); res.end(JSON.stringify({contract:2,core_release:"0.2.0-rc.6",workflows:[{id:"sessions",interface_version:"1",schema_version:"1"}]})); return; } res.statusCode = 404; res.end(); });
  const sockets = [], urls = [];
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => protocols.has('tendriller.agent.v2') ? 'tendriller.agent.v2' : false });
  server.on('upgrade', (req, socket, head) => {
    urls.push(req.url);
    if (refuse || !req.headers['sec-websocket-protocol']?.includes(token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => sockets.push(ws));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'tendril-watch-'));
  const file = join(dir, 'page.json');
  writeFileSync(file, JSON.stringify({ api: `http://127.0.0.1:${server.address().port}/api/t/aaaaaaaaaaaa`, token, cursor: 7 }));
  const handle=JSON.parse(readFileSync(file,'utf8'));
  writeFileSync(file+'.events.json',JSON.stringify({version:1,api:handle.api,handled_cursor:7,delivered_cursor:7}));
  const child = spawn(process.execPath, [script, file], { env: { ...process.env, TENDRIL_WATCH_RETRY_MS: '20' } });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  const close = async () => {
    child.kill('SIGKILL'); for (const s of sockets) s.terminate();
    await new Promise((r) => wss.close(r)); server.closeAllConnections(); await new Promise((r) => server.close(r));
  };
  return { child, sockets, urls, out, file, close };
}

test('streams one line per wake, resumes from the stored cursor and reconnects', async () => {
  const t = await setup();
  try {
    await until(() => t.sockets.length === 1);
    assert.match(t.urls[0], /\/api\/t\/aaaaaaaaaaaa\/events\/socket\?after=7$/);
    t.sockets[0].send(JSON.stringify({ t: 'wake', seq: 8 }));
    t.sockets[0].send('not json');
    t.sockets[0].send(JSON.stringify({ t: 'wake', seq: 9 }));
    await until(() => t.out.stdout.split('\n').filter(Boolean).length === 2);
    const wakes=t.out.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(wakes.map(({t,seq})=>({t,seq})),[{t:'wake',seq:8},{t:'wake',seq:9}]);
    assert.ok(wakes.every(event => !Number.isNaN(Date.parse(event.at))));
    await until(() => t.out.stderr.includes('connected, listening'));
    // The agent advances its cursor; a dropped socket reconnects from the new one.
    const handle=JSON.parse(readFileSync(t.file,'utf8')); writeFileSync(t.file+'.events.json',JSON.stringify({version:1,api:handle.api,handled_cursor:9,delivered_cursor:9}));
    t.sockets[0].terminate();
    await until(() => t.sockets.length === 2);
    assert.match(t.urls[1], /after=9$/);
    t.sockets[1].send(JSON.stringify({t:'wake',seq:9})); // duplicate catch-up does not resume twice
    await new Promise(r => setTimeout(r,60));
    assert.equal(t.out.stdout.trim().split('\n').length,2);
    assert.match(t.out.stderr,/socket closed; reconnecting/);
    assert.match(t.out.stderr,/"code":1006/);
    assert.match(t.out.stderr,/reconnected, listening/);
    assert.ok(!t.out.stdout.includes(token) && !t.out.stderr.includes(token));
  } finally { await t.close(); }
});

test('stops with one notice when the socket keeps being refused', async () => {
  const t = await setup({ refuse: true });
  try {
    const code = await new Promise((resolve, reject) => {
      t.child.on('exit', resolve); setTimeout(() => reject(Error('did not stop')), 5000);
    });
    assert.equal(code, 1);
    assert.match(t.out.stdout, /^tendril-watch: stopped at .* socket refused five times/);
    assert.ok(!t.out.stdout.includes(token));
  } finally { await t.close(); }
});

test('reconnect uses the handled checkpoint instead of an advanced read cursor', async () => {
  const t = await setup();
  try {
    await until(() => t.sockets.length === 1);
    const cfg = JSON.parse(readFileSync(t.file, 'utf8'));
    writeFileSync(t.file, JSON.stringify({ ...cfg, cursor: 100 }));
    writeFileSync(t.file + '.events.json', JSON.stringify({ version: 1, api: cfg.api, handled_cursor: 8, delivered_cursor: 9 }));
    t.sockets[0].terminate();
    await until(() => t.sockets.length === 2);
    assert.match(t.urls[1], /after=8$/);
    writeFileSync(t.file + '.events.json', JSON.stringify({ version: 1, api: cfg.api, handled_cursor: 9, delivered_cursor: 9 }));
    t.sockets[1].terminate();
    await until(() => t.sockets.length === 3);
    assert.match(t.urls[2], /after=9$/);
  } finally { await t.close(); }
});

test('a checkpoint from another page stops the watch instead of skipping input', async () => {
  const t = await setup();
  try {
    await until(() => t.sockets.length === 1);
    writeFileSync(t.file + '.events.json', JSON.stringify({ version: 1, api: 'https://other.invalid/api/t/aaaaaaaaaaaa', handled_cursor: 999, delivered_cursor: 999 }));
    const stopped = new Promise(resolve => t.child.on('exit', resolve));
    t.sockets[0].terminate();
    assert.equal(await stopped, 1);
    assert.equal(t.urls.length, 1);
    assert.match(t.out.stdout, /checkpoint belongs to another page API/);
    assert.ok(!t.out.stdout.includes(token));
  } finally { await t.close(); }
});

test('refuses a file without a valid token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tendril-watch-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, JSON.stringify({ api: 'https://tendriller.dev/api/t/aaaaaaaaaaaa', token: 'nope' }));
  const child = spawn(process.execPath, [script, file]);
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  assert.equal(await new Promise((r) => child.on('exit', r)), 1);
  assert.match(stdout, /stopped at .* The file needs the creation response/);
});
