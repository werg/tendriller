// Chronolog v2 SQL specimen domains over the built-in `chronolog/sql` standard reducer.
// Tables, preconditions, and RLS policies are ordinary signed transactions — zero custom reducer code!

export const CHECKLIST_TOPICS = Object.freeze({
  checklist: Object.freeze({ module: 'chronolog/sql' }),
});

export const INTAKE_TOPICS = Object.freeze({
  intake: Object.freeze({ module: 'chronolog/sql' }),
});

export function checklist(log) {
  return log.defineApplication({
    id: 'staging-shared-tasks',
    version: '3',
    commands: {
      initialize: log.defineCommand({
        description: 'Create application tables',
        input: { type: 'null' },
        prepare: () => [{
          topic: 'checklist',
          input: {
            action: 'migrate',
            statements: [
              'CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, claimed_by TEXT, done INTEGER NOT NULL DEFAULT 0)',
              'CREATE TABLE IF NOT EXISTS reservations (slot TEXT PRIMARY KEY, holder TEXT NOT NULL)',
            ],
            policies: {
              reservations: {
                insert: 'NEW.holder = actor()',
                delete: 'OLD.holder = actor()',
              },
            },
            events: [{ topic: 'checklist.initialized', payload: {} }],
          },
        }],
      }),
      add: log.defineCommand({
        description: 'Add a task',
        input: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } }, required: ['id', 'title'] },
        prepare: ({ id, title }) => [{
          topic: 'checklist',
          input: {
            statements: [{ sql: 'INSERT INTO tasks (id, title) VALUES (?, ?)', params: [id, title] }],
            events: [{ topic: 'task.added', payload: { id, title } }],
          },
        }],
      }),
      claim: log.defineCommand({
        description: 'Claim a task',
        input: { type: 'integer' },
        prepare: id => [{
          topic: 'checklist',
          input: {
            preconditions: [{
              sql: 'SELECT claimed_by IS NULL AND done = 0 FROM tasks WHERE id = ?',
              params: [id],
              code: 'task_unavailable',
            }],
            statements: [{ sql: 'UPDATE tasks SET claimed_by = actor() WHERE id = ?', params: [id] }],
            events: [{ topic: 'task.claimed', payload: { id } }],
          },
        }],
      }),
      finish: log.defineCommand({
        description: 'Finish a task',
        input: { type: 'integer' },
        prepare: id => [{
          topic: 'checklist',
          input: {
            preconditions: [{
              sql: 'SELECT claimed_by = actor() AND done = 0 FROM tasks WHERE id = ?',
              params: [id],
              code: 'claim_required',
            }],
            statements: [{ sql: 'UPDATE tasks SET done = 1 WHERE id = ?', params: [id] }],
            events: [{ topic: 'task.finished', payload: { id } }],
          },
        }],
      }),
      reserve: log.defineCommand({
        description: 'Reserve a slot',
        input: { type: 'string', maxLength: 80 },
        prepare: slot => [{
          topic: 'checklist',
          input: {
            statements: [{ sql: 'INSERT INTO reservations (slot, holder) VALUES (?, actor())', params: [slot] }],
            events: [{ topic: 'slot.reserved', payload: { slot } }],
          },
        }],
      }),
      cancel: log.defineCommand({
        description: 'Release a slot',
        input: { type: 'string', maxLength: 80 },
        prepare: slot => [{
          topic: 'checklist',
          input: {
            preconditions: [{
              sql: 'SELECT holder = actor() FROM reservations WHERE slot = ?',
              params: [slot],
              code: 'holder_required',
            }],
            statements: [{ sql: 'DELETE FROM reservations WHERE slot = ?', params: [slot] }],
            events: [{ topic: 'slot.released', payload: { slot } }],
          },
        }],
      }),
    },
    queries: {
      ready: log.defineQuery({
        description: 'Read catalog size',
        input: { type: 'null' },
        read: async view => (await view.query('checklist', { sql: 'SELECT count(*) AS c FROM sqlite_master' }))?.rows ?? [[0]],
      }),
      reservations: log.defineQuery({
        description: 'Read reservations',
        input: { type: 'null' },
        read: async view => (await view.query('checklist', { sql: 'SELECT slot, holder FROM reservations ORDER BY slot' }))?.rows ?? [],
      }),
      board: log.defineQuery({
        description: 'Read board',
        input: { type: 'null' },
        read: async view => (await view.query('checklist', { sql: 'SELECT id, title, claimed_by, done FROM tasks ORDER BY id LIMIT 200' }))?.rows ?? [],
      }),
      assignment: log.defineQuery({
        description: 'Read assignment',
        input: { type: 'integer' },
        read: async (view, id) => ((await view.query('checklist', { sql: 'SELECT claimed_by, done FROM tasks WHERE id = ?', params: [id] }))?.rows ?? [])[0] ?? null,
      }),
      tasks: log.defineQuery({
        description: 'Read tasks',
        input: { type: 'null' },
        read: async view => (await view.query('checklist', { sql: 'SELECT id, title FROM tasks ORDER BY id' }))?.rows ?? [],
      }),
    },
  });
}

export function intake(log) {
  return log.defineApplication({
    id: 'staging-private-intake',
    version: '3',
    commands: {
      initialize: log.defineCommand({
        description: 'Create intake table',
        input: { type: 'null' },
        prepare: () => [{
          topic: 'intake',
          input: {
            action: 'migrate',
            statements: [
              'CREATE TABLE IF NOT EXISTS answer (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)',
            ],
            events: [{ topic: 'intake.initialized', payload: {} }],
          },
        }],
      }),
      submit: log.defineCommand({
        description: 'Submit answer',
        input: { type: 'object', properties: { body: { type: 'string' }, revision: { type: 'integer' } }, required: ['body', 'revision'] },
        prepare: ({ body, revision }) => [{
          topic: 'intake',
          input: {
            preconditions: [{
              sql: 'SELECT NOT EXISTS (SELECT 1 FROM answer WHERE id = 1) OR EXISTS (SELECT 1 FROM answer WHERE id = 1 AND revision = ?)',
              params: [revision],
              code: 'revision_conflict',
            }],
            statements: [{
              sql: 'INSERT INTO answer (id, body, revision) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, revision = excluded.revision',
              params: [body, revision + 1],
            }],
            events: [{ topic: 'intake.submitted', payload: { revision: revision + 1 } }],
          },
        }],
      }),
    },
    queries: {
      answer: log.defineQuery({
        description: 'Read answer',
        input: { type: 'null' },
        read: async view => (await view.query('intake', { sql: 'SELECT body, revision FROM answer WHERE id = 1' }))?.rows ?? [],
      }),
    },
  });
}
