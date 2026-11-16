import { expect, it } from 'vitest';
import { Db, STORAGE_SCHEMA_REVISION, StorageSchemaError } from '../src/db';
import { inDO } from './helpers';

const objects = (storage: DurableObjectStorage) => storage.sql.exec(
  "SELECT name,type,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name",
).toArray();

async function isolatedDatabase(test: (storage: DurableObjectStorage) => void) {
  await inDO(`database-test:${crypto.randomUUID()}`, async t => {
    await t.ctx.storage.deleteAll();
    try { test(t.ctx.storage); }
    finally { await t.ctx.storage.deleteAll(); }
  });
}

it('initializes a fresh schema and reopens matching storage without changing its schema or data', async () => {
  await isolatedDatabase(storage => {
    const db = new Db(storage);
    db.init();
    expect(db.all('SELECT id,revision FROM storage_schema')).toEqual([{ id: 1, revision: STORAGE_SCHEMA_REVISION }]);
    expect(db.one('SELECT count,bytes FROM command_usage')).toEqual({ count: 0, bytes: 0 });
    expect(db.all('SELECT * FROM record_log')).toEqual([]);
    expect(db.all('SELECT * FROM record_log_entries')).toEqual([]);
    db.set('saved_work', { text: 'Keep this data' });
    db.run('UPDATE command_usage SET count=7,bytes=1024 WHERE id=1');
    const before = objects(storage);
    const reopened = new Db(storage);
    reopened.init();
    expect(objects(storage)).toEqual(before);
    expect(reopened.get('saved_work', null)).toEqual({ text: 'Keep this data' });
    expect(reopened.one('SELECT count,bytes FROM command_usage')).toEqual({ count: 7, bytes: 1024 });
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
