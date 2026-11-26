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

test('the account schema holds OAuth, assistant and agent tables, and agent rows cascade with their account and page', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of ['0001_accounts.sql', '0002_agents.sql', '0003_broadcasts.sql', '0004_account_limits.sql', '0006_oauth_connections_and_groups.sql'])
    db.exec(readFileSync(new URL('../../server/migrations/' + file, import.meta.url), 'utf8'));
  for (const table of ['integration_oauth_access', 'integration_oauth_codes', 'integration_oauth_refresh',
    'integration_oauth_grants', 'integration_oauth_intents', 'mcp_connections', 'agents', 'agent_grants', 'agent_join_codes',
    'system_broadcasts', 'broadcast_keys', 'agent_versions', 'page_versions',
    'oauth_custom_providers', 'outbound_oauth_states', 'outbound_connections', 'outbound_page_grants', 'identity_groups', 'page_group_rules']) {
    assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table)?.name, table);
  }
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'account_setup%'").get(), undefined);
  db.exec("INSERT INTO accounts(id,created_at,email) VALUES('owner',1,'owner@example.test')");
  db.exec("INSERT INTO tendrils(id,owner_account,created_at) VALUES('aaaaaaaaaaaa','owner',1)");
  db.exec("INSERT INTO agents(id,account_id,handle,bio,token_hash,public_key,wrap_key,created_at) VALUES('ag_one','owner','maintainer','Keeps notes','hash-1','key','abababababababababababababababababababababababababababababababab',1)");
  assert.throws(() => db.exec("INSERT INTO agents(id,account_id,handle,token_hash,public_key,wrap_key,created_at) VALUES('ag_two','owner','Maintainer','hash-2','key','abababababababababababababababababababababababababababababababab',1)"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO agents(id,handle,token_hash,public_key,wrap_key,created_at) VALUES('ag_three','orphan','hash-3','key','abababababababababababababababababababababababababababababababab',1)"), /CHECK/);
  db.exec("INSERT INTO agent_grants(agent_id,page_id,scopes,granted_at,granted_by) VALUES('ag_one','aaaaaaaaaaaa','[]',1,'creator')");
  db.exec("DELETE FROM tendrils WHERE id='aaaaaaaaaaaa'");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_grants').get().n, 0);
  db.exec("INSERT INTO agent_join_codes(code_hash,account_id,scopes,expires_at) VALUES('code','owner','[]',2)");
  db.exec("DELETE FROM accounts WHERE id='owner'");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agents').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_join_codes').get().n, 0);
});

test('configurable account limits default to production caps and allow unlimited NULL caps for localhost', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of ['0001_accounts.sql', '0002_agents.sql', '0003_broadcasts.sql', '0004_account_limits.sql', '0006_oauth_connections_and_groups.sql'])
    db.exec(readFileSync(new URL('../../server/migrations/' + file, import.meta.url), 'utf8'));
  db.exec("INSERT INTO accounts(id,created_at,email) VALUES('owner',1,'owner@example.test')");
  // Default resident cap is 5.
  for (let i = 1; i <= 5; i++) {
    db.exec(`INSERT INTO tendrils(id,owner_account,created_at,lifetime) VALUES('p0000000000${i}','owner',1,'resident')`);
  }
  assert.throws(() => db.exec("INSERT INTO tendrils(id,owner_account,created_at,lifetime) VALUES('p00000000006','owner',1,'resident')"), /account_residents_full/);
  // Setting NULL removes caps (localhost dev mode).
  db.exec("UPDATE service_state SET account_page_cap=NULL, account_resident_cap=NULL, account_storage_cap=NULL WHERE id=1");
  for (let i = 6; i <= 25; i++) {
    db.exec(`INSERT INTO tendrils(id,owner_account,created_at,lifetime) VALUES('p000000000${String(i).padStart(2, '0')}','owner',1,'resident')`);
  }
  db.exec("UPDATE tendrils SET reserved=300000000 WHERE id='p00000000001'");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tendrils WHERE owner_account='owner' AND lifetime='resident'").get().n, 25);
});
