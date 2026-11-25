// The same literal definition runs in a native peer and an owning browser Worker.
import { APPLICATION_COLLECTIVE_ID, defineApplication, defineCommand, defineQuery,
  emit, program, sqlStatement } from '@chronolog/peer-session';

const quantity = { type: 'integer', minimum: 0, maximum: 1_000_000 };
const bin = { type: 'string', enum: ['source', 'destination'] };

export const definition = defineApplication({
  id: 'shared-inventory', version: '1',
  schema: program(
    sqlStatement('CREATE TABLE inventory (id TEXT PRIMARY KEY, units INTEGER NOT NULL CHECK (units >= 0 AND units <= 1000000))'),
    sqlStatement('CREATE TABLE transfers (id TEXT PRIMARY KEY, source TEXT NOT NULL, destination TEXT NOT NULL, units INTEGER NOT NULL CHECK (units > 0), author TEXT NOT NULL)'),
  ),
  commands: {
    seed: defineCommand({ description: 'Initialize two shared inventory bins once', input: { type: 'null' },
      prepare: () => program(
        sqlStatement("SELECT chronolog_assert(NOT EXISTS (SELECT 1 FROM inventory), 'already_initialized')"),
        // Shared rows are owned by the application's collective. The signing
        // device is still the transaction author; it is not a privileged server.
        sqlStatement('INSERT INTO inventory (id,units,chronolog_owner) VALUES (?,10,(SELECT id FROM chronolog_principals WHERE key=?)), (?,0,(SELECT id FROM chronolog_principals WHERE key=?))',
          ['source', APPLICATION_COLLECTIVE_ID, 'destination', APPLICATION_COLLECTIVE_ID]),
        emit('inventory.initialized', { source: 10, destination: 0 }),
      ),
    }),
    transfer: defineCommand({ description: 'Move units between two bins only if the reviewed balances still match',
      input: { type: 'object', properties: {
        transferId: { type: 'string', minLength: 1, maxLength: 128 }, from: bin, to: bin,
        units: { ...quantity, minimum: 1 }, expectedSource: quantity, expectedDestination: quantity,
      }, required: ['transferId', 'from', 'to', 'units', 'expectedSource', 'expectedDestination'] },
      prepare: ({ transferId, from, to, units, expectedSource, expectedDestination }) => program(
        sqlStatement("SELECT chronolog_assert(? <> ?, 'same_bin')", [from, to]),
        sqlStatement("SELECT chronolog_assert(NOT EXISTS (SELECT 1 FROM transfers WHERE id=?), 'transfer_exists')", [transferId]),
        // These execute at this operation's actual position in the shared
        // history, not in JavaScript before another writer can change the rows.
        sqlStatement("SELECT chronolog_assert((SELECT units=? FROM inventory WHERE id=?), 'source_changed')", [expectedSource, from]),
        sqlStatement("SELECT chronolog_assert((SELECT units=? FROM inventory WHERE id=?), 'destination_changed')", [expectedDestination, to]),
        sqlStatement("SELECT chronolog_assert((SELECT units>=? FROM inventory WHERE id=?), 'insufficient_stock')", [units, from]),
        sqlStatement("SELECT chronolog_assert((SELECT units<=1000000-? FROM inventory WHERE id=?), 'destination_capacity')", [units, to]),
        sqlStatement('UPDATE inventory SET units=units-? WHERE id=?', [units, from]),
        sqlStatement('UPDATE inventory SET units=units+? WHERE id=?', [units, to]),
        sqlStatement('INSERT INTO transfers (id,source,destination,units,author,chronolog_owner) VALUES (?,?,?,?,lower(hex(chronolog_actor())),(SELECT id FROM chronolog_principals WHERE key=?))',
          [transferId, from, to, units, APPLICATION_COLLECTIVE_ID]),
        emit('inventory.transferred', { transferId, from, to, units }),
      ),
    }),
  },
  queries: {
    inventory: defineQuery({ description: 'Read both bins and a bounded set of transfer receipts from one coherent view',
      input: { type: 'null' }, async read(view) {
        const stock = await view.query('SELECT id,units FROM inventory ORDER BY id');
        const transfers = await view.query('SELECT id,source,destination,units,author FROM transfers ORDER BY id LIMIT 100');
        const activity = await view.readEvents({ topics: ['inventory.initialized', 'inventory.transferred'], limit: 128 });
        return {
          stock: stock.rows.map(([id, units]) => ({ id, units })),
          transfers: transfers.rows.map(([id, from, to, units, author]) => ({ id, from, to, units, author })),
          activity: activity.events.map(event => ({ topic: event.topic, payload: event.payload,
            author: event.author, operationId: event.operationId })),
          // This teaching query is bounded; do not treat the first activity page
          // or 100 receipts as an unbounded export or the complete application.
          nextActivityCursor: activity.hasMore ? activity.cursor : null,
        };
      },
    }),
  },
});
