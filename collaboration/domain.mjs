import { defineApplication, defineCommand, defineQuery } from '@chronolog/peer-session';
import { canonicalJson, COLLABORATION_LIMITS, CollaborationError, identifier, signerId, validateTarget } from './protocol.mjs';
import { readCollaborationTasks, readCollaborationResults, readCollaborationMessages, readCollaborationThread, readCollaborationTask, readCollaborationSnapshot } from './paging-read.mjs';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const id = text(160), signer = text(64), json = text(8192);
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const parse = (value, limit = 8192) => canonicalJson(JSON.parse(value), limit);
const compositeRecordId = (type, ...parts) => `${type}:${parts.map(value => `${identifier(value).length}:${value}`).join('')}`;

/**
 * Pure, static, content-addressable Chronolog ES Module reducer for addressed collaboration
 * over `chronolog:sqlite`. Reads per-log `limits` and `administrators` from `ctx.config` so
 * every Tendriller collaboration log deduplicates onto the exact same CAS hash.
 */
export const COLLABORATION_REDUCER_SOURCE = `
import { openDb } from 'chronolog:sqlite';

const DEFAULT_LIMITS = ${JSON.stringify(COLLABORATION_LIMITS)};
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

function resolveLimits(ctx) {
  const cfg = ctx && ctx.config && typeof ctx.config === 'object' ? ctx.config.limits : null;
  if (!cfg || typeof cfg !== 'object') return DEFAULT_LIMITS;
  return { ...DEFAULT_LIMITS, ...cfg };
}

function ensureSchema(db) {
  db.exec(\`
    CREATE TABLE IF NOT EXISTS collab_journal (
      id TEXT PRIMARY KEY NOT NULL,
      sequence INTEGER NOT NULL UNIQUE,
      type TEXT NOT NULL,
      task_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      author TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS collab_by_task ON collab_journal(task_id, sequence);
    CREATE INDEX IF NOT EXISTS collab_by_type ON collab_journal(type, sequence);
    CREATE INDEX IF NOT EXISTS collab_by_slot ON collab_journal(task_id, slot_id, type, sequence);
  \`, [], { mode: 'admin' });
}

function isAdmin(ctx, author) {
  const staticAdmins = ctx && ctx.config && Array.isArray(ctx.config.administrators) ? ctx.config.administrators : null;
  if (staticAdmins && staticAdmins.includes(author)) return true;
  const checked = ctx.query('$permissions', { check: 'administrator', actor: author });
  if (typeof checked === 'boolean') return checked;
  const perms = ctx.topic('$permissions');
  return Boolean(perms && Array.isArray(perms.members) && perms.members.some(m => m.publicKey === author && m.administrator === true));
}

function latestClaim(db, taskId, slotId) {
  const r = db.query(
    "SELECT id, sequence, type, author, proposal_id, body FROM collab_journal WHERE task_id = ? AND slot_id = ? AND type IN ('claim','handoff') ORDER BY sequence DESC LIMIT 1",
    [taskId, slotId],
  );
  if (!r.rows.length) return null;
  const [id, sequence, type, author, proposalId, body] = r.rows[0];
  return { id, sequence, type, author, proposalId, body: JSON.parse(body) };
}

function requestOf(db, taskId) {
  const r = db.query("SELECT id, author, body FROM collab_journal WHERE task_id = ? AND type = 'request' LIMIT 1", [taskId]);
  if (!r.rows.length) return null;
  return { id: r.rows[0][0], author: r.rows[0][1], body: JSON.parse(r.rows[0][2]) };
}

function isClosed(db, taskId) {
  return db.query("SELECT 1 FROM collab_journal WHERE task_id = ? AND type IN ('cancel','finalize') LIMIT 1", [taskId]).rows.length > 0;
}

function isCancelled(db, taskId) {
  return db.query("SELECT 1 FROM collab_journal WHERE task_id = ? AND type = 'cancel' LIMIT 1", [taskId]).rows.length > 0;
}

function hasAcceptedResult(db, taskId, slotId, responsePolicy) {
  if (responsePolicy === 'firstAccepted') {
    return db.query("SELECT 1 FROM collab_journal WHERE task_id = ? AND type = 'result' AND json_extract(body, '$.disposition') = 'accepted' LIMIT 1", [taskId]).rows.length > 0;
  }
  return db.query("SELECT 1 FROM collab_journal WHERE task_id = ? AND slot_id = ? AND type = 'result' AND json_extract(body, '$.disposition') = 'accepted' LIMIT 1", [taskId, slotId]).rows.length > 0;
}

function validId(v) { return typeof v === 'string' && ID_RE.test(v); }
function validSigner(v) { return typeof v === 'string' && HEX64_RE.test(v); }

export default {
  reduce(state, tx, ctx) {
  const LIMITS = resolveLimits(ctx);
  const payload = tx.payload;
  if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string' || typeof payload.recordId !== 'string') {
    return { ok: false, code: 'collab_envelope' };
  }
  const { type, recordId, taskId, slotId = '', body } = payload;
  if (!validId(taskId) || (slotId !== '' && !validId(slotId)) || !body || typeof body !== 'object') {
    return { ok: false, code: 'collab_identity' };
  }

  const db = openDb(state && state.dbRoot ? state.dbRoot : null);
  ensureSchema(db);

  // Idempotency by stable recordId with exact content/author matching.
  const existing = db.query('SELECT type, task_id, slot_id, author, body FROM collab_journal WHERE id = ?', [recordId]);
  if (existing.rows.length > 0) {
    const [exType, exTask, exSlot, exAuthor, exBodyStr] = existing.rows[0];
    const exBody = JSON.parse(exBodyStr);
    if (type === 'result') delete exBody.disposition;
    const candidateStr = JSON.stringify(body);
    const existingNorm = JSON.stringify(exBody);
    if (exType !== type || exTask !== taskId || exSlot !== slotId || exAuthor !== tx.author || existingNorm !== candidateStr) {
      return { ok: false, code: 'collab_identity_conflict' };
    }
    return { ok: true, state: { dbRoot: db.commit() }, events: [] };
  }

  const admin = isAdmin(ctx, tx.author);
  let storedBody = body;

  if (type === 'request') {
    if (slotId !== '') return { ok: false, code: 'collab_identity' };
    if (requestOf(db, taskId)) return { ok: false, code: 'collab_request_exists' };
    const reqCount = db.query("SELECT COUNT(*) FROM collab_journal WHERE type = 'request'").rows[0][0];
    if (reqCount >= LIMITS.requests) return { ok: false, code: 'collab_request_capacity' };
    if (!Array.isArray(body.slots) || body.slots.length < 1 || body.slots.length > LIMITS.slots) {
      return { ok: false, code: 'collab_slots' };
    }
    if (!['one', 'allSlots', 'firstAccepted', 'manual'].includes(body.responsePolicy)) {
      return { ok: false, code: 'collab_response_policy' };
    }
    if (body.responsePolicy === 'one' && body.slots.length !== 1) return { ok: false, code: 'collab_response_policy' };
    const seenSlots = new Set();
    for (const s of body.slots) {
      if (!s || !validId(s.slotId) || seenSlots.has(s.slotId)) return { ok: false, code: 'collab_duplicate_slot' };
      seenSlots.add(s.slotId);
      if (!Array.isArray(s.eligibleSigners) || s.eligibleSigners.length < 1 || s.eligibleSigners.length > 32 || !s.eligibleSigners.every(validSigner)) {
        return { ok: false, code: 'collab_eligibility' };
      }
    }
  } else if (type === 'message') {
    if (slotId !== '' || typeof body.text !== 'string' || body.text.length < 1 || body.text.length > 4000 || !validId(body.messageId)) {
      return { ok: false, code: 'collab_message_content' };
    }
    if (body.inReplyTo !== undefined && body.inReplyTo !== null) {
      const parent = db.query("SELECT 1 FROM collab_journal WHERE type = 'message' AND task_id = ? AND json_extract(body, '$.messageId') = ?", [taskId, body.inReplyTo]);
      if (!parent.rows.length) return { ok: false, code: 'collab_reply_missing' };
    }
  } else {
    const req = requestOf(db, taskId);
    if (!req) return { ok: false, code: 'collab_task_missing' };
    const slot = slotId ? req.body.slots.find(s => s.slotId === slotId) : null;
    if (['claim', 'handoff', 'result', 'ackCancel'].includes(type) && !slot) {
      return { ok: false, code: 'collab_slot_missing' };
    }
    const canManage = tx.author === req.author || admin;

    if (type === 'claim') {
      if (isClosed(db, taskId) || hasAcceptedResult(db, taskId, slotId, req.body.responsePolicy)) {
        return { ok: false, code: 'collab_task_closed' };
      }
      const prev = latestClaim(db, taskId, slotId);
      const expectedEpoch = (prev ? prev.body.epoch : 0) + 1;
      if (body.taskVersion !== 1 || body.epoch !== expectedEpoch) return { ok: false, code: 'collab_claim_conflict' };
      const authorized = prev === null
        ? slot.eligibleSigners.includes(tx.author)
        : (prev.type === 'handoff' && prev.body.assignee === tx.author);
      if (!authorized) return { ok: false, code: 'collab_claim_unauthorized' };
      const activeClaims = db.query(\`
        SELECT COUNT(*) FROM collab_journal c
        WHERE c.type = 'claim' AND c.author = ?
          AND NOT EXISTS (SELECT 1 FROM collab_journal n WHERE n.task_id = c.task_id AND n.slot_id = c.slot_id AND n.type IN ('claim','handoff') AND n.sequence > c.sequence)
          AND NOT EXISTS (SELECT 1 FROM collab_journal e WHERE e.task_id = c.task_id AND (e.type IN ('cancel','finalize') OR (e.type = 'result' AND e.slot_id = c.slot_id AND json_extract(e.body, '$.disposition') = 'accepted')))
      \`, [tx.author]).rows[0][0];
      if (activeClaims >= LIMITS.activeClaimsPerSigner) return { ok: false, code: 'collab_claim_capacity' };
    } else if (type === 'handoff') {
      if (isClosed(db, taskId) || hasAcceptedResult(db, taskId, slotId, req.body.responsePolicy)) {
        return { ok: false, code: 'collab_task_closed' };
      }
      const prev = latestClaim(db, taskId, slotId);
      if (!prev || prev.body.epoch + 1 !== body.epoch || (prev.author !== tx.author && !canManage)) {
        return { ok: false, code: 'collab_claim_conflict' };
      }
      if (!validSigner(body.assignee)) return { ok: false, code: 'collab_assignee' };
    } else if (type === 'result') {
      if (!validId(body.resultId) || !['succeeded', 'failed'].includes(body.outcome) || body.taskVersion !== 1) {
        return { ok: false, code: 'collab_result_content' };
      }
      const matchingClaim = db.query(\`
        SELECT 1 FROM collab_journal
        WHERE task_id = ? AND slot_id = ? AND type = 'claim' AND author = ?
          AND proposal_id = ? AND json_extract(body, '$.epoch') = ?
          AND json_extract(body, '$.runId') = ? AND json_extract(body, '$.endpointIncarnation') = ?
        LIMIT 1
      \`, [taskId, slotId, tx.author, body.claimProposalId, body.claimEpoch, body.runId, body.endpointIncarnation]);
      if (!matchingClaim.rows.length) return { ok: false, code: 'collab_result_author' };
      const slotResCount = db.query("SELECT COUNT(*) FROM collab_journal WHERE type = 'result' AND task_id = ? AND slot_id = ?", [taskId, slotId]).rows[0][0];
      if (slotResCount >= LIMITS.resultsPerSlot) return { ok: false, code: 'collab_result_capacity' };
      const dupRes = db.query("SELECT 1 FROM collab_journal WHERE type = 'result' AND task_id = ? AND json_extract(body, '$.resultId') = ? LIMIT 1", [taskId, body.resultId]);
      if (dupRes.rows.length) return { ok: false, code: 'collab_result_conflict' };

      const prev = latestClaim(db, taskId, slotId);
      const validLatestClaim = Boolean(
        prev && prev.type === 'claim' && prev.author === tx.author &&
        prev.proposalId === body.claimProposalId && prev.body.epoch === body.claimEpoch &&
        prev.body.runId === body.runId && prev.body.endpointIncarnation === body.endpointIncarnation
      );
      const disp = isCancelled(db, taskId)
        ? 'cancelled'
        : (validLatestClaim && !isClosed(db, taskId) && !hasAcceptedResult(db, taskId, slotId, req.body.responsePolicy))
          ? 'accepted'
          : 'superseded';
      storedBody = { ...body, disposition: disp };
    } else if (type === 'cancel') {
      if (!canManage || slotId !== '') return { ok: false, code: 'collab_cancel_unauthorized' };
      if (isClosed(db, taskId)) return { ok: false, code: 'collab_task_closed' };
      const ver = db.query('SELECT COUNT(*) FROM collab_journal WHERE task_id = ?', [taskId]).rows[0][0];
      if (body.expectedVersion !== ver) return { ok: false, code: 'collab_parent_changed' };
    } else if (type === 'ackCancel') {
      if (!isCancelled(db, taskId)) return { ok: false, code: 'collab_cancel_missing' };
      const prev = latestClaim(db, taskId, slotId);
      if (!prev || prev.type !== 'claim' || prev.author !== tx.author || prev.proposalId !== body.claimProposalId || prev.body.epoch !== body.claimEpoch) {
        return { ok: false, code: 'collab_claim_superseded' };
      }
      const dupAck = db.query("SELECT 1 FROM collab_journal WHERE type = 'ackCancel' AND task_id = ? AND slot_id = ? AND json_extract(body, '$.claimEpoch') = ? LIMIT 1", [taskId, slotId, body.claimEpoch]);
      if (dupAck.rows.length) return { ok: false, code: 'collab_cancel_ack_exists' };
    } else if (type === 'finalize') {
      if (!canManage || slotId !== '' || isClosed(db, taskId)) return { ok: false, code: 'collab_finalize_unauthorized' };
      const ver = db.query('SELECT COUNT(*) FROM collab_journal WHERE task_id = ?', [taskId]).rows[0][0];
      if (body.expectedVersion !== ver) return { ok: false, code: 'collab_parent_changed' };
      if (!Array.isArray(body.resultIds) || body.resultIds.length < 1 || body.resultIds.length > LIMITS.slots || new Set(body.resultIds).size !== body.resultIds.length) {
        return { ok: false, code: 'collab_aggregate_inputs' };
      }
      for (const rid of body.resultIds) {
        const hit = db.query("SELECT 1 FROM collab_journal WHERE task_id = ? AND type = 'result' AND json_extract(body, '$.resultId') = ? AND json_extract(body, '$.disposition') = 'accepted' LIMIT 1", [taskId, rid]);
        if (!hit.rows.length) return { ok: false, code: 'collab_result_missing' };
      }
      const rp = req.body.responsePolicy;
      const slotCount = req.body.slots.length;
      const complete =
        ((rp === 'one' || rp === 'firstAccepted') && body.resultIds.length === 1) ||
        (rp === 'allSlots' && body.resultIds.length === slotCount) ||
        (rp === 'manual' && (body.allowPartial === true || body.resultIds.length === slotCount));
      if (!complete) return { ok: false, code: 'collab_aggregate_incomplete' };
    } else {
      return { ok: false, code: 'collab_envelope' };
    }
  }

  const nextSeq = db.query('SELECT COALESCE(MAX(sequence), 0) + 1 FROM collab_journal').rows[0][0];
  db.exec(
    'INSERT INTO collab_journal(id, sequence, type, task_id, slot_id, author, proposal_id, operation_id, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [recordId, nextSeq, type, taskId, slotId, tx.author, tx.opId, tx.operationId, JSON.stringify(storedBody)],
    { mode: 'admin' },
  );

  return {
    ok: true,
    state: { dbRoot: db.commit() },
    events: [{ topic: 'collab.' + type, payload: { taskId, ...(slotId ? { slotId } : {}), recordId } }],
  };
  },

  query(state, input) {
    if (!state || !state.dbRoot) {
      if (input && typeof input.sql === 'string') {
        const s = input.sql.trim().toUpperCase();
        if (s === 'SELECT 1') return { columns: ['1'], rows: [[1]] };
        if (s.startsWith('SELECT COUNT(*)')) return { columns: ['COUNT(*)'], rows: [[0]] };
        return { columns: [], rows: [] };
      }
      return { count: 0 };
    }
    const db = openDb(state.dbRoot);
    if (input && typeof input.sql === 'string') {
      return db.query(input.sql, Array.isArray(input.params) ? input.params : []);
    }
    return { count: db.query('SELECT COUNT(*) FROM collab_journal').rows[0][0] };
  },
};
`.trimStart();

/** Validate collaboration bounds and administrators and return the static content-addressable reducer source. */
export function createCollaborationReducerSource({ administrators = [], limits: configured = {} } = {}) {
  const limits = { ...COLLABORATION_LIMITS, ...configured };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(COLLABORATION_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > COLLABORATION_LIMITS[key]) {
      throw new CollaborationError('INVALID_LIMIT', `Invalid collaboration bound: ${key}`);
    }
  }
  administrators.forEach(signerId);
  return COLLABORATION_REDUCER_SOURCE;
}

/**
 * Chronolog v2 collaboration application definition + ES Module reducer config.
 * Register `imports` and `topics` in `createLogGenesis(...)`, and pass `definition`
 * to `createApplicationSession(...)`.
 */
export function createCollaborationDefinition({
  id: definitionId = 'tendriller-collaboration',
  version = '2',
  administrators = [],
  limits: configured = {},
} = {}) {
  const limits = { ...COLLABORATION_LIMITS, ...configured };
  const reducerSource = createCollaborationReducerSource({ administrators, limits });
  const update = (type, recordId, taskId, slotId, body) => {
    identifier(taskId);
    if (slotId) identifier(slotId);
    return [{ topic: 'collab', input: { type, recordId, taskId, slotId, body } }];
  };

  const event = (type, description, input, prepare) => defineCommand({ description, input, prepare });
  const claimInput = object({
    taskId: id, slotId: id, claimId: id, runId: id, endpointIncarnation: text(200),
    expectedEpoch: integer, taskVersion: { type: 'integer', minimum: 1, maximum: 1 },
  });
  const resultInput = object({
    taskId: id, slotId: id, resultId: id, claimEpoch: integer, taskVersion: { type: 'integer', minimum: 1, maximum: 1 },
    claimProposalId: signer, runId: id, endpointIncarnation: text(200), outcome: { type: 'string', enum: ['succeeded', 'failed'] }, content: json,
  });
  const pageOptions = { limit: { type: 'integer', minimum: 1, maximum: 64 }, cursor: text(8192) };

  const queries = {
    'collab.snapshot': defineQuery({
      description: 'Bounded coherent preview with explicit task, result and message continuations; presence is separate',
      input: { type: 'null' },
      read: view => readCollaborationSnapshot(view),
    }),
    'collab.task': defineQuery({
      description: 'Current task/claim projection and bounded retained result evidence with explicit continuation',
      input: object({ taskId: id }),
      read: (view, { taskId }) => readCollaborationTask(view, taskId),
    }),
    'collab.interaction': defineQuery({
      description: 'Inspect the original addressed request after reconnect or an uncertain response',
      input: object({ interactionId: id }),
      read: (view, { interactionId }) => readCollaborationTask(view, interactionId),
    }),
    'collab.tasks': defineQuery({
      description: 'Page indexed current task cards, current claims and accepted result references; discovery grants no claim',
      input: object({
        ...pageOptions, limit: { type: 'integer', minimum: 1, maximum: 32 }, creator: signer, eligibleSigner: signer,
        state: { type: 'string', enum: ['all', 'open', 'closed'] },
      }, []),
      read: (view, input) => readCollaborationTasks(view, input),
    }),
    'collab.results': defineQuery({
      description: 'Page complete retained result evidence, including late and superseded work, within a captured revision',
      input: object({ ...pageOptions, taskId: id, slotId: id, disposition: { type: 'string', enum: ['accepted', 'superseded', 'cancelled'] } }, []),
      read: (view, input) => readCollaborationResults(view, input),
    }),
    'collab.messages': defineQuery({
      description: 'Page attributed durable messages, optionally selecting one thread',
      input: object({ ...pageOptions, threadId: id }, []),
      read: (view, input) => readCollaborationMessages(view, input),
    }),
    'collab.thread': defineQuery({
      description: 'Page one durable thread without reading unrelated application history',
      input: object({ ...pageOptions, threadId: id }, ['threadId']),
      read: (view, input) => readCollaborationThread(view, input),
    }),
  };

  const definition = defineApplication({
    id: definitionId,
    version,
    commands: {
      'collab.request': event('request', 'Create one addressed interaction with a frozen set of eligible contribution slots', object({
        interactionId: id, kind: text(128), title: text(256), input: json, target: text(2048), source: text(2048), context: text(2048),
        responsePolicy: { type: 'string', enum: ['one', 'allSlots', 'firstAccepted', 'manual'] },
        slots: {
          type: 'array', minItems: 1, maxItems: limits.slots,
          items: object({
            slotId: id,
            eligibleSigners: { type: 'array', minItems: 1, maxItems: 32, items: signer },
            label: text(128),
            agentBindingId: id,
          }, ['slotId', 'eligibleSigners']),
        },
      }), ({ interactionId, ...value }) => {
        validateTarget(JSON.parse(value.target));
        for (const slot of value.slots) { identifier(slot.slotId); slot.eligibleSigners.forEach(signerId); }
        return update('request', `request:${interactionId}`, interactionId, '', {
          ...value,
          input: parse(value.input, limits.payloadBytes),
          source: parse(value.source, 2048),
          context: parse(value.context, 2048),
          target: parse(value.target, 2048),
        });
      }),
      'collab.claim': event('claim', 'Provisionally claim one eligible slot at the current projection; late earlier operations can revise this outcome',
        claimInput, ({ taskId, slotId, claimId, expectedEpoch, ...value }) =>
          update('claim', `claim:${claimId}`, taskId, slotId, { ...value, claimId, epoch: expectedEpoch + 1 })),
      'collab.handoff': event('handoff', 'Explicitly supersede a claim and offer the slot to a named signing participant',
        object({ taskId: id, slotId: id, actionId: id, expectedEpoch: integer, assignee: signer, reason: text(1000) }),
        ({ taskId, slotId, actionId, expectedEpoch, ...value }) => {
          signerId(value.assignee);
          return update('handoff', `handoff:${actionId}`, taskId, slotId, { ...value, epoch: expectedEpoch + 1 });
        }),
      'collab.result': event('result', 'Retain a result under its original complete claim fence; current derived disposition may revise after late earlier operations',
        resultInput, ({ taskId, slotId, ...value }) =>
          update('result', compositeRecordId('result', taskId, value.resultId), taskId, slotId, { ...value, content: parse(value.content, limits.payloadBytes) })),
      'collab.cancel': event('cancel', 'Request cancellation durably; existing external effects remain inspectable',
        object({ taskId: id, actionId: id, expectedVersion: integer, reason: text(1000) }),
        ({ taskId, actionId, ...value }) => update('cancel', `cancel:${actionId}`, taskId, '', value)),
      'collab.acknowledgeCancel': event('ackCancel', 'Acknowledge stopping this current claim without claiming an external effect was undone',
        object({ taskId: id, slotId: id, actionId: id, claimEpoch: integer, claimProposalId: signer, runId: id, endpointIncarnation: text(200) }),
        ({ taskId, slotId, actionId, ...value }) => update('ackCancel', `ack:${actionId}`, taskId, slotId, value)),
      'collab.finalize': event('finalize', 'Accept an attributed aggregate against the exact reviewed parent version and contribution set',
        object({ taskId: id, actionId: id, expectedVersion: integer, resultIds: { type: 'array', items: id, minItems: 1, maxItems: limits.slots }, content: json, allowPartial: { type: 'boolean' } }),
        ({ taskId, actionId, ...value }) => update('finalize', `finalize:${actionId}`, taskId, '', { ...value, content: parse(value.content, limits.payloadBytes) })),
      'collab.message': event('message', 'Post a durable attributed thread message; observing a message grants no execution claim',
        object({ threadId: id, messageId: id, text: text(4000), source: text(2048), inReplyTo: id }, ['threadId', 'messageId', 'text', 'source']),
        ({ threadId, messageId, ...value }) =>
          update('message', compositeRecordId('message', threadId, messageId), threadId, '', { ...value, messageId, source: parse(value.source, 2048) })),
    },
    queries,
  });

  const admins = [...new Set(administrators.map(signerId))];
  const topicConfig = Object.freeze({ limits: Object.freeze(limits), administrators: Object.freeze(admins) });
  return Object.freeze({
    definition,
    reducerSource,
    imports: Object.freeze({ 'tendriller/collab': reducerSource }),
    packages: Object.freeze({
      'tendriller/collab': Object.freeze({
        name: 'tendriller/collab',
        version,
        files: Object.freeze({ 'index.js': reducerSource }),
        exports: Object.freeze({ '.': 'index.js' }),
        builtins: Object.freeze(['chronolog:sqlite']),
      }),
    }),
    topics: Object.freeze({
      collab: Object.freeze({ module: 'tendriller/collab', config: topicConfig }),
    }),
  });
}
