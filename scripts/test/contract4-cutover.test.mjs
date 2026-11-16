import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('canonical schema-4 deploys bind fresh storage without reusing revision-3 data', () => {
  for (const stage of ['staging', 'production']) {
    const config = JSON.parse(read(`server/wrangler.${stage}.jsonc`));
    assert.equal(config.main, '../dist/service/worker.mjs');
    assert.deepEqual(config.durable_objects.bindings.map(binding => binding.class_name), ['TendrilV4', 'AdmissionV4']);
    assert.deepEqual(config.exports.TendrilV4, { type: 'durable-object', storage: 'sqlite' });
    assert.deepEqual(config.exports.AdmissionV4, { type: 'durable-object', storage: 'sqlite' });
    assert.equal(config.exports.TendrilV3.state, 'deleted');
    assert.equal(config.exports.Admission.state, 'deleted');
    assert.equal(config.migrations, undefined, 'existing Workers already use declarative exports');
    assert.equal(config.d1_databases[0].database_name, `tendriller-${stage}-v4-accounts`);
    assert.equal(config.r2_buckets[0].bucket_name, `tendriller-${stage}-v4-files`);
  }
});

test('one-time cutover opening never undoes a later intentional pause', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(read('server/migrations/0001_accounts.sql'));
  db.exec(read('server/migrations/0002_contract4_cutover_marker.sql'));
  assert.equal(db.prepare('SELECT mode FROM service_state WHERE id=1').get().mode, 'creation_paused');
  const open = read('scripts/open-contract4-cutover.sql');
  db.exec(open);
  assert.equal(db.prepare('SELECT mode FROM service_state WHERE id=1').get().mode, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contract4_cutover_pending').get().count, 0);
  db.exec("UPDATE service_state SET mode='creation_paused' WHERE id=1");
  db.exec(open);
  assert.equal(db.prepare('SELECT mode FROM service_state WHERE id=1').get().mode, 'creation_paused');
});
