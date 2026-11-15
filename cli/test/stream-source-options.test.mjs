import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLineDecoder, lineRecord } from '../lib/stream-sources/records.mjs';
import { createCommandSource } from '../lib/stream-sources/command.mjs';
import { Collector, readFileBatch, validateConfig } from '../lib/stream-collector.mjs';

const api = 'https://tendriller.dev/api/t/aaaaaaaaaaaa', token = 'tp_' + 'a'.repeat(40);
const base = { id: 'training', stream: 'training.metrics', durability: 'durable', interval_ms: 500, run: 'experiment' };
const fileSource = { ...base, type: 'jsonl', path: 'train.jsonl' };
const command = (script, extra = {}) => ({ ...base, type: 'command', command: [process.execPath, '-e', script], ...extra });
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'tendril-source-options-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('source projection validates bounded literal paths and cannot overwrite source identity', () => {
  const config = source => validateConfig({ api, token, sources: [source] }, '/work');
  for (const max_line_bytes of [0, 1023, 1048577, Infinity, '65536'])
    assert.throws(() => config({ ...fileSource, max_line_bytes }), /max_line_bytes/);
  for (const fields of [{}, { source: ['id'] }, { run: ['id'] }, { loss: 'train.loss' }, { loss: [] }, { loss: ['__proto__'] }, { loss: [-1] }])
    assert.throws(() => config({ ...fileSource, fields }), /fields/);
  assert.equal(config({ ...fileSource, max_line_bytes: 1048576 }).sources[0].max_line_bytes, 1048576);
  const source = { ...base, fields: { loss: ['metrics', 'train/loss'], value: ['rows', 0, 'value'], missing: ['absent'], nullable: ['nullable'] } };
  const record = lineRecord(source, JSON.stringify({ ts: 123, type: 'training', data: {
    metrics: { 'train/loss': 0.25 }, rows: [{ value: 'café' }], nullable: null, unwanted: 'large private detail', source: 'forged', run: 'forged',
  } }));
  assert.equal(record.ts, 123); assert.equal(record.type, 'training');
  assert.deepEqual(record.data, { loss: 0.25, value: 'café', nullable: null, source: base.id, run: base.run });
  assert.equal(lineRecord(source, 'not json').data.reason, 'invalid_json');
  assert.deepEqual(lineRecord(source, '{"type":"collector_error","data":{"secret":"not selected"}}').data,
    { source: base.id, run: base.run }, 'input type names cannot bypass configured field selection');
  const local = config(command('console.log("{}")', { cwd: './tools' })).sources[0];
  assert.equal(local.cwd, '/work/tools'); assert.equal(local.timeout_ms, 10000);
  for (const timeout_ms of [99, 300001, '500']) assert.throws(() => config(command('', { timeout_ms })), /timeout_ms|command/);
});

test('wide JSONL is projected before the record limit and checkpoints survive partial large lines', async t => {
  const path = join(await directory(t), 'train.jsonl');
  const line = JSON.stringify({ ts: 99, data: { step: 7, 'train.loss': 0.4, debug: 'x'.repeat(200000) } });
  const source = { ...fileSource, path, max_line_bytes: 262144, fields: { step: ['step'], loss: ['train.loss'] } };
  await writeFile(path, line.slice(0, 150000));
  const partial = await readFileBatch(source, null);
  assert.equal(partial.records.length, 0); assert.equal(partial.checkpoint.offset, 0);
  await writeFile(path, line + '\n{"step":8}\n');
  const first = await readFileBatch(source, partial.checkpoint, 1);
  assert.deepEqual(first.records[0].data, { step: 7, loss: 0.4, source: base.id, run: base.run });
  assert.equal(first.records[0].ts, 99); assert.equal(first.checkpoint.offset, Buffer.byteLength(line + '\n'));
  const second = await readFileBatch(source, first.checkpoint);
  assert.equal(second.records[0].data.step, 8);
  const unprojected = await readFileBatch({ ...source, fields: undefined }, null);
  assert.equal(unprojected.records[0].data.reason, 'record_too_large');
  const defaultLimit = await readFileBatch({ ...source, max_line_bytes: undefined }, null);
  assert.equal(defaultLimit.records[0].data.reason, 'line_too_large');
});

test('shared stdout decoder bounds split lines, preserves UTF-8 and projects large input', () => {
  const states = [], decoder = createLineDecoder({ ...base, max_line_bytes: 262144, fields: { label: ['label'] } }, state => states.push(state));
  const bytes = Buffer.from(JSON.stringify({ label: 'café', wide: 'x'.repeat(200000) }) + '\n');
  const accent = bytes.indexOf(Buffer.from('é'));
  const records = [...decoder.push(bytes.subarray(0, accent + 1)), ...decoder.push(bytes.subarray(accent + 1, 150000)), ...decoder.push(bytes.subarray(150000))];
  assert.equal(records[0].data.label, 'café'); assert.deepEqual(states, []);
  const bounded = createLineDecoder(base, state => states.push(state));
  assert.deepEqual([...bounded.push(Buffer.from('x'.repeat(40000)))], []);
  assert.deepEqual([...bounded.push(Buffer.from('x'.repeat(40000)))], []);
  const recovered = [...bounded.push(Buffer.from('\n{"step":9}\n'))];
  assert.equal(recovered[0].data.step, 9); assert.deepEqual(states, ['line_too_large']);
  assert.deepEqual([...bounded.push(Buffer.from('{"step":10}'))], []);
  assert.equal([...bounded.finish()][0].data.step, 10);
});

test('periodic local commands preserve argv, project snapshots, and accept final unterminated JSON', async () => {
  const adapter = createCommandSource(command('process.stdout.write(JSON.stringify({argument:process.argv[1],rows:[{pid:7,cpu:3.5}],wide:"x".repeat(80000)}))', {
    command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({argument:process.argv[1],rows:[{pid:7,cpu:3.5}],wide:"x".repeat(80000)}))', 'literal $(touch unwanted)'],
    max_line_bytes: 262144, fields: { argument: ['argument'], processes: ['rows'] },
  }));
  try {
    const batch = await adapter.read({ signal: new AbortController().signal });
    assert.equal(batch.records.length, 1);
    assert.equal(batch.records[0].data.argument, 'literal $(touch unwanted)');
    assert.deepEqual(batch.records[0].data.processes, [{ pid: 7, cpu: 3.5 }]);
    assert.equal(batch.records[0].data.wide, undefined);
    assert.deepEqual(adapter.capabilities, { mode: 'poll', replay: 'none', checkpoint: false });
    assert.equal(Object.hasOwn(batch, 'checkpoint'), false);
  } finally { await adapter.close(); }
});

test('failed, oversized and timed-out commands never publish a partial snapshot', { timeout: 5000 }, async () => {
  for (const [source, code] of [
    [command('console.log("{\\"step\\":1}");process.exit(2)'), 'command_failed'],
    [command('process.stdout.write("x".repeat(1048577))'), 'command_output_too_large'],
    [command('for(let i=0;i<101;i++)console.log(JSON.stringify({step:i}))'), 'command_output_too_large'],
    [command('console.log("{\\"step\\":1}");setInterval(()=>{},1000)', { timeout_ms: 100 }), 'command_timeout'],
    [{ ...base, type: 'command', command: ['/definitely/missing/tendril-command'] }, 'command_unavailable'],
  ]) {
    const adapter = createCommandSource(source);
    try { await assert.rejects(adapter.read({}), error => error.code === code); }
    finally { await adapter.close(); }
  }
});

test('closing a waiting local command releases its process and an aborted read never starts one', { timeout: 3000 }, async () => {
  const adapter = createCommandSource(command('setInterval(()=>{},1000)'));
  const pending = adapter.read({});
  const rejected = assert.rejects(pending, error => error.code === 'command_cancelled');
  await adapter.close(); await rejected;
  const abort = new AbortController(); abort.abort();
  await assert.rejects(adapter.read({ signal: abort.signal }), error => error.code === 'command_cancelled');
});

test('timeout and shutdown stay bounded when a descendant inherits stdout after its parent exits', { timeout: 15000 }, async t => {
  const root = await directory(t);
  for (const mode of ['timeout', 'close']) {
    const pidFile = join(root, `${mode}.pid`), marker = join(root, `${mode}.alive`);
    // This finite fixture ignores SIGTERM so group cleanup must also stop a
    // remaining descendant, not merely close our copy of its stdout pipe.
    const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),3500);setTimeout(()=>process.exit(0),5000)`;
    const script = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','ignore']});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.exit(0)`;
    const adapter = createCommandSource(command(script, { timeout_ms: mode === 'timeout' ? 1000 : 5000 }));
    const start = Date.now(), pending = adapter.read({});
    const rejected = assert.rejects(pending, error => error.code === (mode === 'timeout' ? 'command_timeout' : 'command_cancelled'));
    try {
      for (let n = 0; n < 200 && !existsSync(pidFile); n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(existsSync(pidFile), true, 'the descendant fixture started');
      if (mode === 'close') await adapter.close();
      await rejected;
      assert.ok(Date.now() - start < 3000, 'an inherited pipe cannot extend the command timeout or shutdown');
      if (process.platform !== 'win32') {
        await new Promise(resolve => setTimeout(resolve, 3600));
        assert.equal(existsSync(marker), false, 'cancelled command descendants cannot keep running in the process group');
      }
    } finally {
      // Windows has no POSIX process group; its descendant cleanup is owned by
      // the command. Keep this fixture bounded and clean it up on every platform.
      if (existsSync(pidFile)) { try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch {} }
      await adapter.close();
    }
  }
});

test('concurrent polled sources serialize durable writes and each source has only one active read', async t => {
  const spool_dir = await directory(t);
  const sources = [{ ...base, id: 'slow', type: 'host' }, { ...base, id: 'fast', type: 'host' }];
  let finishSlow, slowCalls = 0, fastCalls = 0;
  const config = validateConfig({ api, token, spool_dir, sources });
  const collector = await Collector.open(config, { status() {}, sourceFactory: source => ({ source,
    capabilities: { mode: 'poll', replay: 'none', checkpoint: false },
    read: async () => {
      if (source.id === 'slow') { slowCalls++; await new Promise(resolve => { finishSlow = resolve; }); }
      else fastCalls++;
      return { records: [lineRecord(source, JSON.stringify({ count: source.id === 'slow' ? slowCalls : fastCalls }))], health: 'collecting' };
    }, failure: () => 'source_error', close() {},
  }) });
  const slow = collector.collectSource(collector.adapters[0], 10000);
  await collector.collectSource(collector.adapters[0], 11000);
  await collector.collectSource(collector.adapters[1], 10000);
  await collector.collectSource(collector.adapters[1], 11000);
  assert.equal(slowCalls, 1); assert.equal(fastCalls, 2);
  finishSlow(); await slow; await collector.stop();
  const reopened = await Collector.open(config, { status() {} });
  try {
    assert.equal(reopened.spool.size, 3);
    assert.deepEqual(reopened.spool.batch().records.map(r => [r.data.source, r.data.count]), [['fast', 1], ['fast', 2], ['slow', 1]]);
  } finally { await reopened.stop(); }
});
