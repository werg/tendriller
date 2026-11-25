import { defineApplication, defineCommand, defineQuery, emit, program, sqlStatement, platformOp, hexToBytes } from '@chronolog/peer-session';
const id = { type: 'string', minLength: 1, maxLength: 128 }, quantity = { type: 'integer', minimum: 0, maximum: 1_000_000 };
export async function deriveInventory(view) {
  const catalog = await view.query("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'chronolog_%' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const columns = await view.query('PRAGMA table_info(inventory)');
  const columnNames = columns.rows.map(row => String(row[1])), hasLabel = columnNames.includes('label');
  // A missing/changed table is an explicit view error. The UI retains and labels its previous snapshot.
  const stock = await view.query(`SELECT id,units${hasLabel ? ',label' : ''} FROM inventory ORDER BY id`);
  const transfers = await view.query('SELECT id,source,destination,units FROM transfers ORDER BY id LIMIT 100');
  return { stock: stock.rows.map(([id, units, label]) => ({ id: String(id), units: Number(units), ...(hasLabel ? { label: label === null ? '' : String(label) } : {}) })),
    transfers: transfers.rows.map(([id, from, to, units]) => ({ id: String(id), from: String(from), to: String(to), units: Number(units) })),
    columns: columnNames, catalog: catalog.rows.map(([name, type]) => ({ name: String(name), type: String(type) })), hasLabel };
}
export const definition = defineApplication({ id: 'shared-inventory', version: '2', commands: {
  initialize: defineCommand({ description: 'Create application tables and initial rows as an ordinary authorized atomic DDL/DML transaction.', input: { type: 'null' }, prepare: () => program(
    sqlStatement('CREATE TABLE inventory (id TEXT PRIMARY KEY, units INTEGER NOT NULL CHECK (units >= 0 AND units <= 1000000))'),
    sqlStatement('CREATE TABLE transfers (id TEXT PRIMARY KEY, source TEXT NOT NULL, destination TEXT NOT NULL, units INTEGER NOT NULL CHECK (units > 0))'),
    sqlStatement("INSERT INTO inventory(id,units) VALUES ('source',10),('destination',0)"), emit('inventory.initialized', { source: 10, destination: 0 })) }),
  addBin: defineCommand({ description: 'Create a bin owned by the transaction author.', input: { type: 'object', properties: { id, units: quantity }, required: ['id', 'units'], additionalProperties: false },
    prepare: ({ id, units }) => program(sqlStatement('INSERT INTO inventory(id,units) VALUES (?,?)', [id, units]), emit('inventory.bin-added', { id, units })) }),
  setUnits: defineCommand({ description: 'Change a permitted bin only when its reviewed balance still matches at author-time replay.', input: { type: 'object', properties: { id, units: quantity, expectedUnits: quantity }, required: ['id', 'units', 'expectedUnits'], additionalProperties: false },
    prepare: ({ id, units, expectedUnits }) => program(sqlStatement("SELECT chronolog_assert((SELECT units=? FROM inventory WHERE id=?),'balance_changed')", [expectedUnits, id]), sqlStatement('UPDATE inventory SET units=? WHERE id=?', [units, id]), emit('inventory.bin-updated', { id, units })) }),
  deleteBin: defineCommand({ description: 'Delete a permitted bin with an execution-time reviewed balance guard.', input: { type: 'object', properties: { id, expectedUnits: quantity }, required: ['id', 'expectedUnits'], additionalProperties: false },
    prepare: ({ id, expectedUnits }) => program(sqlStatement("SELECT chronolog_assert((SELECT units=? FROM inventory WHERE id=?),'balance_changed')", [expectedUnits, id]), sqlStatement('DELETE FROM inventory WHERE id=?', [id]), emit('inventory.bin-deleted', { id })) }),
  transfer: defineCommand({ description: 'Atomically transfer units between permitted bins using reviewed balances; its current rejection/success is revisable.',
    input: { type: 'object', properties: { transferId: id, from: id, to: id, units: { ...quantity, minimum: 1 }, expectedSource: quantity, expectedDestination: quantity }, required: ['transferId', 'from', 'to', 'units', 'expectedSource', 'expectedDestination'], additionalProperties: false },
    prepare: ({ transferId, from, to, units, expectedSource, expectedDestination }) => program(
      sqlStatement("SELECT chronolog_assert(? <> ?, 'same_bin')", [from, to]),
      sqlStatement("SELECT chronolog_assert((SELECT units=? AND units>=? FROM inventory WHERE id=?), 'source_changed')", [expectedSource, units, from]),
      sqlStatement("SELECT chronolog_assert((SELECT units=? AND units<=1000000-? FROM inventory WHERE id=?), 'destination_changed')", [expectedDestination, units, to]),
      sqlStatement('UPDATE inventory SET units=units-? WHERE id=?', [units, from]), sqlStatement('UPDATE inventory SET units=units+? WHERE id=?', [units, to]),
      sqlStatement('INSERT INTO transfers(id,source,destination,units) VALUES (?,?,?,?)', [transferId, from, to, units]), emit('inventory.transferred', { transferId, from, to, units })) }),
  addLabels: defineCommand({ description: 'Authorized ALTER TABLE through the ordinary signed transaction path, without publishing code.', input: { type: 'null' }, prepare: () => program(sqlStatement('ALTER TABLE inventory ADD COLUMN label TEXT'), emit('inventory.schema-edited', { column: 'label' })) }),
  setLabel: defineCommand({ description: 'Edit the new schema field only with its explicit column permission.', input: { type: 'object', properties: { id, label: { type: 'string', maxLength: 200 } }, required: ['id', 'label'], additionalProperties: false }, prepare: ({ id, label }) => program(sqlStatement('UPDATE inventory SET label=? WHERE id=?', [label, id])) }),
  grantBinWrites: defineCommand({ description: 'Explicit ordinary application grant for this author’s units column; crypto enrollment alone grants no SQL permission.',
    input: { type: 'object', properties: { publicKey: { type: 'string', minLength: 64, maxLength: 64 } }, required: ['publicKey'], additionalProperties: false },
    prepare: ({ publicKey }) => { if (!/^[0-9a-f]{64}$/.test(publicKey)) throw Error('Invalid recipient key'); const grantee = hexToBytes(publicKey); return program(
      platformOp.grant({ table: 'inventory', grantee, operations: ['update'], columns: ['units'] }),
      platformOp.grant({ table: 'transfers', grantee, operations: ['insert'] })); } }),
}, queries: { inventory: defineQuery({ description: 'Derive rows, balances, details and schema from one coherent current local snapshot.', input: { type: 'null' }, read: deriveInventory }) } });
