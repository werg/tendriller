import { createServer } from "node:http";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StreamSpool, SpoolFull } from '../lib/stream-spool.mjs';
import { Collector, validateConfig, recordFor, readFileBatch, sshArguments, parseSampleArguments } from '../lib/stream-collector.mjs';

const api = 'https://tendriller.dev/api/t/aaaaaaaaaaaa';
const token = 'tp_' + 'a'.repeat(40);
const source = { id: 'training', stream: 'training.metrics', durability: 'durable', type: 'jsonl', interval_ms: 500 };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tendril-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const ack = (batch, durability = 'durable') => new Response(JSON.stringify({ records: batch.records.map((r, i) => ({ ...r, seq: i + 1, stream: batch.stream })), cursor: batch.records.length, durability }));

test('durable acknowledgement loss replays the same IDs after restart, with committed file checkpoint', async t => {
  const dir = await fixture(t), path = join(dir, 'metrics.jsonl');
  await writeFile(path, '{"step":1,"loss":0.8}\n{"step":2,"loss":0.6}\n');
  const config = validateConfig({ api, token, spool_dir: join(dir, 'spool'), sources: [{ ...source, path }] });
  const accepted = new Map(), calls = [];
  let loseAck = true;
  const fetch = async (url, options) => {
    const records = JSON.parse(options.body).records;
    calls.push(records.map(r => r.id));
    for (const r of records) accepted.set(r.id, r);
    if (loseAck) { loseAck = false; throw Error('ack lost after commit'); }
    return ack({ stream: source.stream, records });
  };
  let collector = await Collector.open(config, { fetch, status() {} });
  await collector.collectOnce();
  const originalCheckpoint = collector.spool.checkpoint(source.id);
  assert.equal(collector.spool.size, 2);
  assert.equal(await collector.flushOnce(), false);
  await collector.stop();
  collector = await Collector.open(config, { fetch, status() {} });
  await collector.collectOnce();
  assert.equal(collector.spool.size, 2, 'committed input is not reread');
  assert.deepEqual(collector.spool.checkpoint(source.id), originalCheckpoint);
  assert.equal(await collector.flushOnce(), true);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(accepted.size, 2);
  assert.equal(collector.spool.size, 0);
  await collector.stop();
});

test('a full spool preserves the prior checkpoint, so the file resumes without skipping', async t => {
  const dir = await fixture(t), path = join(dir, 'training.log');
  await writeFile(path, 'line one\nline two\n');
  const spool = await StreamSpool.open(dir, { api, token, maxBytes: 400 });
  const batch = await readFileBatch({ ...source, type: 'log', path }, null);
  await assert.rejects(spool.enqueue(source.stream, batch.records, { source: source.id, value: batch.checkpoint }), SpoolFull);
  assert.equal(spool.size, 0);
  assert.equal(spool.checkpoint(source.id), null);
  spool.maxBytes = 65536;
  await spool.enqueue(source.stream, batch.records, { source: source.id, value: batch.checkpoint });
  assert.equal(spool.size, 2);
  assert.equal(spool.checkpoint(source.id).offset, Buffer.byteLength('line one\nline two\n'));
  await spool.close();
});

test('a minimum-size spool fits smaller file batches and drains a larger input without skipping records', async t => {
  const dir = await fixture(t), path = join(dir, 'metrics.jsonl');
  await writeFile(path, Array.from({ length: 100 }, (_, step) => JSON.stringify({ step, label: 'x'.repeat(1000) }) + '\n').join(''));
  const config = validateConfig({ api, token, spool_dir: join(dir, 'spool'), max_spool_bytes: 65536, sources: [{ ...source, path }] });
  const delivered = [], statuses = [];
  const collector = await Collector.open(config, { fetch: async (url, options) => {
    const records = JSON.parse(options.body).records;
    delivered.push(...records);
    return ack({ stream: source.stream, records });
  }, status: message => statuses.push(message.state) });
  try {
    const start = Date.now();
    for (let poll = 0; poll < 10 && delivered.length < 100; poll++) {
      await collector.collectOnce(start + poll * 1000);
      assert.ok(collector.spool.size > 0, 'even an empty 64KiB spool must accept a prefix of this input');
      assert.ok(Buffer.byteLength(await readFile(join(dir, 'spool', 'outbox.json'), 'utf8')) <= 65536);
      assert.equal(await collector.flushOnce(), true);
    }
    assert.deepEqual(delivered.map(record => record.data.step), Array.from({ length: 100 }, (_, step) => step));
    assert.equal(new Set(delivered.map(record => record.id)).size, 100);
    assert.equal(collector.spool.checkpoint(source.id).offset, Buffer.byteLength(await readFile(path)));
    assert.ok(!statuses.includes('spool_full'));
  } finally { await collector.stop(); }
});

test('ephemeral payloads never enter the spool, failed samples are not retried', async t => {
  const dir = await fixture(t), live = { id: 'host', type: 'host', stream: 'machine.utilization', durability: 'ephemeral' };
  const config = validateConfig({ api, token, spool_dir: dir, sources: [live] });
  const uploaded = [];
  const collector = await Collector.open(config, { fetch: async (url, options) => { uploaded.push(options.body); throw Error('offline'); }, status() {} });
  await collector.accept(live, [recordFor(live, 'host', { secretMarker: 'ephemeral-only-payload' })]);
  await collector.flushOnce();
  await collector.flushOnce();
  assert.equal(uploaded.length, 1);
  assert.equal(collector.spool.size, 0);
  assert.equal(collector.live.size, 0);
  for (const file of await readdir(dir)) assert.ok(!(await readFile(join(dir, file), 'utf8')).includes('ephemeral-only-payload'));
  await collector.stop();
});

test('file tails preserve split UTF-8 lines and recover rename and copytruncate rotation', async t => {
  const dir = await fixture(t), path = join(dir, 'training.log'), cfg = { ...source, type: 'log', path };
  const text = Buffer.from('café\nnext line\n');
  await writeFile(path, text.subarray(0, 4));
  let batch = await readFileBatch(cfg, null);
  assert.equal(batch.records.length, 0);
  assert.equal(batch.checkpoint.offset, 0);
  await writeFile(path, text);
  batch = await readFileBatch(cfg, batch.checkpoint);
  assert.deepEqual(batch.records.map(r => r.data.line), ['café', 'next line']);
  let checkpoint = batch.checkpoint;
  await rename(path, path + '.1');
  await writeFile(path, 'new generation\n');
  batch = await readFileBatch(cfg, checkpoint);
  assert.equal(batch.records[0].data.line, 'new generation');
  checkpoint = batch.checkpoint;
  await writeFile(path, 'copytruncated with more bytes than old content\n');
  batch = await readFileBatch(cfg, checkpoint);
  assert.equal(batch.records[0].data.line, 'copytruncated with more bytes than old content');
});

test('invalid and oversized lines produce explicit diagnostics and the following valid line survives', async t => {
  const dir = await fixture(t), path = join(dir, 'metrics.jsonl');
  await writeFile(path, 'not json\n' + 'x'.repeat(200000) + '\n{"loss":0.1}\n');
  const cfg = { ...source, path };
  const first = await readFileBatch(cfg, null);
  const second = await readFileBatch(cfg, first.checkpoint);
  const records = [...first.records, ...second.records];
  assert.deepEqual(records.map(r => r.type), ['collector_error', 'collector_error', 'metrics']);
  assert.equal(records.at(-1).data.loss, 0.1);
});

test('SSH validates hosts, preserves argument boundaries and never invokes a local shell', async () => {
  assert.throws(() => sshArguments({ host: '-oProxyCommand=evil', command: ['node'] }), /SSH host/);
  assert.throws(() => sshArguments({ host: 'host; touch /tmp/x', command: ['node'] }), /SSH host/);
  const args = sshArguments({ host: 'trainer@gpu-box', command: ['node', '/path with spaces/sample.mjs', "a'b", '$(touch bad)'] });
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.deepEqual(args.slice(-3), ['--', 'trainer@gpu-box', "'node' '/path with spaces/sample.mjs' 'a'\\''b' '$(touch bad)'"]);
});

test('configuration rejects source IDs that could modify checkpoint prototypes', () => {
  assert.throws(() => validateConfig({ api, token, sources: [{ ...source, id: '__proto__', path: 'file' }] }), /safe id/);
  assert.throws(() => validateConfig({ api, token, sources: [{ ...source, id: 1, path: 'file' }, { ...source, id: '1', path: 'file' }] }), /safe id/);
  assert.equal(validateConfig({ api, token, sources: [{ ...source, path: 'file' }] }).token, token);
});

test('sample command accepts an omitted interval with GPU flag and rejects ambiguous extras', () => {
  assert.deepEqual(parseSampleArguments([]), { interval: 5000, gpu: false });
  assert.deepEqual(parseSampleArguments(['--gpu']), { interval: 5000, gpu: true });
  assert.deepEqual(parseSampleArguments(['1000', '--gpu']), { interval: 1000, gpu: true });
  assert.deepEqual(parseSampleArguments(['500']), { interval: 500, gpu: false });
  assert.throws(() => parseSampleArguments(['499']), /interval/);
  assert.throws(() => parseSampleArguments(['--unknown']), /Usage/);
  assert.throws(() => parseSampleArguments(['--gpu', '--gpu']), /Usage/);
  assert.throws(() => parseSampleArguments(['1000', '2000']), /Usage/);
});

test('sample mode stops when stdout never drains', async () => {
  const moduleUrl = new URL('../lib/stream-collector.mjs', import.meta.url).href;
  const script = `import { emitHostSamples } from ${JSON.stringify(moduleUrl)};
    process.stdout.write = () => false;
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    await emitHostSamples({ interval: 500, signal: abort.signal });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { assert.equal((await once(child, 'exit'))[0], 0); }
  finally { clearTimeout(timeout); }
});

test('spool ownership rejects competing collectors and credential reuse', async t => {
  const dir = await fixture(t);
  const first = await StreamSpool.open(dir, { api, token });
  await assert.rejects(StreamSpool.open(dir, { api, token }), /Another collector/);
  await first.enqueue(source.stream, [recordFor(source, 'metrics', { loss: 1 })]);
  await first.close();
  await assert.rejects(StreamSpool.open(dir, { api, token: 'tp_' + 'b'.repeat(32) }), /another producer/);
  const reopened = await StreamSpool.open(dir, { api, token });
  assert.equal(reopened.size, 1);
  await reopened.close();
});

test('stale-lock contenders fail closed instead of deleting another restart attempt’s lock', async t => {
  const dir = await fixture(t), path = join(dir, 'collector.lock');
  const spool = await StreamSpool.open(dir, { api, token });
  await spool.enqueue(source.stream, [recordFor(source, 'metrics', { loss: 0.8 })]);
  await spool.close();
  const pending = await readFile(join(dir, 'outbox.json'), 'utf8');
  const stale = JSON.stringify({ pid: 2147483647 });
  await writeFile(path, stale);
  const results = await Promise.allSettled([StreamSpool.open(dir, { api, token }), StreamSpool.open(dir, { api, token })]);
  assert.ok(results.every(result => result.status === 'rejected' && /Stale collector.lock/.test(result.reason.message)));
  assert.equal(await readFile(path, 'utf8'), stale);
  assert.equal(await readFile(join(dir, 'outbox.json'), 'utf8'), pending);
});

test('successful but malformed acknowledgements cannot remove queued durable records', async t => {
  const dir = await fixture(t);
  const config = validateConfig({ api, token, spool_dir: dir, sources: [{ id: 'host', type: 'host', stream: 'machine.history', durability: 'durable' }] });
  const collector = await Collector.open(config, { fetch: async () => new Response('{"records":[],"durability":"durable"}'), status() {} });
  await collector.accept(config.sources[0], [recordFor(config.sources[0], 'host', { value: 7 })]);
  assert.equal(await collector.flushOnce(), false);
  assert.equal(collector.spool.size, 1);
  await collector.stop();
});

test('CLI SIGTERM stops collection and releases the spool without losing pending work', async t => {
  const fixtureServer = createServer((req,res) => { res.setHeader('content-type','application/json'); if(req.url==='/api/service')res.end(JSON.stringify({contract:2,workflows:[]})); else {res.statusCode=503;res.end('{}');} });
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
  t.after(()=>{fixtureServer.closeAllConnections();return new Promise(resolve=>fixtureServer.close(resolve));});
  const api = `http://127.0.0.1:${fixtureServer.address().port}/api/t/aaaaaaaaaaaa`;
  const dir = await fixture(t), config = join(dir, 'collector.json');
  await writeFile(config, JSON.stringify({ api, token, spool_dir: './spool', sources: [{ id: 'host', type: 'host', stream: 'machine.history', durability: 'durable', interval_ms: 500 }] }));
  const child = spawn(process.execPath, ['collector/bin/tendril-stream.mjs', config], { cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  for (let n = 0; n < 100 && !stderr.includes('collecting'); n++) await new Promise(r => setTimeout(r, 20));
  assert.match(stderr, /collecting/);
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const [code] = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(Error('Shutdown timed out')), 3000))]);
  assert.equal(code, 0);
  assert.ok(!stderr.includes(token));
  const spool = await StreamSpool.open(join(dir, 'spool'), { api, token });
  assert.ok(spool.size >= 1);
  await spool.close();
});

test('sample CLI exits on SIGTERM when its stdout pipe is not being drained', { timeout: 5000 }, async t => {
  const dir = await fixture(t), preload = join(dir, 'fill-output.mjs');
  // Fill the real pipe on the first sample without waiting for hundreds of
  // sampling intervals. The parent deliberately never reads child.stdout.
  await writeFile(preload, `const write = process.stdout.write.bind(process.stdout);
process.stdout.write = () => {
  const ready = write('x'.repeat(2 * 1024 * 1024));
  process.stderr.write('sampler-output-blocked\\n');
  return ready;
};\n`);
  const child = spawn(process.execPath, ['--import', preload, 'collector/bin/tendril-stream.mjs', '--sample', '500'],
    { cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); });
  const exited = once(child, 'exit');
  let stderr = '';
  await new Promise(resolve => child.stderr.on('data', chunk => {
    stderr += chunk;
    if (stderr.includes('sampler-output-blocked')) resolve();
  }));
  child.kill('SIGTERM');
  let deadline;
  try {
    const [code, signal] = await Promise.race([exited, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(Error('Sampler remained alive behind blocked stdout')), 1500);
    })]);
    assert.equal(code, 0); assert.equal(signal, null);
  } finally { clearTimeout(deadline); }
});
