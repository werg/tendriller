import { expect, it } from 'vitest';
import { Db, REQUIRED_TABLES, SCHEMA, STORAGE_SCHEMA_REVISION, StorageSchemaError } from '../src/db';
import { inDO } from './helpers';

const objects = (storage: DurableObjectStorage) => storage.sql.exec(
  "SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name",
).toArray();

async function isolatedDatabase(test: (storage: DurableObjectStorage) => void | Promise<void>) {
  await inDO(`database-test:${crypto.randomUUID()}`, async t => {
    await t.ctx.storage.deleteAll();
    try { await test(t.ctx.storage); }
    finally { await t.ctx.storage.deleteAll(); }
  });
}

it('initializes a fresh schema and reopens matching storage without changing its schema or data', async () => {
  await isolatedDatabase(storage => {
    const db = new Db(storage);
    db.init();
    expect(db.all('SELECT id,revision FROM storage_schema')).toEqual([{ id: 1, revision: STORAGE_SCHEMA_REVISION }]);
    expect(db.all('SELECT * FROM participant_records')).toEqual([]);
    expect(db.all("SELECT name FROM sqlite_schema WHERE name IN ('command_usage','record_log','record_log_entries','application_changes','devices','events')")).toEqual([]);
    db.set('saved_work', { text: 'Keep this data' });
    db.run('INSERT INTO participant_records(key,value) VALUES(?,?)', 'control', new Uint8Array([1,2,3]).buffer);
    const before = objects(storage);
    const reopened = new Db(storage);
    reopened.init();
    expect(objects(storage)).toEqual(before);
    expect(reopened.get('saved_work', null)).toEqual({ text: 'Keep this data' });
    expect(new Uint8Array(reopened.one<{ value: ArrayBuffer }>("SELECT value FROM participant_records WHERE key='control'")!.value)).toEqual(new Uint8Array([1,2,3]));
  });
});

it.each(['missing identity', 'revision-5 identity', 'empty identity', 'malformed identity'])(
  'rejects existing storage with %s before schema or data mutation', async scenario => {
    await isolatedDatabase(storage => {
      storage.sql.exec('CREATE TABLE existing_work (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      storage.sql.exec('INSERT INTO existing_work(id,value) VALUES(1,?)', 'Preserve the original work');
      if (scenario === 'malformed identity') storage.sql.exec('CREATE TABLE storage_schema (unexpected TEXT)');
      else if (scenario !== 'missing identity') {
        storage.sql.exec('CREATE TABLE storage_schema (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)');
        if (scenario === 'revision-5 identity') storage.sql.exec('INSERT INTO storage_schema(id,revision) VALUES(1,5)');
      }
      const before = objects(storage);
      expect(() => new Db(storage).init()).toThrow(StorageSchemaError);
      expect(() => new Db(storage).init()).toThrow('fresh Durable Object namespace');
      expect(objects(storage)).toEqual(before);
      expect(objects(storage).some(object => object.name === 'record_log' || object.name === 'record_log_entries')).toBe(false);
      expect(storage.sql.exec('SELECT * FROM existing_work').toArray()).toEqual([{ id: 1, value: 'Preserve the original work' }]);
    });
  },
);

it('rolls back the complete fresh schema when recording its identity fails', async () => {
  await isolatedDatabase(storage => {
    const sql = new Proxy(storage.sql, { get(target, name) {
      if (name === 'exec') return (query: string, ...bindings: (string | number | null | ArrayBuffer)[]) => {
        if (query.startsWith('INSERT INTO storage_schema')) throw new Error('Injected identity write failure');
        return target.exec(query, ...bindings);
      };
      return Reflect.get(target, name, target);
    } });
    const failing = new Db({ sql, transactionSync: write => storage.transactionSync(write) });
    expect(() => failing.init()).toThrow('Injected identity write failure');
    expect(objects(storage)).toEqual([]);
    const recovered = new Db(storage);
    recovered.init();
    expect(recovered.one('SELECT revision FROM storage_schema')).toEqual({ revision: STORAGE_SCHEMA_REVISION });
  });
});

it('writes metadata only when its serialized durable value changes, including mutated cached objects', async () => {
  await isolatedDatabase(storage => {
    const cursors: { readonly rowsWritten: number }[] = [];
    const sql = new Proxy(storage.sql, { get(target, name) {
      if (name === 'exec') return (query: string, ...bindings: (string | number | null | ArrayBuffer)[]) => {
        const cursor = target.exec(query, ...bindings);
        cursors.push(cursor);
        return cursor;
      };
      return Reflect.get(target, name, target);
    } });
    const db = new Db({ sql, transactionSync: write => storage.transactionSync(write) });
    db.init();
    db.set('retry', { count: 1 });
    const shared = {};
    db.cached('shared', () => shared);
    cursors.length = 0;
    for (let i = 0; i < 20; i++) db.set('retry', { count: 1 });
    expect(cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
    expect(db.cached('shared', () => ({}))).toBe(shared);
    const value = db.get('retry', { count: 0 });
    value.count = 2;
    db.set('retry', value);
    expect(cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBeGreaterThan(0);
    expect(new Db(storage).get('retry', null)).toEqual({ count: 2 });
  });
});

it('shares a pending asynchronous read and retries it after failure', async () => {
  await isolatedDatabase(async storage => {
    const db = new Db(storage);
    const cached = db.cachedAsync<number>('identity', async () => { throw new Error('temporary failure'); });
    expect(db.cachedAsync('identity', async () => 1)).toBe(cached);
    await expect(cached).rejects.toThrow('temporary failure');
    await expect(db.cachedAsync('identity', async () => 2)).resolves.toBe(2);
  });
});

it('rejects existing storage whose revision matches but is missing core required tables', async () => {
  await isolatedDatabase(storage => {
    const db = new Db(storage);
    db.init();
    expect(REQUIRED_TABLES).toContain('v2_public_ops');
    storage.sql.exec('DROP TABLE v2_public_ops');
    expect(() => new Db(storage).init()).toThrow(StorageSchemaError);
    expect(() => new Db(storage).init()).toThrow('missing required tables (v2_public_ops)');
  });
});

it('upgrades pre-mailbox revision 15 storage in place without losing existing data', async () => {
  await isolatedDatabase(storage => {
    const db = new Db(storage);
    db.init();
    db.set('owner_account', 'acct_existing');
    storage.sql.exec('DROP TABLE v2_mailbox_envelopes');
    storage.sql.exec('DROP TABLE v2_mailbox_ops');
    storage.sql.exec('DROP TABLE v2_mailbox_cas');

    const upgraded = new Db(storage);
    upgraded.init();
    expect(upgraded.get('owner_account', null)).toBe('acct_existing');
    expect(upgraded.all('SELECT digest FROM v2_mailbox_envelopes')).toEqual([]);
    expect(upgraded.all('SELECT op_id FROM v2_mailbox_ops')).toEqual([]);
    expect(upgraded.all('SELECT hash FROM v2_mailbox_cas')).toEqual([]);
  });
});

it('pins SCHEMA content to STORAGE_SCHEMA_REVISION so table changes cannot ship without bumping revision', async () => {
  const bytes = new TextEncoder().encode(SCHEMA);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  // If you intentionally modify SCHEMA in server/src/db.ts, bump STORAGE_SCHEMA_REVISION
  // and update both pinned values below so existing DO namespaces never silently drift.
  expect({ revision: STORAGE_SCHEMA_REVISION, schemaSha256: hex }).toEqual({
    revision: 15,
    schemaSha256: 'd7c366b74a4f9cba58aa388650b54fdb3ba9a502476664367b4ccb6ded4bddc3',
  });
});
