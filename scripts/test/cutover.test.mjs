import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const migrationDir = join(root, 'server/migrations');
const allMigrations = readdirSync(migrationDir).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
const cutover = '0011_contract3_discard_old_pages.sql';

function migratedDatabase(t, includeCutover = true) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const name of allMigrations) {
    if (!includeCutover && name === cutover) continue;
    db.exec(readFileSync(join(migrationDir, name), 'utf8'));
  }
  return db;
}

test('a direct cutover retains the canonical Worker and domains but uses a fresh page namespace', () => {
  const configs = ['staging', 'production'].map(stage =>
    JSON.parse(readFileSync(join(root, 'server', `wrangler.${stage}.jsonc`), 'utf8')));
  for (const config of configs) {
    assert.equal(config.durable_objects.bindings.find(binding => binding.name === 'TENDRIL').class_name, 'TendrilV3');
    assert.equal(config.migrations, undefined);
    assert.deepEqual(config.exports.TendrilV3, { type: 'durable-object', storage: 'sqlite' });
    assert.deepEqual(config.exports.Admission, { type: 'durable-object', storage: 'sqlite' });
    for (const oldClass of ['Tendril', 'TendrilV2'])
      assert.deepEqual(config.exports[oldClass], { type: 'durable-object', state: 'deleted' });
    assert.equal(config.d1_databases.length, 1, 'existing account database is retained');
    assert.equal(config.r2_buckets.length, 1, 'existing file bucket is retained');
  }
  assert.equal(configs[0].name, 'tendriller-staging');
  assert.equal(configs[1].name, 'tendriller-production');
  assert.equal(configs[0].vars.PUBLIC_BASE, 'https://staging.tendriller.dev');
  assert.equal(configs[1].vars.PUBLIC_BASE, 'https://tendriller.dev');
});

test('cutover clears stale page registrations and usage without deleting identities or audit records', t => {
  const db = migratedDatabase(t, false);
  db.exec(`
    INSERT INTO accounts (id, created_at, email) VALUES ('owner', 1, 'owner@example.test');
    INSERT INTO identities (provider, subject, account_id, login, email, created_at)
      VALUES ('github', 'sub-1', 'owner', 'owner', 'owner@example.test', 1);
    INSERT INTO sessions (hash, account_id, created_at, expires_at) VALUES ('session', 'owner', 1, 9999999999);
    INSERT INTO tendrils (id, owner_account, intended_owner, creator_ip, created_at)
      VALUES ('old-page', 'owner', 'owner@example.test', '127.0.0.1', 1);
    UPDATE tendrils SET reserved = 512 WHERE id = 'old-page';
    INSERT INTO page_codes (hash, tendril_id, account_id, role, key_hash, expires_at)
      VALUES ('code', 'old-page', 'owner', 'owner', 'key', 9999999999);
    INSERT INTO claim_intents (hash, tendril_id, key_hash, account_id, expires_at)
      VALUES ('claim', 'old-page', 'key', 'owner', 9999999999);
    INSERT INTO suspension_queue (tendril_id, action, queued_at)
      VALUES ('old-page', 'disable', 1);
    INSERT INTO reports (id, tendril_id, account_id, source, reason, created_at)
      VALUES ('report', 'old-page', 'owner', 'external', 'retained audit', 1);
    INSERT INTO audit_log (id, actor, action, subject, created_at)
      VALUES ('audit', 'owner', 'created', 'old-page', 1);
    INSERT INTO creation_ip (ip, day, count) VALUES ('127.0.0.1', '2026-11-15', 4);
    UPDATE service_state SET mode = 'open';
  `);
  assert.equal(db.prepare('SELECT reserved FROM service_state WHERE id = 1').get().reserved, 512);
  db.exec(readFileSync(join(migrationDir, cutover), 'utf8'));
  for (const table of ['tendrils', 'page_codes', 'claim_intents', 'suspension_queue', 'creation_ip'])
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  const service = db.prepare('SELECT reserved, mode FROM service_state WHERE id = 1').get();
  assert.equal(service.reserved, 0);
  assert.equal(service.mode, 'creation_paused');
  assert.equal(db.prepare("SELECT reserved FROM accounts WHERE id='owner'").get().reserved, 0);
  for (const table of ['accounts', 'identities', 'sessions', 'reports', 'audit_log'])
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 1, table);
});

test('the full migration series initializes an empty paused contract 3 database', t => {
  const db = migratedDatabase(t);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tendrils').get().count, 0);
  const service = db.prepare('SELECT mode, reserved FROM service_state WHERE id=1').get();
  assert.equal(service.mode, 'creation_paused');
  assert.equal(service.reserved, 0);
});

test('deployment reopens creation once after cutover without undoing later pauses', t => {
  const db = migratedDatabase(t);
  const open = readFileSync(join(root, 'scripts/open-contract3-cutover.sql'), 'utf8');
  db.exec(open);
  assert.equal(db.prepare('SELECT mode FROM service_state WHERE id=1').get().mode, 'open');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM contract3_cutover_pending').get().count, 0);
  db.exec("UPDATE service_state SET mode='creation_paused' WHERE id=1");
  db.exec(open);
  assert.equal(db.prepare('SELECT mode FROM service_state WHERE id=1').get().mode, 'creation_paused');
});
