import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initializeCollector } from '../lib/stream-init.mjs';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../bin/tendril-stream.mjs', import.meta.url));
const agent = 'tk_' + 'a'.repeat(32), producerToken = 'tp_' + 'b'.repeat(40);
const info = stream => ({ ...stream, readers: stream.readers ?? 'owner', builtin: false,
  max_records: stream.durability === 'durable' ? stream.max_records ?? 10000 : null,
  max_age_seconds: stream.durability === 'durable' ? stream.max_age_seconds ?? 86400 : null });
const grant = (name, streams) => ({ name, streams, created_at: 1, last_seen: null });
const specification = () => ({ producer: 'machine-a', spool_dir: './spool', streams: [
  { name: 'metrics', durability: 'durable' },
  { name: 'machine', durability: 'ephemeral' },
  { name: 'table', durability: 'durable', max_records: 1, readers: 'page' },
], sources: [
  { id: 'training', type: 'jsonl', stream: 'metrics', path: './metrics.jsonl' },
  { id: 'host', type: 'host', stream: 'machine' },
  { id: 'snapshot', type: 'command', stream: 'table', command: ['never-run-during-init'], cwd: './job', max_line_bytes: 1048576 },
] });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tendril-stream-init-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = { streams: new Map(), producers: new Map(), requests: [], intercept: undefined };
  const server = createServer(async (req, res) => {
    if (req.url === "/api/service") { res.setHeader("content-type","application/json"); res.end(JSON.stringify({contract:2,core_release:"0.2.0-rc.6",workflows:[{id:"sessions",interface_version:"1",schema_version:"1"}]})); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const request = { method: req.method, path: req.url, body, authorization: req.headers.authorization };
    state.requests.push(request);
    const respond = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (await state.intercept?.({ request, res, respond })) return;
    assert.equal(request.authorization, `Bearer ${agent}`);
    if (req.url.endsWith('/streams') && req.method === 'GET') respond({ streams: [...state.streams.values()] });
    else if (req.url.endsWith('/producers') && req.method === 'GET') respond({ producers: [...state.producers.values()] });
    else if (req.url.endsWith('/streams') && req.method === 'POST') { state.streams.set(body.name, info(body)); respond(info(body)); }
    else if (req.url.endsWith('/producers') && req.method === 'POST') {
      const producer = grant(body.name, body.streams);
      state.producers.set(body.name, producer); respond({ producer, token: producerToken });
    } else respond({ error: { code: 'unexpected', message: 'Unexpected request' } }, 400);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const api = `http://127.0.0.1:${server.address().port}/api/t/aaaaaaaaaaaa`;
  const page = join(dir, 'page.json'), streams = join(dir, 'spec', 'streams.json'), out = join(dir, 'private', 'collector.json');
  await mkdir(dirname(streams));
  await writeFile(page, JSON.stringify({ api, token: agent, page_url: 'https://example.invalid/' }), { mode: 0o600 });
  const save = spec => writeFile(streams, JSON.stringify(spec));
  await save(specification());
  const args = ['init', '--page', page, '--streams', streams, '--out', out];
  return { dir, api, page, streams, out, state, save, options: { page, streams, out },
    async cli(arguments_ = args, script = entry) {
      try { return { code: 0, ...await run(process.execPath, [script, ...arguments_], { cwd: dir, env: { ...process.env, NODE_PATH: '' } }) }; }
      catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    },
  };
}

test('init creates scoped private configurations from source and a standalone download', async t => {
  for (const standalone of [false, true]) await t.test(standalone ? 'download without checkout imports' : 'source CLI', async t => {
    const f = await fixture(t);
    f.state.streams.set('metrics', info(specification().streams[0]));
    f.state.streams.set('unrelated', info({ name: 'unrelated', durability: 'durable' }));
    f.state.producers.set('other-machine', grant('other-machine', ['unrelated']));
    let script = entry;
    if (standalone) {
      script = join(f.dir, 'tendril-stream.mjs');
      await cp(new URL('../../../dist/tendril-stream.mjs', import.meta.url), script);
    }
    const result = await f.cli(undefined, script);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /tk_|tp_/);
    const summary = JSON.parse(result.stdout), config = JSON.parse(await readFile(f.out, 'utf8'));
    assert.equal(summary.config_file, f.out); assert.equal(summary.producer, 'machine-a');
    assert.deepEqual(summary.created_streams, ['machine', 'table']); assert.deepEqual(summary.reused_streams, ['metrics']);
    assert.equal(config.api, f.api); assert.equal(config.token, producerToken);
    assert.equal((await stat(f.out)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dirname(f.out)), ['collector.json']);
    assert.equal(config.sources[0].path, join(dirname(f.streams), 'metrics.jsonl'));
    assert.equal(config.sources[2].cwd, join(dirname(f.streams), 'job'));
    assert.equal(config.spool_dir, join(dirname(f.out), 'spool'));
    assert.deepEqual(config.sources.map(source => source.durability), ['durable', 'ephemeral', 'durable']);
    assert.deepEqual(config.sources.map(source => source.max_record_bytes), [65536, 65536, 196608]);
    assert.equal(config.sources[2].max_line_bytes, 1048576);
    assert.deepEqual(f.state.requests.slice(0, 2).map(request => request.method), ['GET', 'GET']);
    assert.deepEqual(f.state.requests.at(-1).body, { name: 'machine-a', streams: ['metrics', 'machine', 'table'] });
    assert.ok(f.state.requests.every(request => request.path.startsWith('/api/t/aaaaaaaaaaaa/')));
    assert.ok(f.state.requests.every(request => request.method !== 'DELETE'));
  });
});

test('init accepts the page handle saved by the dashboard setup script', async t => {
  const f = await fixture(t);
  await writeFile(f.page, JSON.stringify({ owner: 'owner@example.com', service: 'http://127.0.0.1',
    handle: { api: f.api, token: agent }, producer: 'existing-dashboard-producer' }), { mode: 0o600 });
  const result = await f.cli();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(f.out, 'utf8')).token, producerToken);
});

test('invalid specs and source/policy mismatches fail before any HTTP request', async t => {
  const f = await fixture(t);
  const cases = [
    spec => { spec.extra = true; },
    spec => { spec.producer = 'Not a name'; },
    spec => { spec.streams.push(spec.streams[0]); },
    spec => { spec.streams[1].max_records = 1; },
    spec => { spec.streams[0].name = 'system.events'; },
    spec => { spec.sources[0].stream = 'missing'; },
    spec => { spec.sources.pop(); },
    spec => { spec.sources[1].id = 'training'; },
    spec => { spec.sources[0].durability = 'ephemeral'; },
    spec => { spec.sources[2].command = 'shell text'; },
    spec => { spec.sources[0].max_record_bytes = 70000; },
    spec => { spec.sources[2].max_record_bytes = 196609; },
    spec => { spec.sources[2].fields = { source: ['secret'] }; },
    spec => { spec.spool_dir = ''; },
  ];
  for (const change of cases) {
    const spec = specification(); change(spec); await f.save(spec);
    await assert.rejects(initializeCollector(f.options));
  }
  assert.deepEqual(f.state.requests, []);
  await assert.rejects(readFile(f.out), { code: 'ENOENT' });
});

test('existing files, dangling symlinks and unwritable destinations fail without API writes', async t => {
  const f = await fixture(t);
  await mkdir(dirname(f.out));
  await writeFile(f.out, 'keep-me');
  await assert.rejects(initializeCollector(f.options), /Output already exists/);
  assert.equal(await readFile(f.out, 'utf8'), 'keep-me');
  await rm(f.out); await symlink(join(f.dir, 'missing'), f.out);
  await assert.rejects(initializeCollector(f.options), /Output already exists/);
  const blocker = join(f.dir, 'not-a-directory'); await writeFile(blocker, 'keep-me');
  await assert.rejects(initializeCollector({ ...f.options, out: join(blocker, 'collector.json') }));
  assert.deepEqual(f.state.requests, []);
});

test('all existing stream policies and producer names are checked before creating anything', async t => {
  const f = await fixture(t);
  for (const difference of [{ readers: 'page' }, { max_records: 2 }, { max_age_seconds: 30 },
    { durability: 'ephemeral', max_records: null, max_age_seconds: null }, { builtin: true }]) {
    f.state.streams.set('metrics', { ...info(specification().streams[0]), ...difference });
    await assert.rejects(initializeCollector(f.options), /different policy/);
  }
  f.state.streams.clear();
  f.state.producers.set('machine-a', grant('machine-a', ['metrics', 'machine', 'table']));
  await assert.rejects(initializeCollector(f.options), /already exists.*Nothing was revoked/);
  assert.ok(f.state.requests.every(request => request.method === 'GET'));
  assert.deepEqual(await readdir(dirname(f.out)), []);
});

test('init errors never echo private JSON or upstream bodies and flags are strict', async t => {
  const f = await fixture(t);
  for (const args of [['init'], ['init', '--page', f.page, '--streams', f.streams, '--out', f.out, '--out', 'another'],
    ['init', '--page', f.page, '--streams', f.streams, '--out', f.out, '--force']]) {
    const result = await f.cli(args); assert.equal(result.code, 1); assert.match(result.stderr, /Usage:/);
  }
  await writeFile(f.page, `{"token":"${agent}", broken`);
  let result = await f.cli();
  assert.equal(result.code, 1); assert.doesNotMatch(result.stderr, /tk_|broken/); assert.equal(result.stdout, '');
  await writeFile(f.page, JSON.stringify({ api: f.api, token: agent }));
  f.state.intercept = ({ respond }) => {
    respond({ error: { code: agent, message: `${agent} ${producerToken} server-secret` } }, 403); return true;
  };
  result = await f.cli();
  assert.equal(result.code, 1); assert.match(result.stderr, /HTTP 403/);
  assert.doesNotMatch(result.stdout + result.stderr, /tk_|tp_|server-secret/);
  assert.equal(f.state.requests.length, 1);
});

test('invalid page handles are rejected locally without sending their credentials', async t => {
  const f = await fixture(t);
  for (const handle of [
    { api: f.api, token: producerToken },
    { api: f.api + '?private=value', token: agent },
    { api: f.api + '#fragment', token: agent },
    { api: f.api.replace('127.0.0.1', 'user:password@127.0.0.1'), token: agent },
    { api: 'http://example.invalid/api/t/aaaaaaaaaaaa', token: agent },
  ]) {
    await writeFile(f.page, JSON.stringify(handle));
    await assert.rejects(initializeCollector(f.options));
  }
  assert.deepEqual(f.state.requests, []);
});

test('init never follows redirects with an administrative credential', async t => {
  const f = await fixture(t);
  f.state.intercept = ({ res }) => {
    res.writeHead(307, { location: '/capture-credential' }); res.end(); return true;
  };
  const result = await f.cli();
  assert.equal(result.code, 1); assert.match(result.stderr, /request failed or timed out/);
  assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /tk_|tp_/);
  assert.equal(f.state.requests.length, 1);
  assert.ok(f.state.requests[0].path.endsWith('/streams'));
  assert.deepEqual(await readdir(dirname(f.out)), []);
});

test('lost producer response leaves explicit partial setup and a retry never rotates credentials', async t => {
  const f = await fixture(t);
  f.state.intercept = ({ request, res }) => {
    if (request.method === 'POST' && request.path.endsWith('/producers')) {
      f.state.producers.set(request.body.name, grant(request.body.name, request.body.streams));
      res.destroy(); return true;
    }
  };
  let result = await f.cli();
  assert.equal(result.code, 1); assert.match(result.stderr, /may have completed.*No resources were rolled back/);
  assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /tk_|tp_/);
  assert.equal(f.state.streams.size, 3); assert.equal(f.state.producers.size, 1);
  assert.deepEqual(await readdir(dirname(f.out)), []);
  f.state.intercept = undefined;
  const previous = f.state.requests.length; result = await f.cli();
  assert.equal(result.code, 1); assert.match(result.stderr, /already exists/);
  assert.deepEqual(f.state.requests.slice(previous).map(request => request.method), ['GET', 'GET']);
});

test('an output race never overwrites a file and preserves the complete one-time credential privately', async t => {
  const f = await fixture(t);
  f.state.intercept = async ({ request }) => {
    if (request.method === 'POST' && request.path.endsWith('/producers')) await writeFile(f.out, 'concurrent-owner');
  };
  const result = await f.cli();
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /Complete private recovery configuration retained/);
  assert.doesNotMatch(result.stderr, /tk_|tp_/);
  assert.equal(await readFile(f.out, 'utf8'), 'concurrent-owner');
  const temporary = (await readdir(dirname(f.out))).find(name => name.endsWith('.tmp'));
  const recovery = join(dirname(f.out), temporary);
  assert.equal(JSON.parse(await readFile(recovery, 'utf8')).token, producerToken);
  assert.equal((await stat(recovery)).mode & 0o777, 0o600);
  assert.ok(result.stderr.includes(recovery));
  assert.equal(f.state.producers.size, 1);
  assert.ok(f.state.requests.every(request => request.method !== 'DELETE'));
});

test('a mismatched create response stops before producer creation and reports partial setup', async t => {
  const f = await fixture(t);
  f.state.intercept = ({ request, respond }) => {
    if (request.method === 'POST' && request.path.endsWith('/streams')) {
      const created = { ...info(request.body), readers: 'page' };
      f.state.streams.set(created.name, created); respond(created); return true;
    }
  };
  const result = await f.cli();
  assert.equal(result.code, 1); assert.match(result.stderr, /different policy.*setup may be partial/);
  assert.equal(f.state.streams.size, 1); assert.equal(f.state.producers.size, 0);
  await assert.rejects(readFile(f.out), { code: 'ENOENT' });
});
