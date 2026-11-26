import { defineApplication, defineCommand, defineQuery } from '@chronolog/peer-session';

const id = { type: 'string', minLength: 1, maxLength: 128 };
const quantity = { type: 'integer', minimum: 0, maximum: 1_000_000 };

/**
 * Chronolog v2 SQLite-CAS + Postgres-style write RLS ES Module reducer!
 * - Uses built-in `chronolog:sqlite` (stock SQLite + FTS5 + sqlite-vec over 4 KiB Merkle-paged CAS)
 * - Uses `chronolog/rls` (`applyRls`, `ensureTableOwners`, `getOwnedTables`, `recordTableOwners`)
 *   for expressive SQL write predicates (`actor()`, `op_id()`, `op_time()`) and user-owned dynamic tables!
 * - Zero DoltLite, zero native C/C++ addons, identical in browser, Node 22+, and hosted MCP Workers!
 */
export const INVENTORY_REDUCER_SOURCE = `
import { openDb } from 'chronolog:sqlite';
import { applyRls, ensureTableOwners, getOwnedTables, recordTableOwners } from 'chronolog/rls';

function isAdmin(ctx, author) {
  const perms = ctx.topic('$permissions');
  return Boolean(perms && Array.isArray(perms.members) && perms.members.some(m => m.publicKey === author && m.administrator === true));
}

function isWriter(ctx, author) {
  const perms = ctx.topic('$permissions');
  return Boolean(perms && Array.isArray(perms.members) && perms.members.some(m => m.publicKey === author && m.writer === true));
}

function installRls(db) {
  applyRls(db, {
    inventory: {
      insert: 'NEW.owner = actor()',
      update: 'OLD.owner = actor() OR EXISTS (SELECT 1 FROM bin_grants WHERE grantee = actor())',
      delete: 'OLD.owner = actor()',
    },
    transfers: {
      insert: 'NEW.author = actor()',
    },
  });
}

export default {
  reduce(state, tx, ctx) {
    if (!isWriter(ctx, tx.author)) return { ok: false, code: 'writer_required' };
    const input = tx.payload;
    if (!input || typeof input !== 'object') return { ok: false, code: 'invalid_input' };
    const db = openDb(state && state.dbRoot ? state.dbRoot : null);

    if (input.action === 'initialize') {
      if (!isAdmin(ctx, tx.author)) return { ok: false, code: 'admin_required' };
      db.exec(\`
        CREATE TABLE IF NOT EXISTS inventory (
          id TEXT PRIMARY KEY,
          units INTEGER NOT NULL CHECK (units >= 0 AND units <= 1000000),
          owner TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS transfers (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          destination TEXT NOT NULL,
          units INTEGER NOT NULL CHECK (units > 0),
          author TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bin_grants (
          grantee TEXT PRIMARY KEY NOT NULL,
          granted_by TEXT NOT NULL
        );
        INSERT OR IGNORE INTO inventory(id, units, owner) VALUES ('source', 10, actor()), ('destination', 0, actor());
      \`, [], { mode: 'admin' });
      ensureTableOwners(db);
      installRls(db);
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'inventory.initialized', payload: { source: 10, destination: 0 } }] };
    }

    if (input.action === 'addBin') {
      db.exec('INSERT INTO inventory(id, units, owner) VALUES (?, ?, actor())', [input.id, input.units], { mode: 'user' });
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'inventory.bin-added', payload: { id: input.id, units: input.units } }] };
    }

    if (input.action === 'setUnits') {
      const cur = db.query('SELECT units FROM inventory WHERE id = ?', [input.id]);
      if (!cur.rows.length || Number(cur.rows[0][0]) !== input.expectedUnits) return { ok: false, code: 'balance_changed' };
      db.exec('UPDATE inventory SET units = ? WHERE id = ?', [input.units, input.id], { mode: 'user' });
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'inventory.bin-updated', payload: { id: input.id, units: input.units } }] };
    }

    if (input.action === 'deleteBin') {
      const cur = db.query('SELECT units FROM inventory WHERE id = ?', [input.id]);
      if (!cur.rows.length || Number(cur.rows[0][0]) !== input.expectedUnits) return { ok: false, code: 'balance_changed' };
      db.exec('DELETE FROM inventory WHERE id = ?', [input.id], { mode: 'user' });
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'inventory.bin-deleted', payload: { id: input.id } }] };
    }

    if (input.action === 'transfer') {
      if (input.from === input.to) return { ok: false, code: 'same_bin' };
      const src = db.query('SELECT units FROM inventory WHERE id = ?', [input.from]);
      const dst = db.query('SELECT units FROM inventory WHERE id = ?', [input.to]);
      if (!src.rows.length || Number(src.rows[0][0]) !== input.expectedSource || Number(src.rows[0][0]) < input.units) {
        return { ok: false, code: 'source_changed' };
      }
      if (!dst.rows.length || Number(dst.rows[0][0]) !== input.expectedDestination || Number(dst.rows[0][0]) > 1000000 - input.units) {
        return { ok: false, code: 'destination_changed' };
      }
      db.exec('UPDATE inventory SET units = units - ? WHERE id = ?', [input.units, input.from], { mode: 'user' });
      db.exec('UPDATE inventory SET units = units + ? WHERE id = ?', [input.units, input.to], { mode: 'user' });
      db.exec('INSERT INTO transfers(id, source, destination, units, author) VALUES (?, ?, ?, ?, actor())', [input.transferId, input.from, input.to, input.units], { mode: 'user' });
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'inventory.transferred', payload: { transferId: input.transferId, from: input.from, to: input.to, units: input.units } }] };
    }

    if (input.action === 'addLabels') {
      if (!isAdmin(ctx, tx.author)) return { ok: false, code: 'admin_required' };
      db.exec('ALTER TABLE inventory ADD COLUMN label TEXT', [], { mode: 'admin' });
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'inventory.schema-edited', payload: { column: 'label' } }] };
    }

    if (input.action === 'setLabel') {
      db.exec('UPDATE inventory SET label = ? WHERE id = ?', [input.label, input.id], { mode: 'user' });
      return { ok: true, state: { dbRoot: db.commit() }, events: [] };
    }

    if (input.action === 'grantBinWrites') {
      if (!isAdmin(ctx, tx.author)) return { ok: false, code: 'admin_required' };
      db.exec('INSERT OR REPLACE INTO bin_grants(grantee, granted_by) VALUES (?, actor())', [input.publicKey], { mode: 'admin' });
      return { ok: true, state: { dbRoot: db.commit() }, events: [] };
    }

    // Non-admin users can create/alter/drop their own personal SQLite tables safely!
    if (input.action === 'runUserDdl') {
      const owned = getOwnedTables(db, tx.author);
      const res = db.exec(input.sql, [], {
        mode: 'user',
        ddl: { allowCreateTable: true, allowCreateIndex: true, allowAlterOwnedTables: true, allowDropOwnedTables: true, ownedTables: owned },
      });
      recordTableOwners(db, res.createdTables, res.droppedTables, tx.author);
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'inventory.user-ddl', payload: { created: res.createdTables, dropped: res.droppedTables } }] };
    }

    return { ok: false, code: 'unknown_action' };
  },

  query(state) {
    if (!state || !state.dbRoot) return { stock: [], transfers: [], columns: [], catalog: [], hasLabel: false };
    const db = openDb(state.dbRoot);
    const catalog = db.query("SELECT name, type FROM sqlite_master WHERE name NOT LIKE '_rls_%' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const columns = db.query('PRAGMA table_info(inventory)');
    const columnNames = columns.rows.map(r => String(r[1]));
    const hasLabel = columnNames.includes('label');
    const stock = columnNames.length ? db.query('SELECT id, units' + (hasLabel ? ', label' : '') + ' FROM inventory ORDER BY id') : { rows: [] };
    const transfers = catalog.rows.some(r => r[0] === 'transfers') ? db.query('SELECT id, source, destination, units FROM transfers ORDER BY id LIMIT 100') : { rows: [] };
    return {
      stock: stock.rows.map(([id, units, label]) => ({ id: String(id), units: Number(units), ...(hasLabel ? { label: label === null ? '' : String(label) } : {}) })),
      transfers: transfers.rows.map(([id, from, to, units]) => ({ id: String(id), from: String(from), to: String(to), units: Number(units) })),
      columns: columnNames,
      catalog: catalog.rows.map(([name, type]) => ({ name: String(name), type: String(type) })),
      hasLabel,
    };
  },
};
`.trimStart();

export const imports = Object.freeze({ 'app/inventory': INVENTORY_REDUCER_SOURCE });
export const topics = Object.freeze({ inventory: Object.freeze({ module: 'app/inventory', initialState: { dbRoot: null } }) });

export async function deriveInventory(view) {
  return view.query('inventory', null);
}

export const definition = defineApplication({
  id: 'shared-inventory',
  version: '3',
  commands: {
    initialize: defineCommand({
      description: 'Create inventory tables, RLS triggers, and initial rows as an atomic SQLite-CAS transaction.',
      input: { type: 'null' },
      prepare: () => [{ topic: 'inventory', input: { action: 'initialize' } }],
    }),
    addBin: defineCommand({
      description: 'Create a bin owned by the transaction author.',
      input: { type: 'object', properties: { id, units: quantity }, required: ['id', 'units'], additionalProperties: false },
      prepare: input => [{ topic: 'inventory', input: { action: 'addBin', ...input } }],
    }),
    setUnits: defineCommand({
      description: 'Change a permitted bin only when its reviewed balance still matches at author-time replay.',
      input: { type: 'object', properties: { id, units: quantity, expectedUnits: quantity }, required: ['id', 'units', 'expectedUnits'], additionalProperties: false },
      prepare: input => [{ topic: 'inventory', input: { action: 'setUnits', ...input } }],
    }),
    deleteBin: defineCommand({
      description: 'Delete a permitted bin with an execution-time reviewed balance guard.',
      input: { type: 'object', properties: { id, expectedUnits: quantity }, required: ['id', 'expectedUnits'], additionalProperties: false },
      prepare: input => [{ topic: 'inventory', input: { action: 'deleteBin', ...input } }],
    }),
    transfer: defineCommand({
      description: 'Atomically transfer units between permitted bins using reviewed balances.',
      input: {
        type: 'object',
        properties: { transferId: id, from: id, to: id, units: { ...quantity, minimum: 1 }, expectedSource: quantity, expectedDestination: quantity },
        required: ['transferId', 'from', 'to', 'units', 'expectedSource', 'expectedDestination'],
        additionalProperties: false,
      },
      prepare: input => [{ topic: 'inventory', input: { action: 'transfer', ...input } }],
    }),
    addLabels: defineCommand({
      description: 'Authorized ALTER TABLE through the ordinary signed transaction path.',
      input: { type: 'null' },
      prepare: () => [{ topic: 'inventory', input: { action: 'addLabels' } }],
    }),
    setLabel: defineCommand({
      description: 'Edit a bin label subject to RLS write predicates.',
      input: { type: 'object', properties: { id, label: { type: 'string', maxLength: 200 } }, required: ['id', 'label'], additionalProperties: false },
      prepare: input => [{ topic: 'inventory', input: { action: 'setLabel', ...input } }],
    }),
    grantBinWrites: defineCommand({
      description: 'Grant another member bin update rights via the RLS bin_grants table.',
      input: { type: 'object', properties: { publicKey: { type: 'string', minLength: 64, maxLength: 64 } }, required: ['publicKey'], additionalProperties: false },
      prepare: ({ publicKey }) => {
        if (!/^[0-9a-f]{64}$/.test(publicKey)) throw Error('Invalid recipient key');
        return [{ topic: 'inventory', input: { action: 'grantBinWrites', publicKey } }];
      },
    }),
    runUserDdl: defineCommand({
      description: 'Allow any writer to create, index, alter, or drop their own personal SQLite tables safely.',
      input: { type: 'object', properties: { sql: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['sql'], additionalProperties: false },
      prepare: ({ sql }) => [{ topic: 'inventory', input: { action: 'runUserDdl', sql } }],
    }),
  },
  queries: {
    inventory: defineQuery({
      description: 'Derive rows, balances, details and schema from one coherent current local snapshot.',
      input: { type: 'null' },
      read: deriveInventory,
    }),
  },
});
