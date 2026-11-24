import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchSession } from '../lib/session.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = process.env.TENDRILLER_TOOLS_TEST_CLI ?? fileURLToPath(new URL('../bin/tendril.mjs', import.meta.url));
const revision = { historyId: 'history', generation: 'generation', index: 1 };
const change = { kind: 'applied', revision, recovery: null };

test('change watches preserve their output and reject an unexplained stream end', async () => {
  const output = [];
  await assert.rejects(watchSession({ session: { async *changes() { yield change; } } }, value => output.push(value)), error => {
    assert.equal(error.code, 'SESSION_WATCH_ENDED');
    assert.deepEqual(error.watch, { mode: 'changes', cursor: null, revision });
    return true;
  });
  assert.deepEqual(output, [change]);
});

test('owner termination retains the exact cause without reporting normal completion', async () => {
  const owner = new AbortController();
  const cause = Object.assign(Error('binding was revoked'), { code: 'SUPERVISOR_BINDING_REVOKED', status: 403 });
  const session = { signal: owner.signal, async *changes() { yield change; owner.abort(cause); } };
  await assert.rejects(watchSession({ mode: 'attach', session }, () => {}), error => {
    assert.equal(error.code, cause.code); assert.equal(error.status, 403);
    assert.match(error.message, /Owner connection lost: binding was revoked/);
    assert.equal(error.watch.revision, revision);
    return true;
  });
});

test('event watches drain a coherent view with backpressure and preserve the last emitted cursor', async () => {
  const stop = new AbortController(), reads = [], output = [];
  let releases = 0, emitted = 0;
  const batches = [
    { revision, events: [{ id: 'one' }], cursor: 'cursor-1', hasMore: true },
    { revision, events: [{ id: 'two' }], cursor: 'cursor-2', hasMore: false },
  ];
  const session = {
    async *changes() { yield change; stop.abort(Object.assign(Error('deadline'), { code: 'invocation_timeout' })); },
    async readView() { return {
      readEvents(options) {
        assert.equal(emitted, reads.length, 'the next batch waits for the preceding write');
        reads.push(options); return batches[reads.length - 1];
      },
      release() { releases++; },
    }; },
  };
  const result = await watchSession({ session }, async value => {
    await new Promise(resolve => setImmediate(resolve)); output.push(value); emitted++;
  }, { signal: stop.signal, events: true, cursor: 'original', topics: ['request'], limit: 1 });
  assert.deepEqual(reads, [
    { cursor: 'original', topics: ['request'], limit: 1 },
    { cursor: 'cursor-1', topics: ['request'], limit: 1 },
  ]);
  assert.deepEqual(output, batches); assert.equal(releases, 1);
  assert.deepEqual(result, { mode: 'events', cursor: 'cursor-2', revision, reason: 'timeout' });
});

test('event watches publish an empty initial cursor but never advance past failed output', async () => {
  const output = [], failure = Object.assign(Error('broken output pipe'), { code: 'EPIPE' });
  let releases = 0, reads = 0;
  const session = { async *changes() { yield change; yield change; }, readView: async () => ({
    readEvents: () => ({ revision, events: reads++ ? [{ id: 'sensitive-payload' }] : [], cursor: reads === 1 ? 'empty' : 'next', hasMore: false }),
    release() { releases++; },
  }) };
  await assert.rejects(watchSession({ session }, value => {
    if (output.length) throw failure; output.push(value);
  }, { events: true }), error => {
    assert.equal(error, failure);
    assert.deepEqual(error.watch, { mode: 'events', cursor: 'empty', revision });
    assert.doesNotMatch(JSON.stringify(error.watch), /sensitive-payload/);
    return true;
  });
  assert.equal(output[0].events.length, 0); assert.equal(output[0].cursor, 'empty');
  assert.equal(releases, 2);
});

test('recovered event cursors fail explicitly without replaying another generation from zero', async () => {
  const reads = [], recovered = Object.assign(Error('cursor recovered'), { code: 'CURSOR_RECOVERED' });
  let released = false;
  const session = { async *changes() { yield { ...change, kind: 'recovery' }; }, readView: async () => ({
    readEvents(options) { reads.push(options); throw recovered; }, release() { released = true; },
  }) };
  await assert.rejects(watchSession({ session }, () => assert.fail('must not emit'), { events: true, cursor: 'old-generation' }), error => {
    assert.equal(error, recovered); assert.equal(error.watch.cursor, 'old-generation'); return true;
  });
  assert.deepEqual(reads, [{ cursor: 'old-generation' }]); assert.equal(released, true);
});

test('stalled pagination fails with its last cursor instead of spinning forever', async () => {
  let released = false;
  const session = { async *changes() { yield change; }, readView: async () => ({
    readEvents: () => ({ revision, events: [], cursor: 'same', hasMore: true }),
    release() { released = true; },
  }) };
  await assert.rejects(watchSession({ session }, () => assert.fail('must not emit'), { events: true, cursor: 'same' }),
    error => error.code === 'EVENT_CURSOR_STALLED' && error.watch.cursor === 'same');
  assert.equal(released, true);
});

test('watch CLI rejects event options without event mode before importing a bootstrap', async () => {
  for (const flags of [['--cursor', 'old'], ['--topics', '[]'], ['--limit', '2'], ['--events', '--limit', '0'], ['--events', '--topics', '{}']]) {
    await assert.rejects(run(process.execPath, [cli, 'watch', '--session', 'missing.mjs', ...flags]),
      error => error.code === 64 && !error.stderr.includes('ERR_MODULE_NOT_FOUND'));
  }
});

test('watch CLI timeout succeeds with progress after cleanup; unexpected end and cleanup errors fail', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tendril-watch-')), module = join(directory, 'session.mjs');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(module, `
export async function attachSession({signal}) {
  return {session:{async *changes(){
    yield {kind:'applied',revision:{generation:'one'},recovery:null};
    if(process.env.FIXTURE_END)return;
    await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }},detach(){if(process.env.FIXTURE_CLEANUP_FAIL)throw Object.assign(Error('detach failed'),{code:'CLEANUP_FAILED'});}};
}`);
  const args = [cli, 'watch', '--session', module, '--mode', 'attach', '--timeout', '1'];
  const result = await run(process.execPath, args);
  assert.deepEqual(JSON.parse(result.stderr), { watch: {
    mode: 'changes', cursor: null, revision: { generation: 'one' }, reason: 'timeout',
  } });
  assert.equal(JSON.parse(result.stdout).kind, 'applied');
  for (const [env, code] of [[{ FIXTURE_END: '1' }, 'SESSION_WATCH_ENDED'], [{ FIXTURE_CLEANUP_FAIL: '1' }, 'CLEANUP_FAILED']]) {
    await assert.rejects(run(process.execPath, args, { env: { ...process.env, ...env } }), error => {
      const result = JSON.parse(error.stderr);
      return error.code === 1 && result.error.code === code && result.watch.revision.generation === 'one';
    });
  }
});

test('failed view release preserves a primary recovery or output failure and its previous cursor', async () => {
  for (const code of ['CURSOR_RECOVERED', 'EPIPE']) {
    const primary = Object.assign(Error(code), { code });
    const cleanup = Object.assign(Error('view release failed'), { code: 'VIEW_RELEASE_FAILED' });
    const owner = new AbortController();
    const session = { signal: owner.signal, async *changes() { yield change; }, readView: async () => ({
      readEvents() {
        if (code === 'CURSOR_RECOVERED') throw primary;
        return { revision, events: [{ id: 'not-delivered' }], cursor: 'next', hasMore: false };
      },
      release() { owner.abort(Object.assign(Error('owner closed'), { code: 'OWNER_UNREACHABLE' })); throw cleanup; },
    }) };
    await assert.rejects(watchSession({ mode: 'attach', session }, () => { throw primary; }, {
      events: true, cursor: 'previous',
    }), error => {
      assert.equal(error, primary); assert.equal(error.cleanupError, cleanup);
      assert.deepEqual(error.watch, { mode: 'events', cursor: 'previous', revision: null });
      return true;
    });
  }
});

test('a failed view release during cancellation remains a failure with both causes', async () => {
  const stop = new AbortController(), interrupted = Object.assign(Error('interrupted'), { code: 'invocation_interrupted' });
  const cleanup = Object.assign(Error('view release failed'), { code: 'VIEW_RELEASE_FAILED' });
  const session = { async *changes() { yield change; }, readView: async () => ({
    readEvents() { stop.abort(interrupted); throw interrupted; },
    release() { throw cleanup; },
  }) };
  await assert.rejects(watchSession({ session }, () => assert.fail('must not emit'), {
    signal: stop.signal, events: true, cursor: 'previous',
  }), error => error === interrupted && error.cleanupError === cleanup && error.watch.cursor === 'previous');
});

test('event watch CLI timeout cannot hide failed view cleanup or its primary read failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tendril-watch-release-')), module = join(directory, 'session.mjs');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(module, `
export async function attachSession({signal}) {
  return {session:{async *changes(){yield {kind:'applied',revision:{generation:'one'},recovery:null};},
    readView:async()=>({
      readEvents:()=>new Promise((resolve,reject)=>{
        const aborted=()=>process.env.FIXTURE_ABORT_READ_FAILURE ? reject(signal.reason)
          : resolve({revision:{generation:'one'},events:[],cursor:'next',hasMore:false});
        if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});
      }),
      release(){throw Object.assign(Error('view release failed'),{code:'VIEW_RELEASE_FAILED'});}
    })},detach(){}};
}`);
  const args = [cli, 'watch', '--events', '--cursor', 'previous', '--session', module, '--mode', 'attach', '--timeout', '1'];
  for (const readFails of [false, true]) {
    await assert.rejects(run(process.execPath, args, { env: { ...process.env, FIXTURE_ABORT_READ_FAILURE: readFails ? '1' : '' } }), error => {
      const result = JSON.parse(error.stderr);
      assert.equal(error.code, 1);
      assert.equal(result.error.code, readFails ? 'invocation_timeout' : 'VIEW_RELEASE_FAILED');
      assert.equal(result.watch.cursor, readFails ? 'previous' : 'next');
      if (readFails) assert.equal(result.cleanup.code, 'VIEW_RELEASE_FAILED');
      return true;
    });
  }
});
