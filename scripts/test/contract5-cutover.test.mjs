import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('canonical schema-5 deploys bind fresh page and file storage', () => {
  for (const stage of ['staging', 'production']) {
    const config = JSON.parse(read(`server/wrangler.${stage}.jsonc`));
    assert.equal(config.main, '../dist/service/worker.mjs');
    assert.deepEqual(config.durable_objects.bindings.map(binding => binding.class_name), ['TendrilV5', 'AdmissionV5']);
    assert.deepEqual(config.exports.TendrilV5, { type: 'durable-object', storage: 'sqlite' });
    assert.deepEqual(config.exports.AdmissionV5, { type: 'durable-object', storage: 'sqlite' });
    assert.equal(config.exports.TendrilV4.state, 'deleted');
    assert.equal(config.exports.AdmissionV4.state, 'deleted');
    assert.equal(config.migrations, undefined, 'existing Workers use declarative exports');
    assert.equal(config.d1_databases[0].database_name, `tendriller-${stage}-v4-accounts`);
    assert.equal(config.r2_buckets[0].bucket_name, `tendriller-${stage}-v5-files`);
  }
});

test('schema-5 cutover reuses the account registry and opens creation exactly once', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(read('server/migrations/0001_accounts.sql'));
  db.exec(read('server/migrations/0002_contract4_cutover_marker.sql'));
  db.exec("DELETE FROM contract4_cutover_pending; UPDATE service_state SET mode='open' WHERE id=1");
  db.exec(read('server/migrations/0003_contract5_cutover_marker.sql'));
  assert.equal(db.prepare('SELECT mode FROM service_state WHERE id=1').get().mode, 'creation_paused');
  const open = read('scripts/open-contract5-cutover.sql');
  db.exec(open);
  assert.equal(db.prepare('SELECT mode FROM service_state WHERE id=1').get().mode, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contract5_cutover_pending').get().count, 0);
  db.exec("UPDATE service_state SET mode='creation_paused' WHERE id=1");
  db.exec(open);
  assert.equal(db.prepare('SELECT mode FROM service_state WHERE id=1').get().mode, 'creation_paused');
});
