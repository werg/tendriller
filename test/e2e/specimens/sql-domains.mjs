// SQL specimen domains over the authored-time CRDT SQL materializer. The schema is NOT part of the
// definition: tables are created by an ordinary authorized `initialize` transaction (DDL and DML share
// original-signer authorization, authored-time ordering and atomic rollback), so a device that has not
// yet received that operation derives an empty view instead of failing, and a later operation that
// arrives earlier in authored time simply revises the derived rows.
//
// Rows are owned by the application's `group` collective, which only its admin (the root) may update by
// default. Crypto enrollment confers no SQL rights (nor DDL), so another member claims and finishes tasks
// only after the root's explicit `grantMember` permission transaction; only `initialize` creates objects.
export function checklist(log) {
  const group = log.bytesToHex(log.GROUP_COLLECTIVE_ID);
  const owner = `(SELECT id FROM chronolog_principals WHERE key=X'${group}')`;
  return log.defineApplication({
    id: 'staging-shared-tasks', version: '2',
    commands: {
      initialize: log.defineCommand({
        description: 'Create the application tables as an ordinary authorized atomic DDL transaction', input: { type: 'null' },
        prepare: () => log.program(
          log.sqlStatement('CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, claimed_by TEXT, done INTEGER NOT NULL DEFAULT 0)'),
          log.sqlStatement('CREATE TABLE reservations (slot TEXT PRIMARY KEY, holder TEXT NOT NULL)'),
          log.emit('checklist.initialized', {})),
      }),
      add: log.defineCommand({
        description: 'Add a task and record a corresponding event',
        input: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } }, required: ['id', 'title'] },
        prepare: ({ id, title }) => log.program(log.sqlStatement(
          `INSERT INTO tasks (id,title,chronolog_owner) VALUES (?,?,${owner})`, [id, title]), log.emit('task.added', { id, title })),
      }),
      claim: log.defineCommand({
        description: 'Claim an unfinished task', input: { type: 'integer' },
        prepare: id => log.program(
          log.sqlStatement("SELECT chronolog_assert((SELECT claimed_by IS NULL AND done=0 FROM tasks WHERE id=?),'task_unavailable')", [id]),
          log.sqlStatement('UPDATE tasks SET claimed_by=lower(hex(chronolog_actor())) WHERE id=?', [id]),
          log.emit('task.claimed', { id })),
      }),
      finish: log.defineCommand({
        description: 'Finish a task only as its claimant', input: { type: 'integer' },
        prepare: id => log.program(
          log.sqlStatement("SELECT chronolog_assert((SELECT claimed_by=lower(hex(chronolog_actor())) AND done=0 FROM tasks WHERE id=?),'claim_required')", [id]),
          log.sqlStatement('UPDATE tasks SET done=1 WHERE id=?', [id]),
          log.emit('task.finished', { id })),
      }),
      grantMember: log.defineCommand({
        description: 'Explicitly let one member key add, claim and finish group-owned tasks and hold reservations',
        input: { type: 'object', properties: { publicKey: { type: 'string', minLength: 64, maxLength: 64 } }, required: ['publicKey'], additionalProperties: false },
        prepare: ({ publicKey }) => {
          if (!/^[0-9a-f]{64}$/.test(publicKey)) throw new Error('Invalid member key');
          const grantee = log.hexToBytes(publicKey), grantor = log.GROUP_COLLECTIVE_ID;
          // Whole-table grants from the group: they cover group-owned rows only. Guards stay in each command.
          return log.program(
            log.platformOp.grant({ table: 'tasks', grantee, operations: ['insert'], grantor }),
            log.platformOp.grant({ table: 'tasks', grantee, operations: ['update'], columns: ['claimed_by', 'done'], grantor }),
            log.platformOp.grant({ table: 'reservations', grantee, operations: ['insert', 'delete'], grantor }));
        },
      }),
      reserve: log.defineCommand({
        description: 'Reserve a specific resource and time slot', input: { type: 'string', maxLength: 80 },
        prepare: slot => log.program(log.sqlStatement(
          `INSERT INTO reservations (slot,holder,chronolog_owner) VALUES(?,lower(hex(chronolog_actor())),${owner})`, [slot]),
        log.emit('slot.reserved', { slot })),
      }),
      cancel: log.defineCommand({
        description: 'Release a reservation held by the signed-in device', input: { type: 'string', maxLength: 80 },
        prepare: slot => log.program(
          log.sqlStatement("SELECT chronolog_assert((SELECT holder=lower(hex(chronolog_actor())) FROM reservations WHERE slot=?),'holder_required')", [slot]),
          log.sqlStatement('DELETE FROM reservations WHERE slot=?', [slot]), log.emit('slot.released', { slot })),
      }),
    },
    queries: {
      // SQL qualification that does not depend on application tables: it runs on the real engine against
      // the real materialized database before `initialize` has necessarily arrived.
      ready: log.defineQuery({ description: 'Read the engine catalog size to qualify SQL execution', input: { type: 'null' },
        read: async view => (await view.query('SELECT count(*) FROM sqlite_master')).rows }),
      reservations: log.defineQuery({ description: 'Read the current reservations', input: { type: 'null' },
        read: view => rowsOrEmpty(view, 'reservations', 'SELECT slot,holder FROM reservations ORDER BY slot') }),
      board: log.defineQuery({ description: 'Read tasks and their assignments from the same revision', input: { type: 'null' },
        read: view => rowsOrEmpty(view, 'tasks', 'SELECT id,title,claimed_by,done FROM tasks ORDER BY id LIMIT 200') }),
      assignment: log.defineQuery({ description: 'Read assignee and completion', input: { type: 'integer' },
        read: async (view, id) => (await rowsOrEmpty(view, 'tasks', 'SELECT claimed_by,done FROM tasks WHERE id=?', [id]))[0] }),
      tasks: log.defineQuery({ description: 'Read ordered tasks', input: { type: 'null' },
        read: view => rowsOrEmpty(view, 'tasks', 'SELECT id,title FROM tasks ORDER BY id') }),
    },
  });
}

export function intake(log, respondent) {
  const group = log.bytesToHex(log.GROUP_COLLECTIVE_ID);
  return log.defineApplication({
    id: 'staging-private-intake', version: '2',
    commands: {
      initialize: log.defineCommand({
        description: 'Create the answer table as an ordinary authorized atomic DDL transaction', input: { type: 'null' },
        prepare: () => log.program(
          log.sqlStatement('CREATE TABLE answer (id INTEGER PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL)'),
          log.emit('intake.initialized', {})),
      }),
      submit: log.defineCommand({
        description: 'Submit or correct the respondent answer at its expected revision',
        input: { type: 'object', properties: { body: { type: 'string', minLength: 1, maxLength: 2000 },
          revision: { type: 'integer', minimum: 0 } }, required: ['body', 'revision'] },
        prepare: ({ body, revision }) => log.program(
          log.sqlStatement("SELECT chronolog_assert(lower(hex(chronolog_actor()))=?,'respondent_required')", [respondent]),
          log.sqlStatement("SELECT chronolog_assert(coalesce((SELECT revision FROM answer WHERE id=1),0)=?,'stale_answer')", [revision]),
          log.sqlStatement(`INSERT INTO answer (id,body,revision,chronolog_owner)
            VALUES(1,?,?,(SELECT id FROM chronolog_principals WHERE key=X'${group}'))
            ON CONFLICT(id) DO UPDATE SET body=excluded.body, revision=excluded.revision`, [body, revision + 1]),
          log.emit('answer.updated', { revision: revision + 1 })),
      }),
    },
    queries: {
      ready: log.defineQuery({ description: 'Read the engine catalog size to qualify SQL execution', input: { type: 'null' },
        read: async view => (await view.query('SELECT count(*) FROM sqlite_master')).rows }),
      summary: log.defineQuery({ description: 'Review only count and source revision', input: { type: 'null' },
        read: async view => (await rowsOrEmpty(view, 'answer', 'SELECT COUNT(*),coalesce(MAX(revision),0) FROM answer'))[0] ?? [0, 0] }),
      answer: log.defineQuery({ description: 'Read the current respondent answer', input: { type: 'null' },
        read: view => rowsOrEmpty(view, 'answer', 'SELECT body,revision FROM answer WHERE id=1') }),
    },
  });
}

/** A device that has not materialized `initialize` yet has no table: derive an empty view, never an error. */
async function rowsOrEmpty(view, table, sql, parameters = []) {
  const catalog = await view.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]);
  return catalog.rows.length ? (await view.query(sql, parameters)).rows : [];
}
