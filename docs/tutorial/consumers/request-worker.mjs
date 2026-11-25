// Run an actual message handler attached to an existing native owner.
// The page must already declare agentMessage/agentReceipt + agentFeed. A request is an
// agentMessage this agent should answer under the page roster (addressed to it, to
// everyone, or an unaddressed chat message while it is primary); its answer is an
// agentMessage reply carrying inReplyTo with the full original message identity.
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { announceAgentPresence, shouldAgentRespond } from '../shared/helpers/agent-requests.mjs';
import { consumeNativeEvents, openConsumerCheckpoint } from '../shared/helpers/agent-consumer.mjs';
import { createCliLifetime } from '../shared/cli-lifetime.mjs';

const review = () => Object.assign(Error('AGENT_CONSUMER_REVIEW_REQUIRED: reconcile the retained in-progress handler result before resuming.'),
  { code: 'AGENT_CONSUMER_REVIEW_REQUIRED' });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CHANNELS = new Set(['chat', 'agents']);
const messageOf = event => ({ author: event.author, operationId: event.operationId,
  channel: event.payload?.channel === 'agents' ? 'agents' : 'chat',
  to: Array.isArray(event.payload?.to) ? [...event.payload.to] : [], text: String(event.payload?.text ?? ''),
  hopCount: Number.isSafeInteger(event.payload?.hopCount) ? event.payload.hopCount : 0,
  expectReply: event.payload?.expectReply !== false });
const isReply = (candidate, self, message) => candidate.author === self
  && candidate.inReplyTo?.author === message.author && candidate.inReplyTo?.operationId === message.operationId;

/** `roster` returns the page roster ({ primary_agent_id, is_primary, agents }) at read time. */
export async function runRequestWorker(session, {
  consumerId, topics, checkpointPath, scope, handleRequest, roster, card = {}, signal,
}) {
  if (typeof consumerId !== 'string' || !consumerId.trim() || consumerId.length > 128
    || !Array.isArray(topics) || !topics.length || topics.length > 2
    || topics.some(topic => !CHANNELS.has(topic)) || typeof roster !== 'function'
    || typeof handleRequest !== 'function' || scope === undefined) throw Error('AGENT_CONSUMER_OPTIONS_INVALID');
  const selectedTopics = [...new Set(topics)].sort(), runId = randomUUID();
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([session.signal, stopped.signal, signal].filter(Boolean));
  const store = await openConsumerCheckpoint(checkpointPath, {
    scope: { protocol: 'agent-message-worker-v1', application: scope, peer: session.identity.publicKey,
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
      topics: ['agent/message'], signal: lifetime,
      loadCursor: () => state.cursor,
      onReady({ signal: observationSignal }) {
        presence = announceAgentPresence(session, { ...card, consumerId, runId,
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
        const self = session.identity.publicKey;
        const candidates = batch.events.filter(event => event.topic === 'agent/message'
          && !previous.has(event.id) && selectedTopics.includes(messageOf(event).channel));
        // The roster is host metadata read now; durable facts below remain authoritative.
        const currentRoster = candidates.length ? await roster({ signal: batchSignal }) : null;
        batchSignal.throwIfAborted();
        const rows = batch.events.filter(event => previous.has(event.id) || (candidates.includes(event)
          && shouldAgentRespond(messageOf(event), { selfPublicKey: self, roster: currentRoster }))).map(event => {
          const request = messageOf(event);
          const saved = previous.get(event.id);
          if (saved) {
            if (JSON.stringify(saved.request) !== JSON.stringify(request)) throw Error('AGENT_CONSUMER_REQUEST_CHANGED');
            return saved;
          }
          const id = digest([scope, self, consumerId, request.author, request.operationId]);
          return { eventId: event.id, request, runId, phase: 'prepared',
            receiptId: 'agent-receipt:' + id, answerId: 'agent-answer:' + id, idempotencyKey: id };
        });
        // Re-derivation after a stale cursor revisits handled messages; this agent's
        // durable reply (not the cursor) says they need no further work. Read the feed once.
        if (rows.some(row => row.phase === 'prepared')) {
          const feed = (await session.query('agentFeed', null)).value;
          batchSignal.throwIfAborted();
          if (!Array.isArray(feed?.messages) || !Array.isArray(feed?.activity)) throw Error('AGENT_CONSUMER_FEED_INVALID');
          const all = [...feed.messages, ...feed.activity];
          for (const row of rows.filter(item => item.phase === 'prepared')) {
            if (!all.some(item => item.author === row.request.author && item.operationId === row.request.operationId)) {
              throw Error('AGENT_CONSUMER_REVIEW_REVISION: message is absent from the current feed.');
            }
            if (all.some(item => isReply(item, self, row.request))) row.phase = 'completed';
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
          if (row.phase === 'prepared') {
            await submitted('agentReceipt', { messageAuthor: row.request.author,
              messageOperationId: row.request.operationId, runId: row.runId, state: 'seen' }, row.receiptId, batchSignal);
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
          await submitted('agentMessage', { channel: row.request.channel, to: [row.request.author], text: row.answer,
            inReplyTo: { author: row.request.author, operationId: row.request.operationId },
            hopCount: Math.min(16, row.request.hopCount + 1) }, row.answerId, batchSignal);
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
    process.stdout.write('node consumers/request-worker.mjs --workspace /absolute/workspace --page SLUG --consumer assistant --topics \'["chat"]\' --checkpoint /private/assistant.json (--echo | --handler /absolute/handler.mjs)\nTopics are message channels: chat and/or agents.\n');
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
    const page = await workspace.page(values.page), client = await workspace.client();
    const roster = async ({ signal } = {}) => {
      const info = await client.page(page.id).request('', { signal });
      return { primary_agent_id: info?.primary_agent_id ?? null, is_primary: Boolean(info?.is_primary),
        agents: Array.isArray(info?.agents) ? info.agents : [] };
    };
    attached = await attachPage(workspace, values.page, { signal: lifetime.signal });
    lifetime.opened();
    await runRequestWorker(attached.session, {
      consumerId: values.consumer, topics, checkpointPath: resolve(values.checkpoint),
      scope: { pageId: page.id, workspace: resolve(values.workspace) },
      handleRequest, roster, card: { handle: workspace.config.agent?.handle ?? '' }, signal: lifetime.signal,
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
