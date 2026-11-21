import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('the fresh account baseline enforces reservations and account limits atomically', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../../server/migrations/0001_accounts.sql', import.meta.url), 'utf8'));
  assert.deepEqual({ ...db.prepare('SELECT mode,reserved FROM service_state').get() }, { mode: 'creation_paused', reserved: 0 });
  db.exec("INSERT INTO accounts(id,created_at,email) VALUES('owner',1,'owner@example.test')");
  db.exec("INSERT INTO tendrils(id,owner_account,created_at) VALUES('page','owner',1)");
  db.exec("UPDATE tendrils SET reserved=1024 WHERE id='page'");
  assert.equal(db.prepare("SELECT reserved FROM accounts WHERE id='owner'").get().reserved, 1024);
  assert.equal(db.prepare('SELECT reserved FROM service_state').get().reserved, 1024);
  assert.throws(() => db.exec("UPDATE tendrils SET reserved=209715201 WHERE id='page'"), /account_full/);
  assert.equal(db.prepare("SELECT reserved FROM tendrils WHERE id='page'").get().reserved, 1024);
  assert.equal(db.prepare('SELECT reserved FROM service_state').get().reserved, 1024);
  db.exec("UPDATE accounts SET suspended_at=100 WHERE id='owner'");
  assert.equal(db.prepare("SELECT action FROM suspension_queue WHERE tendril_id='page'").get().action, 'disable');
  db.exec("DELETE FROM tendrils WHERE id='page'");
  assert.equal(db.prepare("SELECT reserved FROM accounts WHERE id='owner'").get().reserved, 0);
  assert.equal(db.prepare('SELECT reserved FROM service_state').get().reserved, 0);
});

test('the unified account schema enforces setup allocations, OAuth and assistant tables without double charging', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(readFileSync(new URL('../../server/migrations/0001_accounts.sql', import.meta.url), 'utf8'));
  assert.equal(db.prepare('SELECT revision FROM account_setup_schema').get().revision, 3);
  for (const table of ['integration_oauth_access', 'integration_oauth_codes', 'integration_oauth_refresh',
    'integration_oauth_grants', 'integration_oauth_intents', 'assistant_connections', 'account_setups', 'account_setup_allocations']) {
    assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table)?.name, table);
  }
  db.exec("UPDATE service_state SET mode='open' WHERE id=1");
  db.exec("INSERT INTO accounts(id,created_at,email) VALUES('owner',1,'owner@example.test')");
  db.exec("INSERT INTO identities(provider,subject,account_id,login,email,created_at) VALUES('github','sub-1','owner','owner','owner@example.test',1)");
  db.exec("INSERT INTO identity_emails(provider,subject,email) VALUES('github','sub-1','owner@example.test')");
  db.exec("INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at) VALUES('grant','owner','client','https://service.example/mcp','tendrils:create',1,86400001)");
  db.exec(`INSERT INTO account_setups VALUES('https://service.example','owner','client','operation','digest','commitment',
    'grant','owner@example.test','aaaaaaaaaaaa','application','{}','198.18.0.1','2026-11-20','ready',1,1,1,86400001,1,NULL)`);
  assert.deepEqual({ ...db.prepare('SELECT page_id,request_digest FROM account_setup_allocations').get() },
    { page_id: 'aaaaaaaaaaaa', request_digest: 'digest' });
  assert.equal(db.prepare('SELECT count FROM creation_ip').get().count, 1);
  const old = db.prepare('SELECT * FROM account_setups').get();
  db.exec('DELETE FROM account_setups');
  const values = Object.values(old), placeholders = values.map(() => '?').join(',');
  assert.throws(() => db.prepare(`INSERT INTO account_setups VALUES(${placeholders})`).run(...values), /setup_journal_missing/);
  values[3] = 'different-operation';
  assert.throws(() => db.prepare(`INSERT INTO account_setups VALUES(${placeholders})`).run(...values), /setup_allocation_conflict/);
  assert.equal(db.prepare('SELECT count FROM creation_ip').get().count, 1);
});
