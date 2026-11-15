import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import WebSocket from 'ws';

const run = promisify(execFile);
const assets = new URL('../../server/public/', import.meta.url);

test('public helpers run from an empty directory without checkout imports or npm', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tendril-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['tendril-stream', 'tendril-events', 'tendril-preview']) {
    const file = join(dir, `${name}.mjs`);
    await cp(new URL(`${name}.mjs`, assets), file);
    await assert.rejects(run(process.execPath, [file], { cwd: dir }), error => {
      assert.equal(error.code, name === 'tendril-stream' ? 1 : 64);
      assert.match(error.stderr, /usage:/i);
      assert.doesNotMatch(error.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/);
      return true;
    });
  }
});

test('downloaded preview serves embedded assets and fixture transport without npm or remote code fetches', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tendril-preview-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'tendril-preview.mjs'), page = join(dir, 'page');
  await cp(new URL('tendril-preview.mjs', assets), file);
  await mkdir(page);
  await writeFile(join(page, 'index.html'), '<!doctype html><title>Standalone fixture</title>');
  const fixture = join(dir, 'scenario.json');
  await writeFile(fixture, JSON.stringify({ streams: [{ name: 'metrics', durability: 'durable', records: [{ id: 'a', type: 'sample', data: { x: 1 } }] }] }));
  await writeFile(join(dir, 'outside.txt'), 'outside-sentinel');
  await symlink(join(dir, 'outside.txt'), join(page, 'linked.txt'));
  await symlink(dir, join(page, 'linked-directory'));
  const child = spawn(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw Error("unexpected remote fetch")}', file, page, '--fixture', fixture], {
    cwd: dir, env: { ...process.env, NODE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  let stdout = '', stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const { url } = await new Promise((resolve, reject) => {
    child.stdout.on('data', value => { stdout += value; if (stdout.includes('\n')) { try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); } } });
    child.once('error', reject); child.once('exit', () => reject(Error(stderr || 'Preview stopped before printing its URL')));
  });
  assert.match(await (await fetch(url)).text(), /window.__TENDRIL__/);
  for (const [path, source] of [['_tendril/tendril.js', '_tendril/tendril.js'], ['_tendril/sw.js', '_tendril/sw.js'],
    ['_tendril/snippets/chart.js', 'snippets/chart.js'], ['_tendril/snippets/stream-view.js', 'snippets/stream-view.js'],
    ['_tendril/axe.min.js', '_tendril/axe.min.js'], ['_tendril/brand/icon-64.png', '_tendril/brand/icon-64.png']]) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(source, assets)));
  }
  assert.equal((await fetch(url + 'linked.txt')).status, 404);
  assert.equal((await fetch(url + 'linked-directory/outside.txt')).status, 404);
  const latest = await (await fetch(url + '_tendril/streams/metrics/latest')).json();
  assert.equal(latest.record.data.x, 1);
  const ws = new WebSocket(url.replace('http:', 'ws:') + '_tendril/ws');
  await once(ws, 'open');
  const welcome = once(ws, 'message'); ws.send(JSON.stringify({ t: 'hello', device_id: 'download-check' })); await welcome;
  const reply = once(ws, 'message'); ws.send(JSON.stringify({ t: 'stream_subscribe', stream: 'metrics', after: 0, cid: 'test' }));
  assert.equal(JSON.parse(String((await reply)[0])).batch.records[0].data.x, 1);
  ws.close();
  const optional = await fetch(url + '_tendril/tts/index.js');
  assert.equal(optional.status, 404); assert.equal((await optional.json()).error.code, 'preview_unavailable');
  child.kill('SIGTERM'); assert.equal((await exited)[0], 0);
  assert.equal(stderr, '');
  await assert.rejects(run(process.execPath, [file, page, '--headless'], { cwd: dir, env: { ...process.env, NODE_PATH: '' } }), error => {
    assert.equal(error.code, 2); assert.equal(JSON.parse(error.stdout).error, 'playwright_missing'); return true;
  });
});

test('downloaded dashboard setup publishes its complete example and saves private scoped credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tendril-dashboard-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const template = join(dir, 'dashboard');
  await cp(new URL('examples/training-dashboard/', assets), template, { recursive: true });
  const requests = [];
  let base;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    requests.push({ method: req.method, path: req.url, body, authorization: req.headers.authorization });
    const result = req.url === '/api/tendrils' ? { id: 'example', api: base + '/api/t/example', token: 'tk_test_private', page_url: base + '/page/' }
      : req.url.endsWith('/streams') && req.method === 'GET' ? { streams: [] }
      : req.url.endsWith('/producers') && req.method === 'GET' ? { producers: [] }
      : req.url.endsWith('/producers') ? { token: 'tp_test_private' }
      : req.url.endsWith('/files') ? { version: 1 } : {};
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const { stdout, stderr } = await run(process.execPath, [join(template, 'setup.mjs')], { cwd: dir,
    env: { ...process.env, TENDRILLER_SERVICE_BASE: base, TENDRILLER_OWNER: 'owner@example.test', TENDRILLER_DASHBOARD_DIR: join(dir, 'private') } });
  assert.equal(stderr, '');
  assert.match(stdout, /claim.*1 MiB.*8 MiB/);
  assert.doesNotMatch(stdout, /tk_test_private|tp_test_private/);
  const creation = requests.find(request => request.path === '/api/tendrils');
  assert.equal(creation.body.mode, 'dashboard');
  assert.equal(creation.authorization, undefined);
  const publication = requests.find(request => request.path.endsWith('/files'));
  assert.deepEqual(Object.keys(publication.body.files).sort(), ['app.js', 'index.html', 'model.mjs']);
  assert.match(publication.body.files['index.html'], /_tendril\/snippets\/chart\.js/);
  assert.equal(publication.authorization, 'Bearer tk_test_private');
  const config = JSON.parse(await readFile(join(dir, 'private/collector.json'), 'utf8'));
  assert.equal(config.token, 'tp_test_private');
  assert.equal(config.api, base + '/api/t/example');
  assert.equal(config.sources.length, 3);
});
