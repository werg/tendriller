// Chronolog v2 SQL specimen domains over `chronolog:sqlite` + `chronolog/rls`.
// Tables and RLS policies are ordinary signed transactions inside the QuickJS-NG reducer,
// never static host schema metadata.

export const CHECKLIST_REDUCER = `
import { openDb } from 'chronolog:sqlite';
import { applyRls } from 'chronolog/rls';

export default {
  reduce(state, tx, ctx) {
    const db = openDb(state && state.dbRoot || null);
    const kind = tx.payload && tx.payload.kind;
    if (kind === 'initialize') {
      db.exec('CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL UNIQUE, claimed_by TEXT, done INTEGER NOT NULL DEFAULT 0)');
      db.exec('CREATE TABLE IF NOT EXISTS reservations (slot TEXT PRIMARY KEY, holder TEXT NOT NULL)');
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'checklist.initialized', payload: {} }] };
    }
    if (kind === 'add') {
      db.run('INSERT INTO tasks (id, title) VALUES (?, ?)', [tx.payload.id, tx.payload.title]);
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'task.added', payload: { id: tx.payload.id, title: tx.payload.title } }] };
    }
    if (kind === 'claim') {
      const rows = db.query('SELECT claimed_by, done FROM tasks WHERE id = ?', [tx.payload.id]);
      if (!rows.length || rows[0].claimed_by !== null || rows[0].done !== 0) return { ok: false, code: 'task_unavailable' };
      db.run('UPDATE tasks SET claimed_by = ? WHERE id = ?', [tx.author, tx.payload.id]);
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'task.claimed', payload: { id: tx.payload.id } }] };
    }
    if (kind === 'finish') {
      const rows = db.query('SELECT claimed_by, done FROM tasks WHERE id = ?', [tx.payload.id]);
      if (!rows.length || rows[0].claimed_by !== tx.author || rows[0].done !== 0) return { ok: false, code: 'claim_required' };
      db.run('UPDATE tasks SET done = 1 WHERE id = ?', [tx.payload.id]);
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'task.finished', payload: { id: tx.payload.id } }] };
    }
    if (kind === 'reserve') {
      db.run('INSERT INTO reservations (slot, holder) VALUES (?, ?)', [tx.payload.slot, tx.author]);
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'slot.reserved', payload: { slot: tx.payload.slot } }] };
    }
    if (kind === 'cancel') {
      const rows = db.query('SELECT holder FROM reservations WHERE slot = ?', [tx.payload.slot]);
      if (!rows.length || rows[0].holder !== tx.author) return { ok: false, code: 'holder_required' };
      db.run('DELETE FROM reservations WHERE slot = ?', [tx.payload.slot]);
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'slot.released', payload: { slot: tx.payload.slot } }] };
    }
    return { ok: false, code: 'UNKNOWN_KIND' };
  },
  query(state, input) {
    if (!state || !state.dbRoot) {
      if (input && input.kind === 'ready') return [[0]];
      return [];
    }
    const db = openDb(state.dbRoot);
    const hasTable = name => db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]).length > 0;
    const kind = input && input.kind;
    if (kind === 'ready') return [[db.query('SELECT count(*) AS c FROM sqlite_master')[0].c]];
    if (kind === 'reservations') return hasTable('reservations') ? db.query('SELECT slot, holder FROM reservations ORDER BY slot').map(r => [r.slot, r.holder]) : [];
    if (kind === 'board') return hasTable('tasks') ? db.query('SELECT id, title, claimed_by, done FROM tasks ORDER BY id LIMIT 200').map(r => [r.id, r.title, r.claimed_by, r.done]) : [];
    if (kind === 'assignment') return hasTable('tasks') ? db.query('SELECT claimed_by, done FROM tasks WHERE id = ?', [input.id]).map(r => [r.claimed_by, r.done])[0] ?? null : null;
    if (kind === 'tasks') return hasTable('tasks') ? db.query('SELECT id, title FROM tasks ORDER BY id').map(r => [r.id, r.title]) : [];
    return [];
  },
};
`;

export const INTAKE_REDUCER = `
import { openDb } from 'chronolog:sqlite';

export default {
  reduce(state, tx) {
    const db = openDb(state && state.dbRoot || null);
    const kind = tx.payload && tx.payload.kind;
    if (kind === 'initialize') {
      db.exec('CREATE TABLE IF NOT EXISTS answer (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)');
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'intake.initialized', payload: {} }] };
    }
    if (kind === 'submit') {
      const cur = db.query('SELECT revision FROM answer WHERE id = 1');
      if (cur.length && cur[0].revision !== tx.payload.revision) return { ok: false, code: 'revision_conflict' };
      db.run('INSERT INTO answer (id, body, revision) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, revision = excluded.revision', [tx.payload.body, tx.payload.revision + 1]);
      return { ok: true, state: { dbRoot: db.commit() }, events: [{ topic: 'intake.submitted', payload: { revision: tx.payload.revision + 1 } }] };
    }
    return { ok: false, code: 'UNKNOWN_KIND' };
  },
  query(state) {
    if (!state || !state.dbRoot) return [];
    const db = openDb(state.dbRoot);
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='answer'").length) return [];
    return db.query('SELECT body, revision FROM answer WHERE id = 1').map(r => [r.body, r.revision]);
  },
};
`;

export function checklist(log) {
  return log.defineApplication({
    id: 'staging-shared-tasks',
    version: '3',
    commands: {
      initialize: log.defineCommand({ description: 'Create application tables', input: { type: 'null' }, prepare: () => [{ topic: 'checklist', input: { kind: 'initialize' } }] }),
      add: log.defineCommand({ description: 'Add a task', input: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' } }, required: ['id', 'title'] }, prepare: ({ id, title }) => [{ topic: 'checklist', input: { kind: 'add', id, title } }] }),
      claim: log.defineCommand({ description: 'Claim a task', input: { type: 'integer' }, prepare: id => [{ topic: 'checklist', input: { kind: 'claim', id } }] }),
      finish: log.defineCommand({ description: 'Finish a task', input: { type: 'integer' }, prepare: id => [{ topic: 'checklist', input: { kind: 'finish', id } }] }),
      reserve: log.defineCommand({ description: 'Reserve a slot', input: { type: 'string', maxLength: 80 }, prepare: slot => [{ topic: 'checklist', input: { kind: 'reserve', slot } }] }),
      cancel: log.defineCommand({ description: 'Release a slot', input: { type: 'string', maxLength: 80 }, prepare: slot => [{ topic: 'checklist', input: { kind: 'cancel', slot } }] }),
    },
    queries: {
      ready: log.defineQuery({ description: 'Read catalog size', input: { type: 'null' }, read: view => view.query('checklist', { kind: 'ready' }) }),
      reservations: log.defineQuery({ description: 'Read reservations', input: { type: 'null' }, read: view => view.query('checklist', { kind: 'reservations' }) }),
      board: log.defineQuery({ description: 'Read board', input: { type: 'null' }, read: view => view.query('checklist', { kind: 'board' }) }),
      assignment: log.defineQuery({ description: 'Read assignment', input: { type: 'integer' }, read: (view, id) => view.query('checklist', { kind: 'assignment', id }) }),
      tasks: log.defineQuery({ description: 'Read tasks', input: { type: 'null' }, read: view => view.query('checklist', { kind: 'tasks' }) }),
    },
  });
}

export function intake(log) {
  return log.defineApplication({
    id: 'staging-private-intake',
    version: '3',
    commands: {
      initialize: log.defineCommand({ description: 'Create intake table', input: { type: 'null' }, prepare: () => [{ topic: 'intake', input: { kind: 'initialize' } }] }),
      submit: log.defineCommand({ description: 'Submit answer', input: { type: 'object', properties: { body: { type: 'string' }, revision: { type: 'integer' } }, required: ['body', 'revision'] }, prepare: ({ body, revision }) => [{ topic: 'intake', input: { kind: 'submit', body, revision } }] }),
    },
    queries: {
      answer: log.defineQuery({ description: 'Read answer', input: { type: 'null' }, read: view => view.query('intake', {}) }),
    },
  });
}
