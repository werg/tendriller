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
