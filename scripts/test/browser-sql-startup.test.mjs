import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { startSqlFixtureWorker, SQL_FIXTURE_STARTUP } from '../../test/e2e/specimens/browser-sql-startup.mjs';

class Worker extends EventTarget {
  terminated = 0;
  postMessage(input) { this.input = input; }
  terminate() { this.terminated++; }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  progress(stage, elapsedMs = 0) { this.message({ type: 'startup-progress', stage, elapsedMs }); }
}
test('slow metadata and cold SQL own separate budgets, and open requires real SQL qualification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new Worker(), stages = [];
  const opened = startSqlFixtureWorker(worker, { type: 'open' }, value => stages.push(value));
  t.mock.timers.tick(24_000); worker.progress('metadata-ready', 24_000);
  t.mock.timers.tick(21_000); worker.progress('engine-load-ready', 45_000);
  worker.progress('opfs-ready', 45_010); worker.progress('sql-read-ready', 45_020);
  worker.message({ type: 'open' }); await opened;
  assert.equal(stages.length, 4); assert.equal(worker.terminated, 0);
  assert.equal(getEventListeners(worker, 'message').length, 0);
  t.mock.timers.tick(120_000); assert.equal(worker.terminated, 0);
});
test('a missing metadata result expires at its original 25s bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new Worker(), opened = startSqlFixtureWorker(worker, {});
  t.mock.timers.tick(SQL_FIXTURE_STARTUP.metadataMs);
  await assert.rejects(opened, /SQL_FIXTURE_METADATA_TIMEOUT/);
  assert.equal(worker.terminated, 1); assert.equal(getEventListeners(worker, 'error').length, 0);
});
test('engine progress cannot renew the fixed SQL deadline or earn false readiness', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new Worker(), opened = startSqlFixtureWorker(worker, {});
  worker.progress('metadata-ready');
  t.mock.timers.tick(SQL_FIXTURE_STARTUP.sqlMs - 1); worker.progress('engine-load-ready');
  t.mock.timers.tick(1); await assert.rejects(opened, /SQL_FIXTURE_DATABASE_TIMEOUT/);
  worker.message({ type: 'open' }); assert.equal(worker.terminated, 1);
});
test('an early open, repeated metadata readiness, or engine failure cannot pass', async () => {
  for (const reason of ['early', 'premature-sql', 'repeated', 'engine']) {
    const worker = new Worker(), opened = startSqlFixtureWorker(worker, {});
    if (reason === 'early') worker.message({ type: 'open' });
    else {
      worker.progress('metadata-ready');
      if (reason === 'premature-sql') worker.message({ type: 'open' });
      else if (reason === 'repeated') worker.progress('metadata-ready');
      else worker.message({ type: 'failure', message: 'SQL_ENGINE_UNAVAILABLE' });
    }
    await assert.rejects(opened, /SQL_FIXTURE_SQL_NOT_QUALIFIED|SQL_FIXTURE_METADATA_REPEATED|SQL_ENGINE_UNAVAILABLE/);
    assert.equal(worker.terminated, 1); assert.equal(getEventListeners(worker, 'message').length, 0);
  }
});
