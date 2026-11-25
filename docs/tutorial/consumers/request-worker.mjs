// Run an actual request handler attached to an existing native owner.
// The page must already declare agentRequest/agentReceipt/agentAnswer + agentInbox.
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { announceAgentPresence } from '../shared/helpers/agent-requests.mjs';
import { consumeNativeEvents, openConsumerCheckpoint } from '../shared/helpers/agent-consumer.mjs';
import { createCliLifetime } from '../shared/cli-lifetime.mjs';

const review = () => Object.assign(Error('AGENT_CONSUMER_REVIEW_REQUIRED: reconcile the retained in-progress handler result before resuming.'),
  { code: 'AGENT_CONSUMER_REVIEW_REQUIRED' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matches = (event, session, topics) => event.topic === 'agent/request'
  && event.payload?.recipient === session.identity.publicKey && topics.includes(event.payload?.topic);

export async function runRequestWorker(session, {
  consumerId, topics, checkpointPath, scope, handleRequest, signal,
}) {
  if (typeof consumerId !== 'string' || !consumerId.trim() || consumerId.length > 128
    || !Array.isArray(topics) || !topics.length || topics.length > 32
    || topics.some(topic => typeof topic !== 'string' || !topic.trim() || topic.length > 128)
    || typeof handleRequest !== 'function' || scope === undefined) throw Error('AGENT_CONSUMER_OPTIONS_INVALID');
  const selectedTopics = [...new Set(topics)].sort(), runId = randomUUID();
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([session.signal, stopped.signal, signal].filter(Boolean));
  const store = await openConsumerCheckpoint(checkpointPath, {
    scope: { protocol: 'agent-request-worker-v1', application: scope, peer: session.identity.publicKey,
      consumerId, topics: selectedTopics },
  });
  let presence, state = store.read() ?? { cursor: undefined, pending: null };
  const save = () => store.save(state);
  const submitted = async (command, input, operationId, operationSignal) => {
    operationSignal.throwIfAborted();
    const attempt = await session.command(command, input, { operationId });
    const result = await attempt.materialized({ signal: AbortSignal.any([operationSignal, AbortSignal.timeout(30_000)]) });
    if (result.outcome !== 'accepted') throw Error('AGENT_CONSUMER_COMMAND_REJECTED');
  };
  try {
    if (!state || typeof state !== 'object' || !Object.hasOwn(state, 'pending')
      || state.pending && (!Array.isArray(state.pending.rows) || !Array.isArray(state.pending.sourceIds))) {
      throw Error('AGENT_CONSUMER_CHECKPOINT_INVALID');
    }
    if (state.pending?.rows.some(row => ['handling', 'uncertain'].includes(row.phase))) throw review();
    await consumeNativeEvents(session, {
      topics: ['agent/request'], signal: lifetime,
      loadCursor: () => state.cursor,
      onReady({ signal: observationSignal }) {
        presence = announceAgentPresence(session, { consumerId, runId,
          role: 'request-worker', topics: selectedTopics, signal: observationSignal });
      },
      async commitBatch(batch, { signal: batchSignal }) {
        const sourceIds = batch.events.map(event => event.id);
        // A retained in-progress request must still be an effective event; otherwise
        // a revision removed it and its handler work needs review before resuming.
        if (state.pending?.rows.some(row => !sourceIds.includes(row.eventId))) {
          throw Error('AGENT_CONSUMER_REVIEW_REVISION: pending requests no longer match the current coherent snapshot.');
        }
        const previous = new Map((state.pending?.rows ?? []).map(row => [row.eventId, row]));
        const rows = batch.events.filter(event => matches(event, session, selectedTopics)).map(event => {
          const request = { requestAuthor: event.author, requestOperationId: event.operationId,
            recipient: event.payload.recipient, topic: event.payload.topic, text: event.payload.text };
          const saved = previous.get(event.id);
          if (saved) {
            if (JSON.stringify(saved.request) !== JSON.stringify(request)) throw Error('AGENT_CONSUMER_REQUEST_CHANGED');
            return saved;
          }
          const id = digest([scope, session.identity.publicKey, consumerId, request.requestAuthor, request.requestOperationId]);
          return { eventId: event.id, request, runId, phase: 'prepared',
            receiptId: 'agent-receipt:' + id, answerId: 'agent-answer:' + id, idempotencyKey: id };
        });
        // Re-derivation after a stale cursor revisits handled requests; their durable
        // answers (not the cursor) say they need no further work. Read the inbox once.
        if (rows.some(row => row.phase === 'prepared')) {
          const inbox = (await session.query('agentInbox', null)).value;
          batchSignal.throwIfAborted();
          if (!Array.isArray(inbox?.requests)) throw Error('AGENT_CONSUMER_INBOX_INVALID');
          for (const row of rows.filter(item => item.phase === 'prepared')) {
            const existing = inbox.requests.find(request => request.requestAuthor === row.request.requestAuthor
              && request.requestOperationId === row.request.requestOperationId);
            if (!existing) throw Error('AGENT_CONSUMER_REVIEW_REVISION: request is absent from the current inbox.');
            if (existing.answers?.length) row.phase = 'completed';
          }
        }
        state.pending = { sourceIds, rows };
        await save();
        for (const row of rows) {
          batchSignal.throwIfAborted();
          if (row.phase === 'completed') continue;
          if (row.phase === 'handling' || row.phase === 'uncertain') throw review();
          if (!['prepared', 'received', 'result'].includes(row.phase)) throw Error('AGENT_CONSUMER_CHECKPOINT_INVALID');
          presence.setState('busy');
          const reference = { requestAuthor: row.request.requestAuthor,
            requestOperationId: row.request.requestOperationId, consumerId, runId: row.runId };
          if (row.phase === 'prepared') {
            await submitted('agentReceipt', reference, row.receiptId, batchSignal);
            row.phase = 'received'; await save();
          }
          if (row.phase === 'received') {
            batchSignal.throwIfAborted();
            row.phase = 'handling'; await save();
            try {
              const answer = await handleRequest(structuredClone(row.request), {
                signal: batchSignal, idempotencyKey: row.idempotencyKey,
              });
              batchSignal.throwIfAborted();
              if (typeof answer !== 'string' || !answer.length || answer.length > 8000) throw Error('AGENT_CONSUMER_ANSWER_INVALID');
              row.answer = answer; row.phase = 'result'; await save();
            } catch (cause) {
              row.phase = 'uncertain'; await save();
              throw Object.assign(review(), { cause });
            }
          }
          await submitted('agentAnswer', { ...reference, text: row.answer }, row.answerId, batchSignal);
          row.phase = 'completed'; await save();
        }
        batchSignal.throwIfAborted();
        // All results and exact signed attempts are durable before this watermark.
        state = { cursor: batch.cursor, pending: null };
        await save();
        presence.setState('listening');
      },
    });
  } finally {
    stopped.abort();
    try { await presence?.close(); } finally { await store.close(); }
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    workspace: { type: 'string' }, page: { type: 'string' }, consumer: { type: 'string' },
    topics: { type: 'string' }, checkpoint: { type: 'string' }, handler: { type: 'string' },
    echo: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('node consumers/request-worker.mjs --workspace /absolute/workspace --page SLUG --consumer assistant --topics \'["chat"]\' --checkpoint /private/assistant.json (--echo | --handler /absolute/handler.mjs)\n');
    return;
  }
  if (!values.workspace || !values.page || !values.consumer || !values.topics || !values.checkpoint
    || Boolean(values.echo) === Boolean(values.handler)) throw Error('Specify workspace, page, consumer, topics, checkpoint and exactly one of --echo or --handler.');
  const topics = JSON.parse(values.topics);
  const handleRequest = values.echo ? async request => 'Echo: ' + request.text.slice(0, 7994)
    : (await import(pathToFileURL(resolve(values.handler)).href)).handleRequest;
  const { openWorkspace, attachPage } = await import('@tendriller/tools/workspace');
  const lifetime = createCliLifetime();
  let attached;
  try {
    const workspace = await openWorkspace({ root: resolve(values.workspace) });
    const page = await workspace.page(values.page);
    attached = await attachPage(workspace, values.page, { signal: lifetime.signal });
    lifetime.opened();
    await runRequestWorker(attached.session, {
      consumerId: values.consumer, topics, checkpointPath: resolve(values.checkpoint),
      scope: { pageId: page.id, workspace: resolve(values.workspace) },
      handleRequest, signal: lifetime.signal,
    });
  } catch (error) { lifetime.fail(error); }
  finally {
    if (attached) {
      try { await attached.detach(); lifetime.closed(); } catch (error) { lifetime.fail(error); }
    }
    process.exitCode = await lifetime.finish();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; });
}
