import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSourceAdapter } from '../lib/stream-sources/index.mjs';
import { createHostSource, sampleHost } from '../lib/stream-sources/host.mjs';
import { createFileSource } from '../lib/stream-sources/file.mjs';
import { createSshSource } from '../lib/stream-sources/ssh.mjs';
import { Collector, emitHostSamples, validateConfig } from '../lib/stream-collector.mjs';

const api = 'https://tendriller.dev/api/t/aaaaaaaaaaaa', token = 'tp_' + 'a'.repeat(40);
const base = { id: 'source', stream: 'training.metrics', durability: 'durable', interval_ms: 500 };
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tendril-sources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeSsh() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    child.stdout.end();
    queueMicrotask(() => child.emit('close', 0));
    return true;
  };
  const calls = [];
  return { child, calls, launch: (...args) => { calls.push(args); return child; } };
}

test('retained-file replay is explicit and does not come from destination durability', async t => {
  const directory = await temporary(t), path = join(directory, 'metrics.jsonl');
  await writeFile(path, '{"step":1}\n{"step":2}\n');
  const file = createSourceAdapter({ ...base, type: 'jsonl', path });
  const host = createSourceAdapter({ ...base, type: 'host' });
  const ssh = createSourceAdapter({ ...base, type: 'ssh', host: 'trainer', command: ['sampler'] });
  assert.deepEqual(file.capabilities, { mode: 'poll', replay: 'retained-file', checkpoint: true });
  assert.equal(host.capabilities.replay, 'none'); assert.equal(host.capabilities.checkpoint, false);
  assert.equal(ssh.capabilities.replay, 'none'); assert.equal(ssh.capabilities.checkpoint, false);
  assert.equal(ssh.capabilities.mode, 'stream');
  assert.ok(Object.isFrozen(file.capabilities));
  const first = await file.read({ checkpoint: null, maxRecords: 1 });
  const replay = await file.read({ checkpoint: null, maxRecords: 1 });
  assert.deepEqual(replay.records.map(record => record.data), first.records.map(record => record.data), 'an uncommitted checkpoint can be read again');
  const reopened = createSourceAdapter({ ...base, type: 'jsonl', path });
  const second = await reopened.read({ checkpoint: first.checkpoint, maxRecords: 1 });
  assert.equal(second.records[0].data.step, 2, 'the coordinator can pass its persisted checkpoint to a new adapter');
  assert.equal(second.health, 'collecting');
  await Promise.all([file.close(), reopened.close(), host.close(), ssh.close()]);
});

test('host adapters keep sampling counters per instance and report unavailable GPU independently', async () => {
  const previous = [], sampled = { idle: 50, total: 100 };
  const adapter = createHostSource({ ...base, type: 'host', gpu: true }, { sample: async counter => {
    previous.push(counter);
    return { cpu: sampled, sample: { metrics: { cpu_percent: counter ? 50 : null }, gpu_status: 'unavailable', gpus: [] } };
  } });
  const first = await adapter.read({ checkpoint: { untrusted: 'not used for live sampling' } });
  const second = await adapter.read({});
  assert.equal(first.records[0].data.metrics.cpu_percent, null);
  assert.equal(second.records[0].data.metrics.cpu_percent, 50);
  assert.deepEqual(previous, [undefined, sampled]);
  assert.equal(second.health, 'gpu_unavailable');
  assert.equal(Object.hasOwn(second, 'checkpoint'), false);
  await adapter.close();
});

test('GPU sampling distinguishes real zeroes from absent, unsupported and malformed numeric fields', async () => {
  const calls = [];
  const { sample } = await sampleHost(undefined, { gpu: true }, { executeGpu: async (...args) => {
    calls.push(args);
    return { stdout: '0, 0, 0, 1024, 0\n1, 50.5, N/A, [Not Supported], \n2, , invalid, 1e400, [N/A]\n3, 10, 0.5, 2048, -2\n' };
  } });
  assert.equal(calls[0][0], 'nvidia-smi');
  assert.deepEqual(calls[0][1], ['--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits']);
  assert.equal(calls[0][2].timeout, 3000); assert.equal(calls[0][2].maxBuffer, 65536);
  assert.equal(sample.gpu_status, 'available');
  assert.deepEqual(sample.gpus[0], { index: 0, utilization_percent: 0, memory_used_bytes: 0, memory_total_bytes: 1024 ** 3, temperature_c: 0 });
  assert.deepEqual(sample.gpus[1], { index: 1, utilization_percent: 50.5, memory_used_bytes: null, memory_total_bytes: null, temperature_c: null,
    unavailable: { memory_used_bytes: 'not_available', memory_total_bytes: 'not_supported', temperature_c: 'not_reported' } });
  assert.deepEqual(sample.gpus[2], { index: 2, utilization_percent: null, memory_used_bytes: null, memory_total_bytes: null, temperature_c: null,
    unavailable: { utilization_percent: 'not_reported', memory_used_bytes: 'invalid_value', memory_total_bytes: 'invalid_value', temperature_c: 'not_available' } });
  assert.equal(sample.gpus[3].memory_used_bytes, 0.5 * 1024 ** 2);
  assert.equal(sample.gpus[3].temperature_c, -2);
  assert.equal(Number.isFinite(sample.metrics.memory_total_bytes), true);
});

test('GPU command failure or absent devices leaves host measurements available without invented GPU numbers', async () => {
  for (const [executeGpu, reason] of [
    [async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); }, 'query_failed'],
    [async () => ({ stdout: '\n' }), 'no_devices_reported'],
    [async () => ({ stdout: 'unexpected non-CSV output' }), 'query_failed'],
  ]) {
    const { sample } = await sampleHost(undefined, { gpu: true }, { executeGpu });
    assert.equal(sample.gpu_status, 'unavailable');
    assert.equal(sample.gpu_reason, reason);
    assert.deepEqual(sample.gpus, []);
    assert.equal(Number.isFinite(sample.metrics.memory_used_bytes), true);
  }
  const { sample } = await sampleHost(undefined, {}, { executeGpu: () => { throw Error('GPU sampling was not requested'); } });
  assert.equal(Object.hasOwn(sample, 'gpu_status'), false);
});

test('file fingerprints belong to captured records when copytruncate happens immediately after a read', async t => {
  const directory = await temporary(t);
  for (const resume of [false, true]) {
    const path = join(directory, `metrics-${resume}.jsonl`);
    const source = { ...base, type: 'jsonl', path };
    await writeFile(path, '{"step":1}\n{"step":2}\n');
    const checkpoint = resume ? (await createFileSource(source).read({ checkpoint: null, maxRecords: 1 })).checkpoint : null;
    let replaced = false;
    const reader = createFileSource(source, { open: async (...args) => {
      const file = await open(...args);
      return {
        stat: () => file.stat(), close: () => file.close(),
        read: async (...readArgs) => {
          const result = await file.read(...readArgs);
          if (!replaced) {
            replaced = true;
            await writeFile(path, '{"step":101}\n{"step":102}\n{"step":103}\n');
          }
          return result;
        },
      };
    } });
    const captured = await reader.read({ checkpoint });
    assert.deepEqual(captured.records.map(record => record.data.step), resume ? [2] : [1, 2]);
    const next = await createFileSource(source).read({ checkpoint: captured.checkpoint });
    assert.deepEqual(next.records.map(record => record.data.step), [101, 102, 103], 'replacement records before the previous offset must not be skipped');
  }
});

test('sampler cancellation releases a blocked drain wait and its listeners', { timeout: 1000 }, async () => {
  let wrote;
  const firstWrite = new Promise(resolve => { wrote = resolve; });
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { wrote(); } });
  const abort = new AbortController();
  const running = emitHostSamples({ output, signal: abort.signal,
    sample: async () => ({ sample: { metrics: { cpu_percent: 50 } }, cpu: {} }) });
  try {
    await firstWrite;
    assert.equal(output.writableNeedDrain, true);
    abort.abort();
    await running;
    assert.equal(output.listenerCount('drain'), 0);
    assert.equal(output.listenerCount('close'), 0);
    assert.equal(output.listenerCount('error'), 0);
  } finally { output.destroy(); }
});

test('SSH adapter bounds split oversized lines, keeps source identity and releases its one session', async () => {
  const transport = fakeSsh(), abort = new AbortController(), states = [];
  const adapter = createSshSource({ ...base, type: 'ssh', host: 'trainer', command: ['node', '/sampler path/sample.mjs'] }, { spawn: transport.launch });
  const session = adapter.stream({ signal: abort.signal, report: state => states.push(state) });
  const next = session.next();
  transport.child.stdout.write('x'.repeat(33 * 1024));
  transport.child.stdout.write('tail of oversized line\n{"step":7,"loss":0.4}\n');
  const { value } = await next;
  assert.equal(value.records[0].data.source, 'source');
  assert.equal(value.records[0].data.step, 7);
  assert.equal(Object.hasOwn(value, 'checkpoint'), false);
  assert.ok(states.includes('line_too_large'));
  assert.equal(transport.calls.length, 1, 'retry belongs to the coordinator');
  assert.ok(transport.calls[0][1].includes('StrictHostKeyChecking=yes'));
  await session.return();
  await adapter.close();
  assert.deepEqual(transport.child.signals, ['SIGTERM']);
  assert.ok(states.includes('ssh_disconnected_gap'));
});

test('aborting a waiting SSH adapter ends the session without spawning a replacement or claiming replay', async () => {
  const transport = fakeSsh(), abort = new AbortController(), states = [];
  const adapter = createSshSource({ ...base, type: 'ssh', host: 'trainer', command: ['sampler'] }, { spawn: transport.launch });
  const session = adapter.stream({ signal: abort.signal, report: state => states.push(state) });
  const next = session.next();
  abort.abort();
  assert.equal((await next).done, true);
  await adapter.close();
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.child.signals, ['SIGTERM']);
  assert.deepEqual(states, ['ssh_connecting']);
});

test('coordinator reports nonreplayable SSH loss when its spool cannot accept a live record', async t => {
  const directory = await temporary(t), transport = fakeSsh();
  const config = validateConfig({ api, token, spool_dir: directory,
    sources: [{ ...base, type: 'ssh', host: 'trainer', command: ['sampler'] }] });
  const states = [];
  let collector;
  collector = await Collector.open(config, {
    sourceFactory: source => createSshSource(source, { spawn: transport.launch }),
    status: message => { states.push(message.state); if (message.state === 'spool_full_ssh_gap') collector.abort.abort(); },
  });
  collector.spool.maxBytes = 300;
  const streaming = collector.runStream(collector.adapters[0]);
  transport.child.stdout.write('{"value":"' + 'x'.repeat(1000) + '"}\n');
  await streaming;
  assert.ok(states.includes('spool_full_ssh_gap'));
  assert.equal(collector.spool.size, 0);
  assert.equal(collector.spool.checkpoint(base.id), null);
  assert.equal(transport.calls.length, 1);
  await collector.stop();
});
