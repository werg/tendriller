// Lightweight wiring/syntax checks only. These do not qualify a browser, media
// permission, signed session, SQLite reopen or actual content replication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestConnection } from '../observation-fixture/connection.mjs';

const paths = ['../qualify-observation.mjs', '../observation-fixture/page.mjs', '../observation-fixture/worker.mjs']
  .map(path => fileURLToPath(new URL(path, import.meta.url)));
const [qualifier, page, worker] = await Promise.all(paths.map(path => readFile(path, 'utf8')));

test('Root qualifier and maintained fixture entries parse without executing or building them', () => {
  for (const path of paths) {
    const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || path);
  }
});

test('Root observation composition uses installed public sessions and the selected built runtime, never private or Contrib implementation', () => {
  for (const source of [qualifier, page, worker]) {
    assert.doesNotMatch(source, /runtime\/src|chronolog-db\/packages|tendriller-contrib|openPeerApplication|openBrowserApplication|openNativeApplication|MemoryBytesStore|createGenerationRegistry|signApplicationDescriptor|signControlRevision|\.applied\(|\.shared\(/);
  }
  assert.match(qualifier, /dist\/runtime/);
  assert.match(qualifier, /runtimePackage\.exports\['\.\/kernel'\]\.import/);
  assert.match(page, /from '@tendriller\/runtime\/kernel'/);
  assert.match(page, /from '@chronolog\/peer-session\/browser'/);
  assert.doesNotMatch(page, /from '@chronolog\/peer-session'/);
  assert.match(worker, /from '@chronolog\/peer-session\/worker'/);
});

test('an owning Worker retains its signer and fixture keys and attaches a restricted MessagePort facade', () => {
  assert.match(worker, /openBrowserDevice\(\{name:'observation-qualification',create:true\}\)/);
  assert.match(worker, /createApplicationSession\(\{device,definition,authority,epochKeys:/);
  assert.match(worker, /createApplicationOwner\(session\)/);
  assert.match(worker, /owner\.attach\(data\.port,/);
  assert.match(page, /new MessageChannel\(\)/);
  assert.match(page, /connectApplicationOwner\(channel\.port2,/);
  assert.match(qualifier, /owningWorker\.evaluate\(value => self\.initializeWorker\(value\)/);
  assert.doesNotMatch(page, /privateKey|epochKeys|__bootstrap|\{authority,key/);
  assert.match(worker, /rawSubmit:false,rawSql:false/);
  assert.match(worker, /capabilities:\['commands','queries','events','content','signals','operations','diagnostics'\]/);
  assert.match(qualifier, /createLogGenesis/);
});

test('Root helpers and independent operation facts remain exercised by the real qualifier', () => {
  assert.match(page, /createReviewedInput/); assert.match(page, /createCameraController/);
  assert.match(page, /createPeerInferenceClient/); assert.match(qualifier, /servePeerInference/);
  assert.match(qualifier, /operation\.materialized\(/); assert.match(qualifier, /operation\.retained\(/);
  assert.match(qualifier, /inspection\.stored, true/); assert.match(qualifier, /inspection\.finalized, false/);
  assert.match(qualifier, /length: 70000/); assert.match(qualifier, /mediaReceived\[1\]\.sha256, result\.sha256/);
  assert.match(qualifier, /native-sqlite-reopen-preserves-only-reviewed-observation/);
});

test('the retained Root test bridge separates reliable/live queues and wakes readers on close', async () => {
  const bridge = createTestConnection(() => {}, { maxFrames: 1, maxBytes: 4 });
  try {
    assert.equal(bridge.accept('reliable', new Uint8Array([1])), true);
    assert.equal(bridge.accept('live', new Uint8Array([2])), true);
    assert.throws(() => bridge.accept('live', new Uint8Array([3])), /budget/);
    const reliable = bridge.connection.frames()[Symbol.asyncIterator]();
    const live = bridge.connection.live.frames()[Symbol.asyncIterator]();
    assert.deepEqual((await reliable.next()).value, new Uint8Array([1]));
    assert.deepEqual((await live.next()).value, new Uint8Array([2]));
    assert.equal(await bridge.connection.live.trySend(new Uint8Array([1])), true);
    const waiting = reliable.next(); await bridge.close(); assert.equal((await waiting).done, true);
    await live.return();
    assert.equal(bridge.accept('reliable', new Uint8Array([1])), false);
  } finally { await bridge.close(); }
});
