import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLineDecoder, lineRecord, recordFor } from '../lib/stream-sources/records.mjs';
import { createCommandSource } from '../lib/stream-sources/command.mjs';
import { Collector, readFileBatch, readLatestFile, validateConfig } from '../lib/stream-collector.mjs';
import { assertValid } from '@tendriller/core/contract';

const api = 'https://tendriller.dev/api/t/aaaaaaaaaaaa', token = 'tp_' + 'a'.repeat(40);
const base = { id: 'training', stream: 'training.metrics', durability: 'durable', interval_ms: 500, run: 'experiment' };
const fileSource = { ...base, type: 'jsonl', path: 'train.jsonl' };
const command = (script, extra = {}) => ({ ...base, type: 'command', command: [process.execPath, '-e', script], ...extra });
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'tendril-source-options-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('latest file source validates format, path and durable policy', () => {
  const latest = { ...base, type:'latest', path:'snapshot.json' };
  const config = source => validateConfig({api,token,sources:[source]},'/work');
  assert.equal(config(latest).sources[0].path,'/work/snapshot.json');
  assert.throws(()=>config({...latest,format:'jsonl'}),/Latest file format/);
  assert.throws(()=>config({...latest,durability:'ephemeral'}),/durable/);
});
test('latest file deduplicates unchanged snapshots by durable digest', async t => {
  const dir = await directory(t), path = join(dir, 'current.json');
  const source = { ...base, type:'latest', path, format:'json', run:undefined };
  await writeFile(path,JSON.stringify({step:1,loss:0.5}));
  const first=await readLatestFile(source,null);
  assert.equal(first.records.length,1);
  assert.deepEqual(first.records[0].data,{step:1,loss:0.5,source:base.id});
  const same=await readLatestFile(source,first.checkpoint);
  assert.deepEqual(same,{records:[],checkpoint:first.checkpoint});
  await writeFile(path,JSON.stringify({step:2,loss:0.25}));
  const second=await readLatestFile(source,first.checkpoint);
  assert.equal(second.records[0].data.step,2);
  assert.notEqual(second.checkpoint.digest,first.checkpoint.digest);
  await writeFile(path,'not JSON');
  const invalid=await readLatestFile(source,second.checkpoint);
  assert.equal(invalid.records[0].data.reason,'invalid_json');
  await writeFile(path,'a'.repeat(40000));
  const oversized=await readLatestFile(source,invalid.checkpoint);
  assert.equal(oversized.records[0].data.reason,'line_too_large');
  assert.deepEqual((await readLatestFile(source,oversized.checkpoint)).records,[]);
  const textSource={...source,format:'text'};
  await writeFile(path,'Current status: ready');
  assert.deepEqual((await readLatestFile(textSource,null)).records[0].data,{value:'Current status: ready',source:base.id});
});
test('source projection validates bounded literal paths and preserves input metadata', () => {
  const config = source => validateConfig({ api, token, sources: [source] }, '/work');
  for (const max_line_bytes of [0, 1023, 1048577, Infinity, '65536'])
    assert.throws(() => config({ ...fileSource, max_line_bytes }), /max_line_bytes/);
  for (const fields of [{}, { source: ['id'] }, { run: ['id'] }, { loss: 'train.loss' }, { loss: [] }, { loss: ['__proto__'] }, { loss: [-1] }])
    assert.throws(() => config({ ...fileSource, fields }), /fields/);
  assert.equal(config({ ...fileSource, max_line_bytes: 1048576 }).sources[0].max_line_bytes, 1048576);
  const source = { ...base, fields: { loss: ['metrics', 'train/loss'], value: ['rows', 0, 'value'], missing: ['absent'], nullable: ['nullable'] } };
  const record = lineRecord(source, JSON.stringify({ ts: 123, type: 'training', data: {
    metrics: { 'train/loss': 0.25 }, rows: [{ value: 'café' }], nullable: null, unwanted: 'large private detail', source: 'worker-a', run: 'run-a',
  } }));
  assert.equal(record.ts, 123); assert.equal(record.type, 'training');
  assert.deepEqual(record.data, { loss: 0.25, value: 'café', nullable: null, source: 'worker-a', run: 'run-a' });
  assert.equal(lineRecord(source, 'not json').data.reason, 'invalid_json');
  assert.deepEqual(lineRecord(source, '{"type":"collector_error","data":{"secret":"not selected"}}').data,
    { source: base.id, run: base.run }, 'input type names cannot bypass configured field selection');
  const local = config(command('console.log("{}")', { cwd: './tools' })).sources[0];
  assert.equal(local.cwd, '/work/tools'); assert.equal(local.timeout_ms, 10000);
  for (const timeout_ms of [99, 300001, '500']) assert.throws(() => config(command('', { timeout_ms })), /timeout_ms|command/);
});

test('raw and wrapped records retain explicit source/run values and use configuration only for absent keys', () => {
  for (const wrap of [data => data, data => ({ ts: 123, type: 'training', data })]) {
    for (const metadata of [
      { source: 'worker-a', run: 'run-1' }, { source: 'worker-b', run: 'run-2' },
      { source: null, run: null }, { source: '', run: '' }, { source: false, run: 0 },
    ]) {
      const record = lineRecord(base, JSON.stringify(wrap({ ...metadata, loss: 0.5 })));
      assert.equal(record.data.source, metadata.source);
      assert.equal(record.data.run, metadata.run);
      assert.equal(record.data.loss, 0.5);
    }
    for (const [metadata, expected] of [
      [{}, { source: base.id, run: base.run }],
      [{ source: 'worker-a' }, { source: 'worker-a', run: base.run }],
      [{ run: 'run-2' }, { source: base.id, run: 'run-2' }],
    ]) {
      const record = lineRecord(base, JSON.stringify(wrap({ ...metadata, loss: 0.5 })));
      assert.equal(record.data.source, expected.source);
      assert.equal(record.data.run, expected.run);
    }
  }
  assert.deepEqual(lineRecord({ ...base, run: undefined }, '7').data, { value: 7, source: base.id });
  assert.deepEqual(lineRecord({ ...base, run: undefined }, '{"run":null,"loss":1}').data,
    {run:null, loss:1, source:base.id});
});

test('projection keeps distinct input runs and sources while collector diagnostics retain configured defaults', () => {
  const source = { ...base, fields: { loss: ['metrics', 'loss'] } };
  const input = [
    { source: 'worker-a', run: 'run-1', metrics: { loss: 0.8 }, unused: 'omit' },
    { source: 'worker-a', run: 'run-2', metrics: { loss: 0.4 }, unused: 'omit' },
    { source: 'worker-b', run: 'run-2', metrics: { loss: 0.2 }, unused: 'omit' },
    { source: null, run: '', metrics: { loss: 0.1 } },
    { metrics: { loss: 0.05 } },
  ];
  for (const wrap of [data => data, data => ({ ts: 123, type: 'training', data })]) {
    const records = input.map(value => lineRecord(source, JSON.stringify(wrap(value))));
    assert.deepEqual(records.map(record => record.data), [
      { source: 'worker-a', run: 'run-1', loss: 0.8 },
      { source: 'worker-a', run: 'run-2', loss: 0.4 },
      { source: 'worker-b', run: 'run-2', loss: 0.2 },
      { source: null, run: '', loss: 0.1 },
      { source: base.id, run: base.run, loss: 0.05 },
    ]);
  }
  const invalid = lineRecord(source, 'not JSON');
  assert.equal(invalid.type, 'collector_error');
  assert.deepEqual(invalid.data, { reason: 'invalid_json', source: base.id, run: base.run });
  const decoder = createLineDecoder({ ...source, max_line_bytes: 262144 });
  const [oversized] = [...decoder.push(Buffer.from(JSON.stringify({
    source: 'worker-a', run: 'run-1', metrics: { loss: 'x'.repeat(70000) },
  }) + '\n'))];
  assert.equal(oversized.type, 'collector_error');
  assert.deepEqual(oversized.data, { reason: 'record_too_large', source: base.id, run: base.run });
});

test('flatten validates explicit bounds and expands selected metric subtrees beyond 64 leaves', () => {
  const config = flatten => validateConfig({ api, token, sources: [{ ...fileSource, flatten }] }, '/work');
  for (const flatten of [null, true, false, [], {}, { max_fields: 0 }, { max_fields: 1025 }, { max_fields: '120' },
    { max_fields: Infinity }, { max_fields: 1.5 }, { max_fields: 120, numeric_only: 'true' }, { max_fields: 120, typo: true }])
    assert.throws(() => config(flatten), /flatten/);
  assert.equal(config({ max_fields: 1024, numeric_only: false }).sources[0].flatten.max_fields, 1024);
  const source = { ...base, fields: { behaviour: ['behaviour'], phase_s: ['phase_s'], gain: ['gain'] },
    flatten: { max_fields: 120, numeric_only: true } };
  const subtree = count => Object.fromEntries(Array.from({ length: count }, (_, i) => ['m' + i, i / 10]));
  const data = { behaviour: subtree(70), phase_s: subtree(30), gain: subtree(20), debug: 'omit', source: 'worker-a', run: 'run-a' };
  for (const wrap of [value => value, value => ({ ts: 123, type: 'training', data: value })]) {
    const record = lineRecord(source, JSON.stringify(wrap(data)));
    assert.equal(Object.keys(record.data).length, 122, 'the two original identity fields do not consume max_fields');
    assert.equal(record.data['behaviour.m69'], 6.9);
    assert.equal(record.data['phase_s.m29'], 2.9);
    assert.equal(record.data['gain.m19'], 1.9);
    assert.equal(record.data.debug, undefined);
    assert.equal(record.data.source, 'worker-a');
    assert.equal(record.data.run, 'run-a');
  }
  const second = lineRecord(source, JSON.stringify({ ...data, source: null, run: '' }));
  assert.equal(second.data.source, null); assert.equal(second.data.run, '');
  assert.equal(Object.keys(data.behaviour).length, 70, 'flattening does not mutate its input');
});

test('flatten escapes dotted paths deterministically, retains JSON leaves, and handles own prototype-named keys safely', () => {
  const data = Object.fromEntries([
    ['a', { b: 1 }], ['a.b', 2], ['a\\b', 3], ['', [4]], ['__proto__', 5], ['constructor', 6],
    ['prototype', 7], ['\\constructor', 8], ['array', [null, true, '8', 9]], ['empty', {}], ['run', 'input-run'], ['source', false],
  ]);
  const source = { ...base, flatten: { max_fields: 12 } };
  const record = lineRecord(source, JSON.stringify(data));
  assertValid('streamInput', record);
  const first = record.data;
  const reordered = lineRecord(source, JSON.stringify(Object.fromEntries(Object.entries(data).reverse()))).data;
  assert.deepEqual(first, reordered);
  assert.deepEqual(Object.keys(first), Object.keys(reordered), 'input insertion order cannot change output order');
  assert.equal(first['a.b'], 1);
  assert.equal(first['a\\.b'], 2);
  assert.equal(first['a\\\\b'], 3);
  assert.equal(first['.0'], 4);
  assert.equal(Object.getPrototypeOf(first), Object.prototype);
  assert.equal(Object.hasOwn(first, '__proto__'), false);
  assert.equal(first['\\__proto__'], 5);
  assert.equal(first['\\constructor'], 6);
  assert.equal(first['\\prototype'], 7);
  assert.equal(first['\\\\constructor'], 8);
  assert.deepEqual([first['array.0'], first['array.1'], first['array.2'], first['array.3']], [null, true, '8', 9]);
  assert.equal(Object.hasOwn(first, 'empty'), false);
  assert.equal(first.run, 'input-run'); assert.equal(first.source, false);
  const numeric = recordFor({ ...source, flatten: { max_fields: 3, numeric_only: true } }, 'metrics',
    { zero: 0, finite: 2.5, text: '3', flag: true, nil: null, infinity: Infinity, nan: NaN, nested: { negative: -1 } }).data;
  assert.deepEqual(numeric, { finite: 2.5, 'nested.negative': -1, zero: 0, source: base.id, run: base.run });
  assert.deepEqual(lineRecord(source, '7').data, { value: 7, source: base.id, run: base.run });
});

test('flatten rejects complete over-limit observations and preserves diagnostic reasons across file and stdout decoding', async t => {
  const path = join(await directory(t), 'train.jsonl');
  const source = { ...fileSource, path, fields: { metrics: ['metrics'] }, flatten: { max_fields: 1, numeric_only: true } };
  const invalid = JSON.stringify({ source: 'input-worker', run: 'input-run', metrics: { a: 1, b: 2 } });
  const valid = JSON.stringify({ metrics: { a: 3 } });
  assert.throws(() => lineRecord(source, invalid), { code: 'flatten_too_many_fields' });
  const lines = invalid + '\n' + valid + '\n';
  await writeFile(path, lines);
  const batch = await readFileBatch(source, null);
  assert.equal(batch.records[0].type, 'collector_error');
  assert.deepEqual(batch.records[0].data, { reason: 'flatten_too_many_fields', offset: 0, source: base.id, run: base.run });
  assert.deepEqual(batch.records[1].data, { 'metrics.a': 3, source: base.id, run: base.run });
  assert.equal(batch.checkpoint.offset, Buffer.byteLength(lines));
  const states = [], decoder = createLineDecoder(source, state => states.push(state));
  const decoded = [...decoder.push(Buffer.from(lines))];
  assert.deepEqual(states, ['flatten_too_many_fields']);
  assert.deepEqual(decoded[0].data, { reason: 'flatten_too_many_fields', source: base.id, run: base.run });
  assert.deepEqual(decoded[1].data, batch.records[1].data);
  assert.equal(lineRecord(source, 'not JSON').data.reason, 'invalid_json');
  assert.deepEqual(lineRecord(source, '{"type":"collector_error","data":{"hidden":"not selected"}}').data,
    { source: base.id, run: base.run }, 'input record types cannot bypass flattening or projection');
  let nested = 1;
  for (let depth = 0; depth < 16; depth++) nested = { x: nested };
  const deepSource = { ...base, flatten: { max_fields: 1 } };
  assert.equal(lineRecord(deepSource, JSON.stringify(nested)).data[Array(16).fill('x').join('.')], 1);
  assert.throws(() => lineRecord(deepSource, JSON.stringify({ x: nested })), { code: 'flatten_too_deep' });
  const depthDecoder = createLineDecoder(deepSource);
  assert.equal([...depthDecoder.push(Buffer.from(JSON.stringify({ x: nested }) + '\n'))][0].data.reason, 'flatten_too_deep');
  const sizeDecoder = createLineDecoder({ ...deepSource, max_line_bytes: 262144 });
  assert.equal([...sizeDecoder.push(Buffer.from(JSON.stringify({ text: 'x'.repeat(70000) }) + '\n'))][0].data.reason, 'record_too_large');
  const local = createCommandSource(command('console.log(JSON.stringify({a:1,b:2}))', { flatten: { max_fields: 1 } }));
  try { await assert.rejects(local.read({}), { code: 'flatten_too_many_fields' }); }
  finally { await local.close(); }
});

test('larger durable snapshots require an explicit output limit and upload one complete record per bounded batch', async t => {
  const root = await directory(t);
  const source = { ...fileSource, path: join(root, 'snapshots.jsonl'), max_line_bytes: 262144, max_record_bytes: 196608 };
  const configFor = value => validateConfig({ api, token, spool_dir: join(root, 'spool'), sources: [value] });
  for (const max_record_bytes of [1023, 196609, '196608', NaN, Infinity, 1.5])
    assert.throws(() => configFor({ ...source, max_record_bytes }), /max_record_bytes/);
  assert.throws(() => configFor({ ...source, type: 'host', durability: 'ephemeral' }), /durable/);
  const config = configFor(source);
  const input = JSON.stringify({ type: 'table', data: { rows: [{ id: 1, text: 'x'.repeat(180000) }] } });
  assert.throws(() => lineRecord({ ...source, max_record_bytes: undefined }, input), { code: 'record_too_large' });
  const records = [lineRecord(source, input), lineRecord(source, input)];
  assert.ok(Buffer.byteLength(JSON.stringify(records[0])) > 128 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(records[0])) <= 196608);
  await writeFile(source.path, input + '\n');
  assert.deepEqual((await readFileBatch(source, null)).records[0].data, records[0].data);
  const uploads = [];
  const collector = await Collector.open(config, {
    status() {},
    fetch: async (_url, options) => {
      assert.ok(Buffer.byteLength(options.body) < 256 * 1024);
      const { records: posted } = JSON.parse(options.body);
      assert.equal(posted.length, 1, 'a snapshot above the preferred batch size still uploads whole and alone');
      uploads.push(posted[0].id);
      return Response.json({ records: posted.map(record => ({ ...record, stream: source.stream })), durability: 'durable' });
    },
  });
  try {
    await collector.accept(config.sources[0], records);
    assert.equal(collector.spool.size, 2);
    assert.equal(await collector.flushOnce(), true);
    assert.equal(collector.spool.size, 1);
    assert.equal(await collector.flushOnce(), true);
    assert.equal(collector.spool.size, 0);
    assert.deepEqual(uploads, records.map(record => record.id));
  } finally { await collector.stop(); }
  const decoder = createLineDecoder(source);
  const [oversized] = [...decoder.push(Buffer.from(JSON.stringify({ text: 'x'.repeat(196608) }) + '\n'))];
  assert.equal(oversized.type, 'collector_error');
  assert.equal(oversized.data.reason, 'record_too_large');
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
