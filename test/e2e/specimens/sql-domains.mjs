export function checklist(log) {
  const collective = log.bytesToHex(log.APPLICATION_COLLECTIVE_ID);
  return log.defineApplication({
    id: 'staging-shared-tasks', version: '1',
    schema: log.program(
      'CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, claimed_by TEXT, done INTEGER NOT NULL DEFAULT 0)',
      'CREATE TABLE reservations (slot TEXT PRIMARY KEY, holder TEXT NOT NULL)'),
    commands: {
      add: log.defineCommand({
        description: 'Add a task and record a corresponding event',
        input: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } }, required: ['id', 'title'] },
        prepare: ({ id, title }) => log.program(log.sqlStatement(
          `INSERT INTO tasks (id,title,chronolog_owner) VALUES (?,?,(SELECT id FROM chronolog_principals WHERE key=X'${collective}'))`,
          [id, title]), log.emit('task.added', { id, title })),
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
      reserve: log.defineCommand({
        description: 'Reserve a specific resource and time slot', input: { type: 'string', maxLength: 80 },
        prepare: slot => log.program(log.sqlStatement(
          `INSERT INTO reservations (slot,holder,chronolog_owner) VALUES(?,lower(hex(chronolog_actor())),
            (SELECT id FROM chronolog_principals WHERE key=X'${collective}'))`, [slot]), log.emit('slot.reserved', { slot })),
      }),
      cancel: log.defineCommand({
        description: 'Release a reservation held by the signed-in device', input: { type: 'string', maxLength: 80 },
        prepare: slot => log.program(
          log.sqlStatement("SELECT chronolog_assert((SELECT holder=lower(hex(chronolog_actor())) FROM reservations WHERE slot=?),'holder_required')", [slot]),
          log.sqlStatement('DELETE FROM reservations WHERE slot=?', [slot]), log.emit('slot.released', { slot })),
      }),
    },
    queries: {
      reservations: log.defineQuery({ description: 'Read the current reservations', input: { type: 'null' },
        read: view => view.query('SELECT slot,holder FROM reservations ORDER BY slot').rows }),
      board: log.defineQuery({ description: 'Read tasks and their assignments from the same revision', input: { type: 'null' },
        read: view => view.query('SELECT id,title,claimed_by,done FROM tasks ORDER BY id LIMIT 200').rows }),
      assignment: log.defineQuery({ description: 'Read assignee and completion', input: { type: 'integer' },
        read: (view, id) => view.query('SELECT claimed_by,done FROM tasks WHERE id=?', [id]).rows[0] }),
      tasks: log.defineQuery({ description: 'Read ordered tasks', input: { type: 'null' },
        read: view => view.query('SELECT id,title FROM tasks ORDER BY id') }),
    },
  });
}

export function intake(log, respondent) {
  const collective = log.bytesToHex(log.APPLICATION_COLLECTIVE_ID);
  return log.defineApplication({
    id: 'staging-private-intake', version: '1',
    schema: log.program('CREATE TABLE answer (id INTEGER PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL)'),
    commands: {
      submit: log.defineCommand({
        description: 'Submit or correct a private answer at its expected revision',
        input: { type: 'object', properties: { body: { type: 'string', minLength: 1, maxLength: 2000 },
          revision: { type: 'integer', minimum: 0 } }, required: ['body', 'revision'] },
        prepare: ({ body, revision }) => log.program(
          log.sqlStatement("SELECT chronolog_assert(lower(hex(chronolog_actor()))=?,'respondent_required')", [respondent]),
          log.sqlStatement("SELECT chronolog_assert(coalesce((SELECT revision FROM answer WHERE id=1),0)=?,'stale_answer')", [revision]),
          log.sqlStatement(`INSERT INTO answer (id,body,revision,chronolog_owner)
            VALUES(1,?,?,(SELECT id FROM chronolog_principals WHERE key=X'${collective}'))
            ON CONFLICT(id) DO UPDATE SET body=excluded.body, revision=excluded.revision`, [body, revision + 1]),
          log.emit('answer.updated', { revision: revision + 1 })),
      }),
    },
    queries: {
      summary: log.defineQuery({ description: 'Review only count and source revision', input: { type: 'null' },
        read: view => view.query('SELECT COUNT(*),coalesce(MAX(revision),0) FROM answer').rows[0] }),
      answer: log.defineQuery({ description: 'Read the current private answer', input: { type: 'null' },
        read: view => view.query('SELECT body,revision FROM answer WHERE id=1').rows }),
    },
  });
}
