import { defineApplication, defineCommand, defineQuery } from '@chronolog/peer-session';

const id = { type: 'string', minLength: 1, maxLength: 128 };
const quantity = { type: 'integer', minimum: 0, maximum: 1_000_000 };

/**
 * Chronolog SQLite-CAS + Postgres-style write RLS domain backed directly by the
 * built-in `chronolog/sql` standard topic reducer — zero custom JS reducer boilerplate!
 *
 * - Every command submits declarative SQL statements + atomic preconditions to `chronolog/sql`
 * - `initialize` runs `migrate` to create tables and install Postgres-style write RLS triggers
 * - `runUserDdl` lets any writer create/alter/drop their own personal SQLite tables safely
 * - Portable WebAssembly runtime, identical in browser, Node 22+, and hosted MCP Workers
 */
export const imports = Object.freeze({});
export const topics = Object.freeze({
  inventory: Object.freeze({ module: 'chronolog/sql' }),
  proposals: Object.freeze({ module: 'chronolog/workflow', export: 'stateMachine' }),
});

export async function deriveInventory(view) {
  const tablesRes = await view.query('inventory', { kind: 'tables' });
  const catalog = Array.isArray(tablesRes?.tables) ? tablesRes.tables : [];
  if (!catalog.some(t => t.name === 'inventory')) {
    return { stock: [], transfers: [], columns: [], catalog, hasLabel: false };
  }
  const colsRes = await view.query('inventory', { sql: 'SELECT * FROM inventory LIMIT 0' });
  const columnNames = Array.isArray(colsRes?.columns) ? colsRes.columns.map(String) : [];
  const hasLabel = columnNames.includes('label');
  const stockRes = await view.query('inventory', {
    sql: 'SELECT id, units' + (hasLabel ? ', label' : '') + ' FROM inventory ORDER BY id',
  });
  const transfersRes = catalog.some(t => t.name === 'transfers')
    ? await view.query('inventory', { sql: 'SELECT id, source, destination, units FROM transfers ORDER BY id LIMIT 100' })
    : { rows: [] };
  return {
    stock: (stockRes?.rows ?? []).map(([rowId, units, label]) => ({
      id: String(rowId),
      units: Number(units),
      ...(hasLabel ? { label: label === null ? '' : String(label) } : {}),
    })),
    transfers: (transfersRes?.rows ?? []).map(([rowId, from, to, units]) => ({
      id: String(rowId),
      from: String(from),
      to: String(to),
      units: Number(units),
    })),
    columns: columnNames,
    catalog: catalog.map(t => ({ name: String(t.name), type: String(t.type) })),
    hasLabel,
  };
}

export const definition = defineApplication({
  id: 'shared-inventory',
  version: '3',
  commands: {
    initialize: defineCommand({
      description: 'Create inventory tables, RLS triggers, and initial rows as an atomic SQLite-CAS migration.',
      input: { type: 'null' },
      prepare: () => [{
        topic: 'inventory',
        input: {
          action: 'migrate',
          preconditions: [{
            sql: "SELECT NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inventory')",
            code: 'already_initialized',
          }],
          statements: [
            `CREATE TABLE IF NOT EXISTS inventory (
              id TEXT PRIMARY KEY,
              units INTEGER NOT NULL CHECK (units >= 0 AND units <= 1000000),
              owner TEXT NOT NULL,
              _last_op_id TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS transfers (
              id TEXT PRIMARY KEY,
              source TEXT NOT NULL,
              destination TEXT NOT NULL,
              units INTEGER NOT NULL CHECK (units > 0),
              author TEXT NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS bin_grants (
              grantee TEXT PRIMARY KEY NOT NULL,
              granted_by TEXT NOT NULL
            )`,
            `INSERT OR IGNORE INTO inventory(id, units, owner) VALUES ('source', 10, actor()), ('destination', 0, actor())`,
          ],
          stampTables: ['inventory'],
          auditTables: ['inventory'],
          policies: {
            inventory: {
              insert: 'NEW.owner = actor()',
              update: 'OLD.owner = actor() OR EXISTS (SELECT 1 FROM bin_grants WHERE grantee = actor())',
              delete: 'OLD.owner = actor()',
            },
            transfers: {
              insert: 'NEW.author = actor()',
            },
          },
          events: [{ topic: 'inventory.initialized', payload: { source: 10, destination: 0 } }],
        },
      }],
    }),
    addBin: defineCommand({
      description: 'Create a bin owned by the transaction author.',
      input: { type: 'object', properties: { id, units: quantity }, required: ['id', 'units'], additionalProperties: false },
      prepare: ({ id: binId, units }) => [{
        topic: 'inventory',
        input: {
          statements: [{ sql: 'INSERT INTO inventory(id, units, owner) VALUES (?, ?, actor())', params: [binId, units] }],
          events: [{ topic: 'inventory.bin-added', payload: { id: binId, units } }],
        },
      }],
    }),
    setUnits: defineCommand({
      description: 'Change a permitted bin only when its reviewed balance still matches at author-time replay.',
      input: { type: 'object', properties: { id, units: quantity, expectedUnits: quantity }, required: ['id', 'units', 'expectedUnits'], additionalProperties: false },
      prepare: ({ id: binId, units, expectedUnits }) => [{
        topic: 'inventory',
        input: {
          preconditions: [{
            sql: 'SELECT units FROM inventory WHERE id = ?',
            params: [binId],
            expect: { firstValue: expectedUnits },
            code: 'balance_changed',
          }],
          statements: [{ sql: 'UPDATE inventory SET units = ? WHERE id = ?', params: [units, binId] }],
          events: [{ topic: 'inventory.bin-updated', payload: { id: binId, units } }],
        },
      }],
    }),
    deleteBin: defineCommand({
      description: 'Delete a permitted bin with an execution-time reviewed balance guard.',
      input: { type: 'object', properties: { id, expectedUnits: quantity }, required: ['id', 'expectedUnits'], additionalProperties: false },
      prepare: ({ id: binId, expectedUnits }) => [{
        topic: 'inventory',
        input: {
          preconditions: [{
            sql: 'SELECT units FROM inventory WHERE id = ?',
            params: [binId],
            expect: { firstValue: expectedUnits },
            code: 'balance_changed',
          }],
          statements: [{ sql: 'DELETE FROM inventory WHERE id = ?', params: [binId] }],
          events: [{ topic: 'inventory.bin-deleted', payload: { id: binId } }],
        },
      }],
    }),
    transfer: defineCommand({
      description: 'Atomically transfer units between permitted bins using reviewed balances.',
      input: {
        type: 'object',
        properties: { transferId: id, from: id, to: id, units: { ...quantity, minimum: 1 }, expectedSource: quantity, expectedDestination: quantity },
        required: ['transferId', 'from', 'to', 'units', 'expectedSource', 'expectedDestination'],
        additionalProperties: false,
      },
      prepare: ({ transferId, from, to, units, expectedSource, expectedDestination }) => {
        if (from === to) throw Error('Source and destination bins must differ');
        return [{
          topic: 'inventory',
          input: {
            preconditions: [
              {
                sql: 'SELECT units = ? AND units >= ? FROM inventory WHERE id = ?',
                params: [expectedSource, units, from],
                code: 'source_changed',
              },
              {
                sql: 'SELECT units = ? AND units <= ? FROM inventory WHERE id = ?',
                params: [expectedDestination, 1_000_000 - units, to],
                code: 'destination_changed',
              },
            ],
            statements: [
              { sql: 'UPDATE inventory SET units = units - ? WHERE id = ?', params: [units, from] },
              { sql: 'UPDATE inventory SET units = units + ? WHERE id = ?', params: [units, to] },
              { sql: 'INSERT INTO transfers(id, source, destination, units, author) VALUES (?, ?, ?, ?, actor())', params: [transferId, from, to, units] },
            ],
            events: [{ topic: 'inventory.transferred', payload: { transferId, from, to, units } }],
          },
        }];
      },
    }),
    addLabels: defineCommand({
      description: 'Authorized ALTER TABLE through the ordinary signed transaction path.',
      input: { type: 'null' },
      prepare: () => [{
        topic: 'inventory',
        input: {
          mode: 'admin',
          statements: ['ALTER TABLE inventory ADD COLUMN label TEXT'],
          events: [{ topic: 'inventory.schema-edited', payload: { column: 'label' } }],
        },
      }],
    }),
    setLabel: defineCommand({
      description: 'Edit a bin label subject to RLS write predicates.',
      input: { type: 'object', properties: { id, label: { type: 'string', maxLength: 200 } }, required: ['id', 'label'], additionalProperties: false },
      prepare: ({ id: binId, label }) => [{
        topic: 'inventory',
        input: {
          statements: [{ sql: 'UPDATE inventory SET label = ? WHERE id = ?', params: [label, binId] }],
        },
      }],
    }),
    grantBinWrites: defineCommand({
      description: 'Grant another member bin update rights via the RLS bin_grants table.',
      input: { type: 'object', properties: { publicKey: { type: 'string', minLength: 64, maxLength: 64 } }, required: ['publicKey'], additionalProperties: false },
      prepare: ({ publicKey }) => {
        if (!/^[0-9a-f]{64}$/.test(publicKey)) throw Error('Invalid recipient key');
        return [{
          topic: 'inventory',
          input: {
            mode: 'admin',
            statements: [{ sql: 'INSERT OR REPLACE INTO bin_grants(grantee, granted_by) VALUES (?, actor())', params: [publicKey] }],
          },
        }];
      },
    }),
    runUserDdl: defineCommand({
      description: 'Allow any writer to create, index, alter, or drop their own personal SQLite tables safely.',
      input: { type: 'object', properties: { sql: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['sql'], additionalProperties: false },
      prepare: ({ sql }) => [{
        topic: 'inventory',
        input: {
          statements: [sql],
          events: [{ topic: 'inventory.user-ddl', payload: { sql } }],
        },
      }],
    }),
  },
  queries: {
    inventory: defineQuery({
      description: 'Derive rows, balances, details and schema from one coherent current local snapshot.',
      input: { type: 'null' },
      read: deriveInventory,
    }),
    schema: defineQuery({
      description: 'Inspect SQLite-CAS tables, columns, user-owned objects, and active write RLS policies.',
      input: { type: 'null' },
      read: view => view.query('inventory', { query: 'schema' }),
    }),
    sql: defineQuery({
      description: 'Execute a read-only SQL query against the deterministic SQLite-CAS inventory state.',
      input: {
        type: 'object',
        properties: { sql: { type: 'string', minLength: 1, maxLength: 4096 } },
        required: ['sql'],
        additionalProperties: false,
      },
      read: (view, { sql }) => view.query('inventory', { sql }),
    }),
  },
});
