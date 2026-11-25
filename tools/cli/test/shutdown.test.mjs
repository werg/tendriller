import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const cli = fileURLToPath(new URL('./support/run-cli.mjs', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tendril-cli-shutdown-')), sockets = new Set();
  let closeFrames = 0;
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    // Deliberately keep TCP open and never answer the client's WebSocket close.
    socket.on('data', bytes => { if ((bytes[0] & 15) === 8) closeFrames++; });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const session = join(directory, 'session.mjs'), cleanup = join(directory, 'cleanup.json'), calls = join(directory, 'calls.jsonl');
  await mkdir(join(directory, 'page')); await writeFile(join(directory, 'page/index.html'), '<!doctype html><p>Fixture</p>');
  await writeFile(session, `
import { writeFile, appendFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
export async function attach({ signal, page }) {
  if (page !== 'fixture') throw Error('Expected the named page');
  const socket = new WebSocket('ws://127.0.0.1:${server.address().port}');
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const record = value => appendFile(${JSON.stringify(calls)}, JSON.stringify(value)+'\\n');
  const saved = { status:'saved', operationId:'stable-op', attemptId:'signed-original' };
  const lost = () => Object.assign(Error(process.env.LARGE_ERROR ? 'x'.repeat(1024*1024) : 'Reply lost'), { code:'ACK_LOST',
    ...(process.env.FIXTURE_ERROR_EXIT === undefined ? {} : {exit:JSON.parse(process.env.FIXTURE_ERROR_EXIT)}) });
  return { session: {
    query: async () => { if (process.env.LARGE_ERROR) throw lost(); return {value:process.env.LARGE_RESULT ? 'x'.repeat(1024*1024) : 'ready'}; },
    command: async (_name, _input, options) => { await record({command:options.operationId}); return { applied:async()=>{throw lost();} }; },
    operations: { get:async()=>saved },
    async *changes() {
      yield {watch:'started'};
      await new Promise((resolve,reject) => { if(signal.aborted) reject(signal.reason); else signal.addEventListener('abort',()=>reject(signal.reason),{once:true}); });
    }
  }, control: {
    preparePublication:async ({operationId})=>{await record({prepare:operationId});return {id:'signed-publication'};},
    publish:async ()=>{await record({publish:'signed-publication'});if(process.env.COMMITTED)return {publication:{id:'signed-publication'},version:7};throw lost();}
  }, async detach() {
    await delay(60); socket.close(1000);
    await writeFile(${JSON.stringify(cleanup)}, JSON.stringify({finished:true,readyState:socket.readyState}));
    if(process.env.CLOSE_FAIL)throw Object.assign(Error('Cleanup failed'),{code:'CLOSE_FAILED'});
  }};
}`);
  function start(args, variables = {}, pause = []) {
    const child = spawn(process.execPath, [cli, '--fixture', session, ...args, '--page', 'fixture'], {
      cwd: directory, env: { ...process.env, ...variables }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    for (const stream of pause) child[stream].pause();
    const exited = once(child, 'exit'), closed = once(child, 'close');
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    return { child, async exit() {
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
      try { const [code, signal] = await exited; assert.equal(signal, null, 'CLI must exit itself after settled cleanup, without waiting for the WebSocket close timeout'); return code; }
      finally { clearTimeout(timer); }
    }, async result() { const code = await this.exit(); for (const stream of pause) child[stream].resume(); await closed; return { code, stdout, stderr }; },
    output: () => ({ stdout, stderr }) };
  }
  return { directory, cleanup, calls, start, closeFrames: () => closeFrames };
}

test('finite owned query exits after awaited cleanup despite an actual half-open closing WebSocket', async t => {
  const f = await fixture(t), result = await f.start(['query', 'items', 'null']).result();
  assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), { value: 'ready' });
  assert.deepEqual(JSON.parse(await readFile(f.cleanup)), { finished: true, readyState: 2 });
  assert.equal(f.closeFrames(), 1);
});

test('uncertain command and secondary cleanup failure retain the original signed operation evidence and exit failure', async t => {
  const f = await fixture(t), result = await f.start(['command', 'addItem', '{}', '--operation', 'stable-op'], { CLOSE_FAIL: '1' }).result();
  const error = JSON.parse(result.stderr); assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(error.error.code, 'ACK_LOST'); assert.equal(error.cleanup.code, 'CLOSE_FAILED');
  assert.deepEqual(error.operation, { status: 'saved', operationId: 'stable-op', attemptId: 'signed-original' });
  assert.deepEqual((await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse), [{ command: 'stable-op' }]);
  assert.equal(JSON.parse(await readFile(f.cleanup)).finished, true);
});

test('cleanup failure after a successful query remains a failure without printing a success result', async t => {
  const f = await fixture(t), result = await f.start(['query', 'items', 'null'], { CLOSE_FAIL: '1' }).result();
  assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).error.code, 'CLOSE_FAILED');
  assert.equal(JSON.parse(await readFile(f.cleanup)).finished, true);
});

test('caught errors normalize zero and invalid exit codes while preserving valid nonzero codes and cleanup evidence', async t => {
  const f = await fixture(t);
  for (const exit of [0, -1, 256, 1.5, '64', 64, 255]) {
    const result = await f.start(['command', 'addItem', '{}', '--operation', 'stable-op'], {
      CLOSE_FAIL: '1', FIXTURE_ERROR_EXIT: JSON.stringify(exit),
    }).result();
    assert.equal(result.code, Number.isInteger(exit) && exit >= 1 && exit <= 255 ? exit : 1);
    const error = JSON.parse(result.stderr);
    assert.equal(error.error.code, 'ACK_LOST'); assert.equal(error.cleanup.code, 'CLOSE_FAILED');
    assert.equal(error.operation.operationId, 'stable-op'); assert.equal(error.operation.attemptId, 'signed-original');
    assert.equal(result.stdout, '');
  }
});

for (const committed of [false, true]) test(`publication ${committed ? 'committed receipt' : 'uncertain intent'} survives cleanup failure without replacement publication`, async t => {
  const f = await fixture(t), result = await f.start(['publish', join(f.directory, 'page'), '--operation', 'release-1'], {
    CLOSE_FAIL: '1', ...(committed ? { COMMITTED: '1' } : {}),
  }).result();
  const error = JSON.parse(result.stderr); assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(error.error.code, committed ? 'CLOSE_FAILED' : 'ACK_LOST');
  assert.equal(error.publication.operationId, 'release-1'); assert.equal(error.publication.publicationId, 'signed-publication');
  assert.equal(error.publication.outcome, committed ? 'committed' : 'unknown');
  if (committed) assert.deepEqual(error.publication.receipt, { publicationId: 'signed-publication', version: 7 });
  else assert.equal(error.cleanup.code, 'CLOSE_FAILED');
  assert.deepEqual((await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse), [{ prepare: 'release-1' }, { publish: 'signed-publication' }]);
});

test('watch stays alive beyond the disposal budget, then awaits cleanup and exits only after interruption', async t => {
  const f = await fixture(t), invocation = f.start(['watch']);
  while (!invocation.output().stdout.includes('started')) { assert.equal(invocation.child.exitCode, null); await delay(10); }
  await delay(1200); assert.equal(invocation.child.exitCode, null); assert.equal(invocation.child.signalCode, null);
  invocation.child.kill('SIGTERM'); const result = await invocation.result();
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stderr).watch.reason, 'interrupted');
  assert.deepEqual(JSON.parse(await readFile(f.cleanup)), { finished: true, readyState: 2 });
});

test('bounded flush preserves complete large stdout and primary stderr through temporary pipe backpressure', async t => {
  const f = await fixture(t);
  for (const [variables, stream] of [[{ LARGE_RESULT: '1' }, 'stdout'], [{ LARGE_ERROR: '1' }, 'stderr']]) {
    const invocation = f.start(['query', 'items', 'null'], variables, [stream]);
    await delay(250); invocation.child[stream].resume(); const result = await invocation.result();
    assert.equal(result.code, stream === 'stdout' ? 0 : 1);
    const value = JSON.parse(result[stream]);
    assert.equal(stream === 'stdout' ? value.value.length : value.error.message.length, 1024 * 1024);
  }
});

test('a reader that never drains stderr cannot keep a settled failed executable alive', async t => {
  const f = await fixture(t), started = Date.now(), invocation = f.start(['query', 'items', 'null'], { LARGE_ERROR: '1' }, ['stderr']);
  assert.equal(await invocation.exit(), 1);
  assert(Date.now() - started >= 900, 'the bounded flush should be attempted before forced disposal');
  invocation.child.stderr.resume(); await invocation.result();
  assert.equal(JSON.parse(await readFile(f.cleanup)).finished, true);
});

test('closed stdout reports output failure after cleanup instead of crashing or returning success', async t => {
  const f = await fixture(t), invocation = f.start(['query', 'items', 'null']);
  invocation.child.stdout.destroy();
  const result = await invocation.result();
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).error.code, 'EPIPE');
  assert.equal(JSON.parse(await readFile(f.cleanup)).finished, true);
});
