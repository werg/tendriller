import { canonicalJson, CollaborationError, identifier, signerId } from './protocol.mjs';

const CURSOR_PROTOCOL = 'tendriller.collaboration.page.v1';
const RECORD_BATCH = 8;
// The facade counts primitive values and array-index keys as well as UTF-8
// strings. These budgets compose below 1 MiB / 65,536 nodes even in snapshot(),
// reserving 128 KiB and 9,536 nodes for outer response/revision/cursor metadata.
const TASK_BUDGET = { json: 384 * 1024, bytes: 512 * 1024, nodes: 28_000 };
const EVIDENCE_BUDGET = { json: 128 * 1024, bytes: 192 * 1024, nodes: 14_000 };
const encoder = new TextEncoder();
const recordsSql = `SELECT j.id,j.sequence,j.type,j.task_id,j.slot_id,j.author,j.generation,j.body,
  lower(hex(j.attempt_id)),t.operation_id,lower(hex(t.author_id)),lower(hex(p.application_id)),lower(hex(g.generation)),t.outcome
  FROM collab_journal j LEFT JOIN chronolog_transactions t ON t.tx_id=j.attempt_id
    LEFT JOIN chronolog_attempt_generations g ON g.transaction_id=j.attempt_id
    LEFT JOIN chronolog_peer_control p ON p.singleton=1`;

function revisionOf(view) {
  const revision = view?.revision;
  if (!/^[0-9a-f]{64}$/u.test(revision?.applicationId) || typeof revision?.historyId !== 'string' || !revision.historyId ||
      !/^[0-9a-f]{64}$/u.test(revision?.generation))
    throw new CollaborationError('PROVENANCE_UNAVAILABLE', 'The captured view must identify its verified application, history and generation');
  return structuredClone(revision);
}
function integer(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new CollaborationError('PROVENANCE_UNAVAILABLE', 'The captured journal count or sequence is invalid');
  return result;
}
function optionsOf(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)))
    throw new CollaborationError('INVALID_PAGE_OPTIONS');
  return input;
}
function domainId(value) { identifier(value); if (value.length > 160) throw new CollaborationError('INVALID_IDENTITY'); return value; }
function source(encoded, author) {
  const assertion = JSON.parse(encoded), context = assertion && typeof assertion === 'object' && !Array.isArray(assertion) ? assertion : { assertion };
  return { ...context, ...(context.deviceId && context.deviceId !== author ? { assertedDeviceId: context.deviceId } : {}),
    deviceId: author, evidence: 'signer-asserted', contextEvidence: 'caller-asserted' };
}
function verified(row, revision) {
  const [id, sequence, type, taskId, slotId, author, generation, body, attemptId, operationId, verifiedAuthor, applicationId, verifiedGeneration, outcome] = row;
  if (outcome !== 'accepted' || verifiedAuthor !== author || verifiedGeneration !== generation || typeof operationId !== 'string' ||
      applicationId !== revision.applicationId || !/^[0-9a-f]{64}$/u.test(attemptId))
    throw new CollaborationError('PROVENANCE_UNAVAILABLE', 'The selected domain record does not match its authenticated transaction evidence');
  return { id, sequence: integer(sequence), type, taskId, slotId, author, generation, body: JSON.parse(body),
    operation: Object.freeze({ applicationId, historyId: revision.historyId, author, operationId, attemptId, generation }) };
}
async function count(view, where, parameters) {
  const result = await view.query(`SELECT COUNT(*) FROM collab_journal j WHERE ${where}`, parameters);
  return integer(result.rows[0]?.[0]);
}
async function* records(view, where, parameters, after = 0) {
  const revision = revisionOf(view);
  for (;;) {
    // A captured Worker view also returns these rows over a bounded facade.
    // Small SQL batches bound that inner response before the outer page budget.
    const result = await view.query(`${recordsSql} WHERE (${where}) AND j.sequence>? ORDER BY j.sequence LIMIT ${RECORD_BATCH}`, [...parameters, after]);
    for (const row of result.rows) { const record = verified(row, revision); after = record.sequence; yield record; }
    if (result.rows.length < RECORD_BATCH) return;
  }
}
async function selected(view, where, parameters, maximum) {
  const result = [];
  for await (const record of records(view, where, parameters)) {
    if (result.length >= maximum) throw new CollaborationError('PROVENANCE_UNAVAILABLE', 'The current projection exceeds its admitted domain bound');
    result.push(record);
  }
  return result;
}
function resultRecord(record, includeContent = true) {
  const body = record.body;
  return { taskId: record.taskId, slotId: record.slotId, resultId: body.resultId, claimEpoch: body.claimEpoch,
    taskVersion: body.taskVersion, generation: body.generation, runId: body.runId, endpointIncarnation: body.endpointIncarnation,
    outcome: body.outcome, disposition: body.disposition, ...(includeContent ? { content: JSON.parse(body.content) } : {}),
    author: record.author, operationRecord: record.id, operation: record.operation };
}
function messageRecord(record) {
  const body = record.body;
  return { threadId: record.taskId, messageId: body.messageId, text: body.text,
    ...(body.inReplyTo === undefined ? {} : { inReplyTo: body.inReplyTo }), source: source(body.source, record.author),
    author: record.author, generation: record.generation, operation: record.operation };
}

function sizeOf(value) {
  let nodes = 0, bytes = 0, deepest = 0;
  function visit(item, depth) {
    nodes++; deepest = Math.max(deepest, depth);
    if (typeof item === 'string') bytes += encoder.encode(item).length;
    else if (item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean') bytes += 8;
    else if (typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) { bytes += encoder.encode(key).length; visit(child, depth + 1); }
    } else throw new CollaborationError('PROVENANCE_UNAVAILABLE', 'The selected record contains an unsupported projected value');
  }
  visit(value, 0);
  return { json: encoder.encode(JSON.stringify(value)).length + 1, bytes, nodes, deepest };
}
function within(size, budget) {
  // Four levels remain for facade and named-query envelopes around a page item.
  return size.json <= budget.json && size.bytes <= budget.bytes && size.nodes <= budget.nodes && size.deepest <= 28;
}

function pageScope(view, query, filter, options, defaultLimit, maximum) {
  const revision = revisionOf(view), limit = options.limit ?? defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) throw new CollaborationError('INVALID_PAGE_OPTIONS');
  const scope = { protocol: CURSOR_PROTOCOL, query, filter, revision }; let after = 0;
  if (options.cursor !== undefined) {
    try {
      if (typeof options.cursor !== 'string' || encoder.encode(options.cursor).length > 8192) throw Error();
      const cursor = JSON.parse(options.cursor), { after: position, ...previous } = cursor;
      if (!Number.isSafeInteger(position) || position < 0 || canonicalJson(previous, 8192) !== canonicalJson(scope, 8192)) throw Error();
      after = position;
    } catch { throw new CollaborationError('CURSOR_RESET_REQUIRED', 'Capture a new reader and explicitly restart this query after its history, revision or filters change', { query }); }
  }
  return { scope, limit, after };
}
async function page(view, query, filter, options, { where, parameters, defaultLimit, maximum, budget, map }) {
  const { scope, limit, after } = pageScope(view, query, filter, options, defaultLimit, maximum);
  const total = await count(view, where, parameters), values = [];
  let used = { json: 2, bytes: 0, nodes: 0, deepest: 0 }, last = after, hasMore = false;
  for await (const record of records(view, where, parameters, after)) {
    if (values.length === limit) { hasMore = true; break; }
    const value = await map(record), size = sizeOf(value);
    const next = { json: used.json + size.json, bytes: used.bytes + size.bytes,
      nodes: used.nodes + size.nodes, deepest: Math.max(used.deepest, size.deepest) };
    if (!within(next, budget)) {
      if (!values.length) throw new CollaborationError('PAGE_ITEM_TOO_LARGE', 'The selected record exceeds the bounded read contract', { query, recordId: record.id });
      hasMore = true; break;
    }
    used = next; values.push(value); last = record.sequence;
  }
  return { values, page: { nextCursor: hasMore ? JSON.stringify({ ...scope, after: last }) : null,
    hasMore, total, returned: values.length, limit, revision: scope.revision } };
}

async function currentTask(view, request) {
  const taskId = request.taskId, body = request.body, revision = revisionOf(view);
  const version = await count(view, 'j.task_id=?', [taskId]);
  const controls = await selected(view, "j.task_id=? AND j.type IN ('cancel','finalize')", [taskId], 2);
  const current = await selected(view, 'j.id IN (SELECT id FROM collab_latest_claims WHERE task_id=?)', [taskId], 32);
  const acknowledgements = await selected(view, `j.task_id=? AND j.type='ackCancel' AND EXISTS (
    SELECT 1 FROM collab_latest_claims c WHERE c.task_id=j.task_id AND c.slot_id=j.slot_id
      AND json_extract(c.body,'$.epoch')=json_extract(j.body,'$.claimEpoch'))`, [taskId], 32);
  const accepted = await selected(view, "j.task_id=? AND j.type='result' AND json_extract(j.body,'$.disposition')='accepted'", [taskId], 32);
  const cancel = controls.find(record => record.type === 'cancel'), finalized = controls.find(record => record.type === 'finalize');
  const task = { taskId, creator: request.author, generation: request.generation, operation: request.operation, taskVersion: 1, version,
    title: body.title, kind: body.kind, responsePolicy: body.responsePolicy, slots: body.slots,
    ...Object.fromEntries(['input', 'target', 'context'].map(key => [key, JSON.parse(body[key])])), source: source(body.source, request.author),
    cancellation: cancel ? { reason: cancel.body.reason, expectedVersion: cancel.body.expectedVersion,
      author: cancel.author, generation: cancel.generation, operation: cancel.operation } : null,
    status: finalized ? 'completed' : cancel ? 'cancelRequested' : 'open',
    aggregate: finalized ? { resultIds: finalized.body.resultIds, expectedVersion: finalized.body.expectedVersion,
      content: JSON.parse(finalized.body.content), allowPartial: finalized.body.allowPartial, author: finalized.author,
      generation: finalized.generation, operation: finalized.operation,
      disposition: finalized.body.resultIds.length < body.slots.length && body.responsePolicy === 'manual' ? 'partial' : 'complete' } : null };
  const claims = [];
  for (const slot of body.slots) {
    const claim = current.find(record => record.slotId === slot.slotId); if (!claim) continue;
    const completed = accepted.some(record => record.slotId === slot.slotId);
    const acknowledgement = acknowledgements.find(record => record.slotId === slot.slotId && record.body.claimEpoch === claim.body.epoch);
    claims.push({ taskId, slotId: slot.slotId, claimEpoch: claim.body.epoch, taskVersion: 1,
      claimant: claim.type === 'handoff' ? claim.body.assignee : claim.author, runId: claim.type === 'handoff' ? null : claim.body.runId,
      endpointIncarnation: claim.type === 'handoff' ? null : claim.body.endpointIncarnation, generation: claim.generation, operation: claim.operation,
      acknowledgement: acknowledgement?.operation ?? null,
      status: completed ? 'completed' : cancel ? acknowledgement || claim.type === 'handoff' ? 'cancelled' : 'cancelRequested' :
        claim.type === 'handoff' ? 'offered' : claim.generation !== revision.generation ? 'needsReview' : 'active' });
  }
  if (cancel && claims.every(claim => ['completed', 'cancelled'].includes(claim.status))) task.status = 'cancelled';
  else if (!finalized && !cancel && claims.some(claim => claim.status === 'needsReview')) task.status = 'needsReview';
  return { task, claims, acceptedResults: accepted.map(record => resultRecord(record, false)) };
}

/** Indexed current-state projection. Historical claims/messages never enter the task cards. */
export async function readCollaborationTasks(view, input = {}) {
  const options = optionsOf(input, ['limit', 'cursor', 'creator', 'eligibleSigner', 'state']);
  const filter = { state: options.state ?? 'all' }, where = ["j.type='request'"], parameters = [];
  if (!['all', 'open', 'closed'].includes(filter.state)) throw new CollaborationError('INVALID_PAGE_OPTIONS');
  if (options.creator !== undefined) { filter.creator = signerId(options.creator); where.push('j.author=?'); parameters.push(filter.creator); }
  if (options.eligibleSigner !== undefined) {
    filter.eligibleSigner = signerId(options.eligibleSigner);
    where.push(`(EXISTS (SELECT 1 FROM json_each(j.body,'$.slots') s,json_each(s.value,'$.eligibleSigners') e WHERE e.value=?) OR
      EXISTS (SELECT 1 FROM collab_latest_claims c WHERE c.task_id=j.task_id AND
        CASE WHEN c.type='handoff' THEN json_extract(c.body,'$.assignee') ELSE c.author END=?))`);
    parameters.push(filter.eligibleSigner, filter.eligibleSigner);
  }
  if (filter.state !== 'all') where.push(`${filter.state === 'open' ? 'NOT ' : ''}EXISTS
    (SELECT 1 FROM collab_journal e WHERE e.task_id=j.task_id AND e.type IN ('cancel','finalize'))`);
  const result = await page(view, 'collab.tasks', filter, options, { where: where.join(' AND '), parameters,
    defaultLimit: 8, maximum: 32, budget: TASK_BUDGET, map: request => currentTask(view, request) });
  return { tasks: result.values.map(value => value.task), claims: result.values.flatMap(value => value.claims),
    acceptedResults: result.values.flatMap(value => value.acceptedResults), page: result.page };
}

/** Full result evidence is independent of current cards and remains explicitly pageable. */
export async function readCollaborationResults(view, input = {}) {
  const options = optionsOf(input, ['limit', 'cursor', 'taskId', 'slotId', 'disposition']);
  const filter = {}, where = ["j.type='result'"], parameters = [];
  for (const [key, column] of [['taskId', 'task_id'], ['slotId', 'slot_id']]) if (options[key] !== undefined) {
    filter[key] = domainId(options[key]); where.push(`j.${column}=?`); parameters.push(filter[key]);
  }
  if (options.disposition !== undefined) {
    if (!['accepted', 'superseded', 'cancelled', 'needsReview'].includes(options.disposition)) throw new CollaborationError('INVALID_PAGE_OPTIONS');
    filter.disposition = options.disposition; where.push("json_extract(j.body,'$.disposition')=?"); parameters.push(filter.disposition);
  }
  const result = await page(view, 'collab.results', filter, options, { where: where.join(' AND '), parameters,
    defaultLimit: 16, maximum: 64, budget: EVIDENCE_BUDGET, map: record => resultRecord(record) });
  return { results: result.values, page: result.page };
}
async function messages(view, input, query, required) {
  const options = optionsOf(input, ['limit', 'cursor', 'threadId']);
  const filter = {}, where = ["j.type='message'"], parameters = [];
  if (required || options.threadId !== undefined) { filter.threadId = domainId(options.threadId); where.push('j.task_id=?'); parameters.push(filter.threadId); }
  const result = await page(view, query, filter, options, { where: where.join(' AND '), parameters,
    defaultLimit: 20, maximum: 64, budget: EVIDENCE_BUDGET, map: messageRecord });
  return { messages: result.values, page: result.page };
}
export const readCollaborationMessages = (view, input = {}) => messages(view, input, 'collab.messages', false);
export const readCollaborationThread = (view, input) => messages(view, input, 'collab.thread', true);

export async function readCollaborationTask(view, taskId) {
  domainId(taskId);
  const requests = await selected(view, "j.type='request' AND j.task_id=?", [taskId], 1);
  const state = requests.length ? await currentTask(view, requests[0]) : { task: null, claims: [], acceptedResults: [] };
  if (!within(sizeOf(state), TASK_BUDGET)) throw new CollaborationError('PAGE_ITEM_TOO_LARGE', 'The current task exceeds the bounded read contract', { taskId });
  const evidence = await readCollaborationResults(view, { taskId });
  return { ...state, results: evidence.results, resultsPage: evidence.page };
}

/** Compatibility preview: every bounded subsection exposes its own continuation. */
export async function readCollaborationSnapshot(view) {
  const current = await readCollaborationTasks(view);
  const results = await readCollaborationResults(view), conversation = await readCollaborationMessages(view);
  return { tasks: current.tasks, claims: current.claims, acceptedResults: current.acceptedResults,
    results: results.results, messages: conversation.messages,
    pages: { tasks: current.page, results: results.page, messages: conversation.page } };
}
