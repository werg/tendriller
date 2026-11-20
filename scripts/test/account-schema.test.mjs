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

test('the explicit setup recovery upgrade preserves both installed journal revisions without charging twice', t => {
  const migration = name => readFileSync(new URL(`../../server/migrations/${name}`, import.meta.url), 'utf8');
  for (const revision of [1, 2]) {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    db.exec(migration('0001_accounts.sql'));
    db.exec(migration('0002_integration_oauth.sql'));
    db.exec(migration('0004_account_setup.sql'));
    // The original revision has the same detailed journal columns, no independent
    // allocation table, and the IP-only charge trigger. No live database is altered.
    db.exec('DROP TRIGGER account_setup_capacity; DROP TRIGGER account_setup_charge;');
    if (revision === 1) db.exec('DROP TABLE account_setup_allocations; UPDATE account_setup_schema SET revision=1;');
    db.exec("CREATE TRIGGER account_setup_capacity BEFORE INSERT ON account_setups BEGIN SELECT 1; END;");
    db.exec("CREATE TRIGGER account_setup_charge AFTER INSERT ON account_setups BEGIN SELECT 1; END;");
    db.exec("INSERT INTO accounts(id,created_at,email) VALUES('owner',1,'owner@example.test')");
    db.exec(`INSERT INTO account_setups VALUES('https://service.example','owner','client','operation','digest','commitment',
      'grant','owner@example.test','aaaaaaaaaaaa','application','{}','198.18.0.1','2026-11-20','ready',1,1,1,86400001,1,NULL)`);
    db.exec("INSERT INTO creation_ip VALUES('198.18.0.1','2026-11-20',1)");
    if (revision === 2) {
      // A retained witness must survive even when its detailed journal disagrees.
      db.exec(`INSERT INTO account_setup_allocations SELECT service_origin,account_id,client_id,operation_id,'original-digest',
        credential_commitment,grant_id,intended_email,page_id,application_id,creator_ip,creation_day,created_at,expires_at FROM account_setups`);
    }
    db.exec(migration('0005_account_setup_recovery.sql'));
    assert.equal(db.prepare('SELECT revision FROM account_setup_schema').get().revision, 3);
    assert.deepEqual({ ...db.prepare('SELECT page_id,request_digest FROM account_setup_allocations').get() },
      { page_id:'aaaaaaaaaaaa', request_digest:revision === 1 ? 'digest' : 'original-digest' });
    assert.equal(db.prepare('SELECT count FROM creation_ip').get().count, 1);
    const old = db.prepare('SELECT * FROM account_setups').get();
    db.exec('DELETE FROM account_setups');
    const values = Object.values(old), placeholders = values.map(() => '?').join(',');
    assert.throws(() => db.prepare(`INSERT INTO account_setups VALUES(${placeholders})`).run(...values), /setup_journal_missing/);
    values[3] = 'different-operation';
    assert.throws(() => db.prepare(`INSERT INTO account_setups VALUES(${placeholders})`).run(...values), /setup_allocation_conflict/);
    assert.equal(db.prepare('SELECT count FROM creation_ip').get().count, 1);
  }
});
