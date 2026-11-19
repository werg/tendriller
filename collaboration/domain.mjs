import { APPLICATION_COLLECTIVE_ID, defineApplication, defineCommand, defineQuery,
  program, sqlStatement, emit } from '@chronolog/peer-session';
import { canonicalJson, COLLABORATION_LIMITS, CollaborationError, identifier, signerId, validateTarget } from './protocol.mjs';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const id = text(160), signer = text(64), json = text(8192);
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const actor = 'lower(hex(chronolog_actor()))';
// This reserved, engine-owned context exists only during an authenticated attempt.
const generation = '(SELECT lower(hex(generation)) FROM chronolog_execution_context WHERE singleton=1 AND transaction_id=chronolog_transaction_id())';
const j = (alias, key) => `json_extract(${alias}.body,'$.${key}')`;
const event = (type, description, input, prepare) => defineCommand({ description, input,
  prepare(value) { return prepare(value); } });
const parse = (value, limit = 8192) => canonicalJson(JSON.parse(value), limit);

/** Shared immutable schema: every admitted signed raw program meets the same triggers. */
export function createCollaborationDefinition({ id: definitionId = 'tendriller-collaboration', version = '1',
  administrators = [], limits: configured = {} } = {}) {
  const limits = { ...COLLABORATION_LIMITS, ...configured };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(COLLABORATION_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > COLLABORATION_LIMITS[key])
      throw new CollaborationError('INVALID_LIMIT', `Invalid collaboration bound: ${key}`);
  }
  const admins = [...new Set(administrators.map(signerId))];
  const admin = admins.length ? `${actor} IN (${admins.map(value => `'${value}'`).join(',')})` : '0';
  const body = key => j('NEW', key);
  const taskCreator = `(SELECT author FROM collab_journal WHERE type='request' AND task_id=NEW.task_id)`;
  const manage = `(NEW.author=${taskCreator} OR ${admin})`;
  const closed = `EXISTS (SELECT 1 FROM collab_journal WHERE task_id=NEW.task_id AND type IN ('cancel','finalize'))`;
  const validClaim = `EXISTS (SELECT 1 FROM collab_latest_claims c WHERE c.task_id=NEW.task_id AND c.slot_id=NEW.slot_id
    AND c.type IN ('claim','rebind') AND c.author=NEW.author AND c.generation=NEW.generation
    AND ${j('c', 'epoch')}=${body('claimEpoch')} AND ${j('c','runId')}=${body('runId')}
    AND ${j('c','endpointIncarnation')}=${body('endpointIncarnation')}
    AND ${body('generation')}=NEW.generation AND ${body('taskVersion')}=1)`;
  const previousAccepted = `EXISTS (SELECT 1 FROM collab_journal WHERE task_id=NEW.task_id
    AND (slot_id=NEW.slot_id OR (SELECT json_extract(body,'$.responsePolicy') FROM collab_journal WHERE type='request' AND task_id=NEW.task_id)='firstAccepted')
    AND type='result' AND json_extract(body,'$.disposition')='accepted')`;
  const disposition = `CASE
    WHEN EXISTS (SELECT 1 FROM collab_journal WHERE task_id=NEW.task_id AND type='cancel') THEN 'cancelled'
    WHEN ${body('generation')}<>NEW.generation THEN 'needsReview'
    WHEN ${validClaim} AND NOT (${closed}) AND NOT (${previousAccepted}) THEN 'accepted'
    ELSE 'superseded' END`;
  const assert = (predicate, code) => `SELECT chronolog_assert(COALESCE((${predicate}),0),'${code}');`;
  const schema = [
    `CREATE TABLE collab_journal (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 512),
      sequence INTEGER NOT NULL UNIQUE CHECK(sequence>0),
      type TEXT NOT NULL CHECK(type IN ('request','claim','rebind','handoff','result','cancel','ackCancel','finalize','message')),
      task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 160), slot_id TEXT NOT NULL,
      author TEXT NOT NULL CHECK(length(author)=64), generation TEXT NOT NULL CHECK(length(generation)=64),
      attempt_id BLOB NOT NULL CHECK(typeof(attempt_id)='blob' AND length(attempt_id)=32),
      body TEXT NOT NULL CHECK(json_valid(body) AND length(CAST(body AS BLOB))<=16384))`,
    'CREATE INDEX collab_by_task ON collab_journal(task_id,sequence)',
    'CREATE INDEX collab_by_slot ON collab_journal(task_id,slot_id,type,sequence)',
    `CREATE VIEW collab_latest_claims AS SELECT c.* FROM collab_journal c WHERE c.type IN ('claim','rebind','handoff')
      AND NOT EXISTS (SELECT 1 FROM collab_journal n WHERE n.task_id=c.task_id AND n.slot_id=c.slot_id
        AND n.type IN ('claim','rebind','handoff') AND n.sequence>c.sequence)`,
    `CREATE TRIGGER collab_no_update BEFORE UPDATE ON collab_journal BEGIN ${assert('0','collab_immutable')} END`,
    `CREATE TRIGGER collab_no_delete BEFORE DELETE ON collab_journal BEGIN ${assert('0','collab_immutable')} END`,
    `CREATE TRIGGER collab_admission BEFORE INSERT ON collab_journal BEGIN
      ${assert(`NEW.author=${actor}`, 'collab_author')}
      ${assert(`NEW.generation=${generation}`, 'collab_generation')}
      ${assert('NEW.attempt_id IS chronolog_transaction_id()', 'collab_attempt')}
      ${assert('NEW.sequence=(SELECT COALESCE(MAX(sequence),0)+1 FROM collab_journal)', 'collab_sequence')}
      ${assert(`NEW.type IN ('request','message') OR EXISTS (SELECT 1 FROM collab_journal WHERE task_id=NEW.task_id AND type='request')`, 'collab_task_missing')}
      ${assert(`NEW.type NOT IN ('claim','rebind','handoff','result','ackCancel') OR EXISTS
        (SELECT 1 FROM collab_journal r, json_each(r.body,'$.slots') s WHERE r.type='request'
          AND r.task_id=NEW.task_id AND json_extract(s.value,'$.slotId')=NEW.slot_id)`, 'collab_slot_missing')}
    END`,
    `CREATE TRIGGER collab_request BEFORE INSERT ON collab_journal WHEN NEW.type='request' BEGIN
      ${assert(`NOT EXISTS (SELECT 1 FROM collab_journal WHERE type='request' AND task_id=NEW.task_id)`, 'collab_request_exists')}
      ${assert(`(SELECT COUNT(*) FROM collab_journal WHERE type='request')<${limits.requests}`, 'collab_request_capacity')}
      ${assert(`NEW.slot_id='' AND json_type(NEW.body,'$.slots')='array' AND json_array_length(NEW.body,'$.slots') BETWEEN 1 AND ${limits.slots}`, 'collab_slots')}
      ${assert(`${body('responsePolicy')} IN ('one','allSlots','firstAccepted','manual') AND (${body('responsePolicy')}<>'one' OR json_array_length(NEW.body,'$.slots')=1)`, 'collab_response_policy')}
      ${assert(`(SELECT COUNT(DISTINCT json_extract(value,'$.slotId')) FROM json_each(NEW.body,'$.slots'))=json_array_length(NEW.body,'$.slots')`, 'collab_duplicate_slot')}
      ${assert(`NOT EXISTS (SELECT 1 FROM json_each(NEW.body,'$.slots') s WHERE
        COALESCE(json_type(s.value,'$.slotId'),'')<>'text' OR length(json_extract(s.value,'$.slotId')) NOT BETWEEN 1 AND 160
        OR COALESCE(json_type(s.value,'$.eligibleSigners'),'')<>'array' OR json_array_length(s.value,'$.eligibleSigners') NOT BETWEEN 1 AND 32
        OR EXISTS(SELECT 1 FROM json_each(s.value,'$.eligibleSigners') e WHERE e.type<>'text' OR length(e.value)<>64 OR e.value GLOB '*[^0-9a-f]*'))`, 'collab_eligibility')}
      ${assert(`json_valid(${body('input')}) AND length(CAST(${body('input')} AS BLOB))<=${limits.payloadBytes}
        AND json_valid(${body('target')}) AND json_valid(${body('source')}) AND json_valid(${body('context')})
        AND json_type(NEW.body,'$.title')='text' AND length(${body('title')}) BETWEEN 1 AND 256`, 'collab_request_content')}
    END`,
    `CREATE TRIGGER collab_claim BEFORE INSERT ON collab_journal WHEN NEW.type IN ('claim','rebind') BEGIN
      ${assert(`(NOT (${closed}) OR (NEW.type='rebind' AND NOT EXISTS (SELECT 1 FROM collab_journal WHERE task_id=NEW.task_id AND type='finalize'))) AND NOT (${previousAccepted})`, 'collab_task_closed')}
      ${assert(`${body('taskVersion')}=1 AND ${body('epoch')}=COALESCE((SELECT ${j('c','epoch')} FROM collab_latest_claims c WHERE c.task_id=NEW.task_id AND c.slot_id=NEW.slot_id),0)+1`, 'collab_claim_conflict')}
      ${assert(`length(${body('runId')}) BETWEEN 1 AND 160 AND length(${body('endpointIncarnation')}) BETWEEN 1 AND 200`, 'collab_claim_context')}
      ${assert(`(NEW.type='rebind' AND EXISTS (SELECT 1 FROM collab_latest_claims c WHERE c.task_id=NEW.task_id AND c.slot_id=NEW.slot_id
        AND c.type IN ('claim','rebind') AND c.author=NEW.author AND c.generation<>NEW.generation))
        OR (NEW.type='claim' AND (
          (NOT EXISTS (SELECT 1 FROM collab_latest_claims c WHERE c.task_id=NEW.task_id AND c.slot_id=NEW.slot_id)
            AND EXISTS (SELECT 1 FROM collab_journal r,json_each(r.body,'$.slots') s,json_each(s.value,'$.eligibleSigners') e
              WHERE r.type='request' AND r.task_id=NEW.task_id AND json_extract(s.value,'$.slotId')=NEW.slot_id AND e.value=NEW.author))
          OR EXISTS (SELECT 1 FROM collab_latest_claims c WHERE c.task_id=NEW.task_id AND c.slot_id=NEW.slot_id AND c.type='handoff' AND ${j('c','assignee')}=NEW.author)))`, 'collab_claim_unauthorized')}
      ${assert(`(SELECT COUNT(*) FROM collab_latest_claims c WHERE c.author=NEW.author AND c.type IN ('claim','rebind')
        AND c.generation=NEW.generation AND NOT EXISTS (SELECT 1 FROM collab_journal e WHERE e.task_id=c.task_id AND
          (e.type IN ('cancel','finalize') OR (e.type='result' AND e.slot_id=c.slot_id AND json_extract(e.body,'$.disposition')='accepted'))))<${limits.activeClaimsPerSigner}`, 'collab_claim_capacity')}
    END`,
    `CREATE TRIGGER collab_handoff BEFORE INSERT ON collab_journal WHEN NEW.type='handoff' BEGIN
      ${assert(`NOT (${closed}) AND NOT (${previousAccepted})`, 'collab_task_closed')}
      ${assert(`EXISTS (SELECT 1 FROM collab_latest_claims c WHERE c.task_id=NEW.task_id AND c.slot_id=NEW.slot_id
        AND ${j('c','epoch')}+1=${body('epoch')} AND (c.author=NEW.author OR ${manage}))`, 'collab_claim_conflict')}
      ${assert(`length(${body('assignee')})=64 AND ${body('assignee')} NOT GLOB '*[^0-9a-f]*'`, 'collab_assignee')}
    END`,
    `CREATE TRIGGER collab_result BEFORE INSERT ON collab_journal WHEN NEW.type='result' BEGIN
      ${assert(`EXISTS (SELECT 1 FROM collab_journal c WHERE c.task_id=NEW.task_id AND c.slot_id=NEW.slot_id
        AND c.type IN ('claim','rebind') AND c.author=NEW.author AND ${j('c','epoch')}=${body('claimEpoch')}
        AND c.generation=${body('generation')} AND ${j('c','runId')}=${body('runId')}
        AND ${j('c','endpointIncarnation')}=${body('endpointIncarnation')})`, 'collab_result_author')}
      ${assert(`${body('disposition')}=(${disposition})`, 'collab_result_disposition')}
      ${assert(`${body('outcome')} IN ('succeeded','failed') AND ${body('taskVersion')}=1
        AND json_valid(${body('content')}) AND length(CAST(${body('content')} AS BLOB))<=${limits.payloadBytes}
        AND length(${body('resultId')}) BETWEEN 1 AND 160`, 'collab_result_content')}
      ${assert(`(SELECT COUNT(*) FROM collab_journal WHERE type='result' AND task_id=NEW.task_id AND slot_id=NEW.slot_id)<${limits.resultsPerSlot}`, 'collab_result_capacity')}
      ${assert(`NOT EXISTS (SELECT 1 FROM collab_journal WHERE type='result' AND task_id=NEW.task_id AND json_extract(body,'$.resultId')=${body('resultId')})`, 'collab_result_conflict')}
    END`,
    `CREATE TRIGGER collab_cancel BEFORE INSERT ON collab_journal WHEN NEW.type='cancel' BEGIN
      ${assert(`${manage} AND NEW.slot_id=''`, 'collab_cancel_unauthorized')}
      ${assert(`NOT (${closed}) AND ${body('expectedVersion')}=(SELECT COUNT(*) FROM collab_journal WHERE task_id=NEW.task_id)`, 'collab_parent_changed')}
    END`,
    `CREATE TRIGGER collab_ack BEFORE INSERT ON collab_journal WHEN NEW.type='ackCancel' BEGIN
      ${assert(`EXISTS (SELECT 1 FROM collab_journal WHERE type='cancel' AND task_id=NEW.task_id)`, 'collab_cancel_missing')}
      ${assert(`${validClaim.replace(`${body('taskVersion')}=1`, '1')}`, 'collab_claim_superseded')}
      ${assert(`NOT EXISTS (SELECT 1 FROM collab_journal WHERE type='ackCancel' AND task_id=NEW.task_id AND slot_id=NEW.slot_id
        AND json_extract(body,'$.claimEpoch')=${body('claimEpoch')})`, 'collab_cancel_ack_exists')}
    END`,
    `CREATE TRIGGER collab_finalize BEFORE INSERT ON collab_journal WHEN NEW.type='finalize' BEGIN
      ${assert(`${manage} AND NEW.slot_id='' AND NOT (${closed})`, 'collab_finalize_unauthorized')}
      ${assert(`${body('expectedVersion')}=(SELECT COUNT(*) FROM collab_journal WHERE task_id=NEW.task_id)`, 'collab_parent_changed')}
      ${assert(`json_type(NEW.body,'$.resultIds')='array' AND json_array_length(NEW.body,'$.resultIds') BETWEEN 1 AND ${limits.slots}
        AND (SELECT COUNT(DISTINCT value) FROM json_each(NEW.body,'$.resultIds'))=json_array_length(NEW.body,'$.resultIds')`, 'collab_aggregate_inputs')}
      ${assert(`NOT EXISTS (SELECT 1 FROM json_each(NEW.body,'$.resultIds') i WHERE NOT EXISTS
        (SELECT 1 FROM collab_journal r WHERE r.task_id=NEW.task_id AND r.type='result'
          AND json_extract(r.body,'$.resultId')=i.value AND json_extract(r.body,'$.disposition')='accepted'))`, 'collab_result_missing')}
      ${assert(`EXISTS (SELECT 1 FROM collab_journal r WHERE r.type='request' AND r.task_id=NEW.task_id AND
        ((${j('r','responsePolicy')} IN ('one','firstAccepted') AND json_array_length(NEW.body,'$.resultIds')=1)
        OR (${j('r','responsePolicy')}='allSlots' AND json_array_length(NEW.body,'$.resultIds')=json_array_length(r.body,'$.slots'))
        OR (${j('r','responsePolicy')}='manual' AND (${body('allowPartial')}=1 OR json_array_length(NEW.body,'$.resultIds')=json_array_length(r.body,'$.slots')))))`, 'collab_aggregate_incomplete')}
      ${assert(`json_valid(${body('content')}) AND length(CAST(${body('content')} AS BLOB))<=${limits.payloadBytes}`, 'collab_aggregate_content')}
    END`,
    `CREATE TRIGGER collab_message BEFORE INSERT ON collab_journal WHEN NEW.type='message' BEGIN
      ${assert(`NEW.slot_id='' AND length(${body('text')}) BETWEEN 1 AND 4000 AND json_valid(${body('source')})`, 'collab_message_content')}
      ${assert(`${body('inReplyTo')} IS NULL OR EXISTS (SELECT 1 FROM collab_journal m WHERE m.type='message'
        AND m.task_id=NEW.task_id AND json_extract(m.body,'$.messageId')=${body('inReplyTo')})`, 'collab_reply_missing')}
    END`,
  ];
  function insert(type, eventId, taskId, slotId, input, { result = false } = {}) {
    identifier(taskId); if (slotId) identifier(slotId);
    const bodyJson = canonicalJson(input, 14000);
    // Stable identity + exact canonical content is idempotent across *new* operations too.
    // A retry cannot substitute another author or a changed result payload.
    const base = result ? "json_remove(body,'$.disposition')" : 'body';
    const prepareDisposition = disposition.replaceAll('NEW.task_id','candidate.task_id').replaceAll('NEW.slot_id','candidate.slot_id')
      .replaceAll('NEW.author','candidate.author').replaceAll('NEW.generation','candidate.generation').replaceAll('NEW.body','candidate.body');
    return program(
      sqlStatement(`SELECT chronolog_assert(NOT EXISTS (SELECT 1 FROM collab_journal WHERE id=? AND
        (type<>? OR task_id<>? OR slot_id<>? OR author<>${actor} OR ${base}<>?)),'collab_identity_conflict')`,
      [eventId, type, taskId, slotId, bodyJson]),
      sqlStatement(`INSERT INTO collab_journal(id,sequence,type,task_id,slot_id,author,generation,attempt_id,body,chronolog_owner)
        SELECT ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM collab_journal), ?, candidate.task_id,candidate.slot_id,
          candidate.author,candidate.generation,chronolog_transaction_id(),${result ? `json_set(candidate.body,'$.disposition',(${prepareDisposition}))` : 'candidate.body'},
          (SELECT id FROM chronolog_principals WHERE key=?)
        FROM (SELECT ? AS task_id,? AS slot_id,${actor} AS author,${generation} AS generation,? AS body) candidate
        WHERE NOT EXISTS (SELECT 1 FROM collab_journal WHERE id=?)`,
      [eventId, type, APPLICATION_COLLECTIVE_ID, taskId, slotId, bodyJson, eventId]),
      emit(`collab.${type}`, { taskId, ...(slotId ? { slotId } : {}), recordId: eventId }),
    );
  }
  const claimInput = object({ taskId: id, slotId: id, claimId: id, runId: id, endpointIncarnation: text(200),
    expectedEpoch: integer, taskVersion: { type: 'integer', minimum: 1, maximum: 1 } });
  const claimCommand = kind => event(kind, `${kind === 'rebind' ? 'Explicitly revalidate an old-generation claim' : 'Atomically claim one eligible slot'}; conflicts never dispatch duplicate work`,
    claimInput, ({ taskId, slotId, claimId, expectedEpoch, ...value }) => insert(kind, `${kind}:${claimId}`, taskId, slotId,
      { ...value, claimId, epoch: expectedEpoch + 1 }));
  const resultInput = object({ taskId: id, slotId: id, resultId: id, claimEpoch: integer, taskVersion: { type: 'integer', minimum: 1, maximum: 1 },
    generation: signer, runId: id, endpointIncarnation: text(200), outcome: { type: 'string', enum: ['succeeded','failed'] }, content: json });
  const queries = {
    'collab.snapshot': defineQuery({ description: 'Bounded coherent tasks, current claims, attributed results and conversation; presence is separate', input: { type: 'null' },
      read: view => readSnapshot(view) }),
    'collab.task': defineQuery({ description: 'Inspect a durable task, frozen recipients, claim fences, late results and aggregate provenance', input: object({ taskId: id }),
      read: (view, { taskId }) => readSnapshot(view, taskId) }),
    'collab.interaction': defineQuery({ description: 'Inspect the original addressed request after reconnect or an uncertain response', input: object({ interactionId: id }),
      read: (view, { interactionId }) => readSnapshot(view, interactionId) }),
  };
  return defineApplication({ id: definitionId, version, schema: program(...schema.map(value => sqlStatement(value))), commands: {
    'collab.request': event('request', 'Create one addressed interaction with a frozen set of eligible contribution slots', object({
      interactionId: id, kind: text(128), title: text(256), input: json, target: text(2048), source: text(2048), context: text(2048),
      responsePolicy: { type: 'string', enum: ['one','allSlots','firstAccepted','manual'] },
      slots: { type: 'array', minItems: 1, maxItems: limits.slots, items: object({ slotId: id,
        eligibleSigners: { type: 'array', minItems: 1, maxItems: 32, items: signer }, label: text(128), agentBindingId: id }, ['slotId','eligibleSigners']) },
    }), ({ interactionId, ...value }) => {
      validateTarget(JSON.parse(value.target));
      for (const slot of value.slots) { identifier(slot.slotId); slot.eligibleSigners.forEach(signerId); }
      return insert('request', `request:${interactionId}`, interactionId, '', { ...value,
        input: parse(value.input, limits.payloadBytes), source: parse(value.source, 2048), context: parse(value.context, 2048), target: parse(value.target, 2048) });
    }),
    'collab.claim': claimCommand('claim'), 'collab.rebind': claimCommand('rebind'),
    'collab.handoff': event('handoff', 'Explicitly supersede a claim and offer the slot to a named signing participant',
      object({ taskId: id, slotId: id, actionId: id, expectedEpoch: integer, assignee: signer, reason: text(1000) }),
      ({ taskId,slotId,actionId,expectedEpoch,...value }) => { signerId(value.assignee); return insert('handoff', `handoff:${actionId}`,taskId,slotId,{...value,epoch:expectedEpoch+1}); }),
    'collab.result': event('result', 'Retain a result under its original complete claim fence; late work cannot overwrite an accepted result', resultInput,
      ({taskId,slotId,...value}) => insert('result',`result:${taskId}:${value.resultId}`,taskId,slotId,{...value,content:parse(value.content,limits.payloadBytes)},{result:true})),
    'collab.cancel': event('cancel','Request cancellation durably; existing external effects remain inspectable',
      object({taskId:id,actionId:id,expectedVersion:integer,reason:text(1000)}),
      ({taskId,actionId,...value}) => insert('cancel',`cancel:${actionId}`,taskId,'',value)),
    'collab.acknowledgeCancel': event('ackCancel','Acknowledge stopping this current claim without claiming an external effect was undone',
      object({taskId:id,slotId:id,actionId:id,claimEpoch:integer,generation:signer,runId:id,endpointIncarnation:text(200)}),
      ({taskId,slotId,actionId,...value}) => insert('ackCancel',`ack:${actionId}`,taskId,slotId,value)),
    'collab.finalize': event('finalize','Accept an attributed aggregate against the exact reviewed parent version and contribution set',
      object({taskId:id,actionId:id,expectedVersion:integer,resultIds:{type:'array',items:id,minItems:1,maxItems:limits.slots},content:json,allowPartial:{type:'boolean'}}),
      ({taskId,actionId,...value}) => insert('finalize',`finalize:${actionId}`,taskId,'',{...value,content:parse(value.content,limits.payloadBytes)})),
    'collab.message': event('message','Post a durable attributed thread message; observing a message grants no execution claim',
      object({threadId:id,messageId:id,text:text(4000),source:text(2048),inReplyTo:id},['threadId','messageId','text','source']),
      ({threadId,messageId,...value}) => insert('message',`message:${threadId}:${messageId}`,threadId,'',{...value,messageId,source:parse(value.source,2048)})),
  }, queries });
}

function currentGeneration(view) { return typeof view.generation === 'string' ? view.generation : view.revision?.generation; }
// A signed writer can submit a raw ChangeProgram, so stored labels cannot prove
// which local attachment prepared it. Only the engine-authenticated author is
// verified here. Live owner endpoint bindings have a separate, local boundary.
function historicalSource(encoded, author) {
  const asserted = JSON.parse(encoded);
  const context = asserted && typeof asserted === 'object' && !Array.isArray(asserted) ? asserted : { assertion: asserted };
  return { ...context, ...(context.deviceId && context.deviceId !== author ? { assertedDeviceId: context.deviceId } : {}),
    deviceId: author, evidence: 'signer-asserted', contextEvidence: 'caller-asserted' };
}
async function readSnapshot(view, taskId) {
  const result = await view.query(`SELECT j.id,j.sequence,j.type,j.task_id,j.slot_id,j.author,j.generation,j.body,
      lower(hex(j.attempt_id)) AS attempt_id,t.operation_id,lower(hex(t.author_id)) AS verified_author,
      lower(hex(p.application_id)) AS application_id,lower(hex(g.generation)) AS verified_generation,t.outcome
    FROM collab_journal j LEFT JOIN chronolog_transactions t ON t.tx_id=j.attempt_id
      LEFT JOIN chronolog_attempt_generations g ON g.transaction_id=j.attempt_id
      LEFT JOIN chronolog_peer_control p ON p.singleton=1
    ${taskId ? 'WHERE j.task_id=?' : ''} ORDER BY j.sequence LIMIT 10001`, taskId ? [taskId] : []);
  if (result.rows.length > 10000) throw new CollaborationError('SNAPSHOT_TOO_LARGE', 'Query one task instead of the application-wide snapshot');
  const events = result.rows.map(([id,sequence,type,taskId,slotId,author,generation,body,attemptId,operationId,verifiedAuthor,applicationId,verifiedGeneration,outcome]) => {
    if (outcome!=='accepted' || verifiedAuthor!==author || verifiedGeneration!==generation || typeof operationId!=='string' ||
        !/^[0-9a-f]{64}$/u.test(applicationId) || !/^[0-9a-f]{64}$/u.test(attemptId))
      throw new CollaborationError('PROVENANCE_UNAVAILABLE','The selected domain record does not match its authenticated transaction evidence');
    return {id,sequence:Number(sequence),type,taskId,slotId,author,generation,body:JSON.parse(body),
      operation:Object.freeze({applicationId,author,operationId,attemptId,generation})};
  });
  const selectedGeneration = currentGeneration(view);
  const tasks = [], claims = [], results = [], messages = [];
  for (const record of events.filter(event => event.type === 'request')) {
    const entries = events.filter(event => event.taskId === record.taskId);
    const cancel = entries.find(event => event.type === 'cancel');
    const finalized = entries.find(event => event.type === 'finalize');
    const body = record.body;
    const task = {taskId:record.taskId,creator:record.author,generation:record.generation,operation:record.operation,taskVersion:1,version:entries.length,
      title:body.title,kind:body.kind,responsePolicy:body.responsePolicy,slots:body.slots,
      ...Object.fromEntries(['input','target','context'].map(key => [key,JSON.parse(body[key])])),
      source:historicalSource(body.source,record.author),
      cancellation:cancel?{...cancel.body,author:cancel.author,generation:cancel.generation,operation:cancel.operation}:null,
      status:finalized?'completed':cancel?'cancelRequested':'open',aggregate:finalized ? {
        ...finalized.body,content:JSON.parse(finalized.body.content),author:finalized.author,generation:finalized.generation,operation:finalized.operation,
        disposition: finalized.body.resultIds.length < body.slots.length && body.responsePolicy==='manual' ? 'partial' : 'complete',
      }:null};
    const taskClaims = [];
    for (const slot of body.slots) {
      const current = entries.filter(event => event.slotId===slot.slotId && ['claim','rebind','handoff'].includes(event.type)).at(-1);
      if (!current) continue;
      const completed=entries.some(event=>event.slotId===slot.slotId && event.type==='result' && event.body.disposition==='accepted');
      const ack=entries.find(event=>event.slotId===slot.slotId && event.type==='ackCancel' && event.body.claimEpoch===current.body.epoch);
      const claim={taskId:record.taskId,slotId:slot.slotId,claimEpoch:current.body.epoch,taskVersion:1,
        claimant:current.type==='handoff'?current.body.assignee:current.author,runId:current.body.runId??null,
        endpointIncarnation:current.body.endpointIncarnation??null,generation:current.generation,operation:current.operation,acknowledgement:ack?.operation??null,
        status:completed?'completed':cancel?(ack||current.type==='handoff'?'cancelled':'cancelRequested'):
          current.type==='handoff'?'offered':current.generation!==selectedGeneration?'needsReview':'active'};
      claims.push(claim);taskClaims.push(claim);
    }
    if(cancel&&taskClaims.every(claim=>['completed','cancelled'].includes(claim.status)))task.status='cancelled';
    else if(!finalized&&!cancel&&taskClaims.some(claim=>claim.status==='needsReview'))task.status='needsReview';
    tasks.push(task);
    for (const entry of entries.filter(event=>event.type==='result')) results.push({taskId:record.taskId,slotId:entry.slotId,
      ...entry.body,content:JSON.parse(entry.body.content),author:entry.author,operationRecord:entry.id,operation:entry.operation});
  }
  for(const entry of events.filter(event=>event.type==='message'))messages.push({threadId:entry.taskId,...entry.body,
    source:historicalSource(entry.body.source,entry.author),author:entry.author,generation:entry.generation,operation:entry.operation});
  return taskId ? {task:tasks[0]??null,claims,results} : {tasks,claims,results,messages};
}
