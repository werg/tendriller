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
const revision = {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"};
const change = { kind: 'materialized', revision, revisedProposalIds: [] };

test('quiet retained owners produce an initial captured event snapshot without waiting for a new operation', async () => {
  const stop = new AbortController(); let subscribed = false, released = 0;
  const session = {
    async *changes({ signal }) { subscribed = true; await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); }); },
    async readView() {
      assert.equal(subscribed, true, 'listen before capture so a concurrent invalidation is not lost');
      return { revision, readEvents: () => ({ revision, events: [{ id: 'retained' }], cursor: 'initial', hasMore: false }), release() { released++; } };
    },
  };
  const output = [];
  await watchSession({ session }, value => { output.push(value); stop.abort(); }, { signal: stop.signal, events: true });
  assert.deepEqual(output, [{ kind: 'snapshot', revision, events: [{ id: 'retained' }], cursor: 'initial', hasMore: false }]);
  assert.equal(released, 1);
});

test('an invalidation during initial output resets the revised snapshot instead of appending arrivals', async () => {
  const stop = new AbortController(), changed = Promise.withResolvers(), nextRevision = { ...revision, digest: 'd'.repeat(64) };
  let captures = 0, releases = 0;
  const session = {
    async *changes({ signal }) { await changed.promise; yield { ...change, revision: nextRevision }; await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); }); },
    async readView() { const current = captures++ ? nextRevision : revision; return { revision: current,
      readEvents: () => ({ revision: current, events: [{ id: current.digest }], cursor: current.digest, hasMore: false }), release() { releases++; } }; },
  };
  const output = [];
  await watchSession({ session }, value => { output.push(value); if (output.length === 1) changed.resolve(); if (output.length === 3) stop.abort(); }, { signal: stop.signal, events: true });
  assert.deepEqual(output.map(value => value.kind), ['snapshot', 'reset', 'snapshot']);
  assert.equal(output[1].cursor, null); assert.equal(output[2].events.length, 1);
  assert.equal(output[2].revision.digest, nextRevision.digest); assert.equal(releases, 2);
});

test('change watches preserve their output and reject an unexplained stream end', async () => {
  const output = [];
  await assert.rejects(watchSession({ session: { async *changes() { yield change; } } }, value => output.push(value)), error => {
    assert.equal(error.code, 'SESSION_WATCH_ENDED');
    assert.deepEqual(error.watch, { mode: 'changes', cursor: null, revision });
    return true;
  });
  assert.deepEqual(output, [{ kind: 'status', status: undefined }, change]);
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
    async readView() { return { revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
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
  assert.deepEqual(output, batches.map(batch => ({ kind: 'snapshot', ...batch }))); assert.equal(releases, 1);
  assert.deepEqual(result, { mode: 'events', cursor: 'cursor-2', revision, reason: 'timeout' });
});

test('event watches publish an empty initial cursor but never advance past failed output', async () => {
  const output = [], failure = Object.assign(Error('broken output pipe'), { code: 'EPIPE' });
  let releases = 0, reads = 0;
  const session = { async *changes() { yield change; yield { ...change, revision: { ...revision, digest: 'd'.repeat(64) } }; }, readView: async () => ({ revision: reads ? { ...revision, digest: 'd'.repeat(64) } : {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
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

test('superseded snapshot cursors fail explicitly without replaying another revision from zero', async () => {
  const reads = [], recovered = Object.assign(Error('cursor recovered'), { code: 'EVENT_CURSOR_STALE' });
  let released = false;
  const session = { async *changes() { yield { ...change, kind: 'materialized' }; }, readView: async () => ({ revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
    readEvents(options) { reads.push(options); throw recovered; }, release() { released = true; },
  }) };
  await assert.rejects(watchSession({ session }, () => assert.fail('must not emit'), { events: true, cursor: 'old-revision' }), error => {
    assert.equal(error, recovered); assert.equal(error.watch.cursor, 'old-revision'); return true;
  });
  assert.deepEqual(reads, [{ cursor: 'old-revision' }]); assert.equal(released, true);
});

test('stalled pagination fails with its last cursor instead of spinning forever', async () => {
  let released = false;
  const session = { async *changes() { yield change; }, readView: async () => ({ revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
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
    yield {kind:'materialized',revision:{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},revisedProposalIds:[]};
    if(process.env.FIXTURE_END)return;
    await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }},detach(){if(process.env.FIXTURE_CLEANUP_FAIL)throw Object.assign(Error('detach failed'),{code:'CLEANUP_FAILED'});}};
}`);
  const args = [cli, 'watch', '--session', module, '--mode', 'attach', '--timeout', '1'];
  const result = await run(process.execPath, args);
  assert.deepEqual(JSON.parse(result.stderr), { watch: {
    mode: 'changes', cursor: null, revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}, reason: 'timeout',
  } });
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line).kind), ['status', 'materialized']);
  for (const [env, code] of [[{ FIXTURE_END: '1' }, 'SESSION_WATCH_ENDED'], [{ FIXTURE_CLEANUP_FAIL: '1' }, 'CLEANUP_FAILED']]) {
    await assert.rejects(run(process.execPath, args, { env: { ...process.env, ...env } }), error => {
      const result = JSON.parse(error.stderr);
      return error.code === 1 && result.error.code === code && result.watch.revision.digest === revision.digest;
    });
  }
});

test('failed view release preserves a primary recovery or output failure and its previous cursor', async () => {
  for (const code of ['EVENT_CURSOR_STALE', 'EPIPE']) {
    const primary = Object.assign(Error(code), { code });
    const cleanup = Object.assign(Error('view release failed'), { code: 'VIEW_RELEASE_FAILED' });
    const owner = new AbortController();
    const session = { signal: owner.signal, async *changes() { yield change; }, readView: async () => ({ revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
      readEvents() {
        if (code === 'EVENT_CURSOR_STALE') throw primary;
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
  const session = { async *changes() { yield change; }, readView: async () => ({ revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
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
  return {session:{async *changes(){yield {kind:'materialized',revision:{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},revisedProposalIds:[]};},
    readView:async()=>({ revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
      readEvents:()=>new Promise((resolve,reject)=>{
        const aborted=()=>process.env.FIXTURE_ABORT_READ_FAILURE ? reject(signal.reason)
          : resolve({revision:{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},events:[],cursor:'next',hasMore:false});
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

test('interruption during deferred view release does not hide an earlier genuine read failure', async () => {
  for (const primary of [
    Object.assign(Error('read failed'), { code: 'READ_FAILED' }),
    Object.assign(Error('cursor recovered'), { code: 'EVENT_CURSOR_STALE' }),
    new DOMException('unrelated abort before invocation interruption', 'AbortError'),
  ]) {
    const stop = new AbortController(), releasing = Promise.withResolvers(), released = Promise.withResolvers();
    const session = { async *changes() { yield change; }, readView: async () => ({ revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
      readEvents() { throw primary; },
      async release() { releasing.resolve(); await released.promise; },
    }) };
    const rejected = assert.rejects(watchSession({ session }, () => assert.fail('must not emit'), {
      signal: stop.signal, events: true, cursor: 'previous',
    }), error => {
      assert.equal(error, primary);
      assert.deepEqual(error.watch, { mode: 'events', cursor: 'previous', revision: null });
      return true;
    });
    await releasing.promise;
    stop.abort(Object.assign(Error('interrupted during cleanup'), { code: 'invocation_interrupted' }));
    released.resolve();
    await rejected;
  }
});

test('an AbortError from the active invocation still stops normally after deferred release', async () => {
  const stop = new AbortController(), releasing = Promise.withResolvers(), released = Promise.withResolvers();
  const reason = Object.assign(Error('deadline'), { code: 'invocation_timeout' });
  const session = { async *changes() { yield change; }, readView: async () => ({ revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
    readEvents() {
      stop.abort(reason);
      throw Object.assign(new Error('The operation was aborted', { cause: reason }), { name: 'AbortError', code: 'ABORT_ERR' });
    },
    async release() { releasing.resolve(); await released.promise; },
  }) };
  const result = watchSession({ session }, () => assert.fail('must not emit'), {
    signal: stop.signal, events: true, cursor: 'previous',
  });
  await releasing.promise; released.resolve();
  assert.deepEqual(await result, { mode: 'events', cursor: 'previous', revision: null, reason: 'timeout' });
});

test('watch CLI preserves a read error when its deadline expires during successful cleanup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tendril-watch-cancel-race-')), module = join(directory, 'session.mjs');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(module, `
export async function attachSession({signal}) {
  return {session:{async *changes(){yield {kind:'materialized',revision:{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},revisedProposalIds:[]};},
    readView:async()=>({ revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
      readEvents(){throw Object.assign(Error('cursor recovered before the deadline'),{code:'EVENT_CURSOR_STALE'});},
      release:()=>new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});})
    })},detach(){}};
}`);
  await assert.rejects(run(process.execPath, [cli, 'watch', '--events', '--cursor', 'previous',
    '--session', module, '--mode', 'attach', '--timeout', '1']), error => {
    const result = JSON.parse(error.stderr);
    assert.equal(error.code, 1); assert.equal(result.error.code, 'EVENT_CURSOR_STALE');
    assert.deepEqual(result.watch, { mode: 'events', cursor: 'previous', revision: null });
    assert.equal(error.stdout, '');
    return true;
  });
});

test('an already-aborted signal cannot turn an unrelated read error or AbortError cause into cancellation', async () => {
  for (const primary of [
    Object.assign(Error('independent read failure'), { code: 'READ_FAILED' }),
    Object.assign(new Error('another request was aborted', { cause: Error('other controller') }), { name: 'AbortError', code: 'ABORT_ERR' }),
  ]) {
    const stop = new AbortController();
    const session = { async *changes() { yield change; }, readView: async () => ({ revision: {"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","view":"local","executionManifestDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","policyDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
      readEvents() {
        stop.abort(Object.assign(Error('invocation interrupted'), { code: 'invocation_interrupted' }));
        throw primary;
      },
      release() {},
    }) };
    await assert.rejects(watchSession({ session }, () => assert.fail('must not emit'), {
      signal: stop.signal, events: true, cursor: 'previous',
    }), error => error === primary && error.watch.cursor === 'previous');
  }
});
