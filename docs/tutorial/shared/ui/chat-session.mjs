// Connects @tendriller/runtime/voice's mountAgentChat directly to a Tendriller
// Chronolog session: durable agentRequest/agentAnswer history, ephemeral live
// agent presence (zero durable heartbeat writes), and live streaming previews.
import { requestDelivery, watchAgentPresence, watchAgentStream } from '../helpers/agent-requests.mjs';

export async function mountConnectedAgentChat({
  runtime = window.tendril,
  session,
  peer,
  consumerId,
  container,
  title = 'Assistant',
  layout = container ? 'embedded' : 'dock',
  open,
  topic = 'chat',
  consentMode = 'auto',
  autoSendVoice = true,
  voiceOutput = 'browser',
  autoSpeak = false,
  handsFreeLoop = false,
  onAttach,
  loadVoice = () => import(runtime.assetUrl('voice.mjs')),
} = {}) {
  if (!runtime) throw Error('mountConnectedAgentChat requires window.tendril runtime');
  if (!session) throw Error('mountConnectedAgentChat requires a Chronolog session');
  if (!peer) throw Error('mountConnectedAgentChat requires an explicitly authorized agent participant public key');

  const voiceModule = await loadVoice();
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, session.signal].filter(Boolean));
  const optimistic = new Map();
  let inboxMessages = [];
  let refreshTail = Promise.resolve();

  const renderMerged = () => {
    const merged = [...inboxMessages];
    for (const pending of optimistic.values()) {
      if (!merged.some(m => m.id === pending.id)) merged.push(pending);
    }
    chat.setMessages(merged);
  };

  const chat = voiceModule.mountAgentChat(runtime, {
    container,
    title,
    layout,
    open,
    consentMode,
    autoSendVoice,
    voiceOutput,
    autoSpeak,
    handsFreeLoop,
    onAttach,
    async onSend({ text, via, context }) {
      const operationId = crypto.randomUUID();
      const body = context ? `[Context: ${typeof context === 'string' ? context : JSON.stringify(context)}]\n${text}` : text;
      optimistic.set(operationId, {
        id: operationId,
        role: 'user',
        text,
        at: Date.now(),
        status: 'sending',
        ...(context ? { contextLabel: typeof context === 'string' ? context : context.title || 'Card' } : {}),
      });
      renderMerged();
      try {
        const op = await session.command('agentRequest', {
          recipient: peer,
          topic,
          text: body.slice(0, 8000),
        }, { operationId });
        const item = optimistic.get(operationId);
        if (item) { item.status = 'stored'; renderMerged(); }
        const materialized = await op.materialized({ signal: AbortSignal.any([lifetime, AbortSignal.timeout(20_000)]) });
        if (materialized.outcome === 'rejected') throw Error(`Currently rejected (${materialized.rejectionCode ?? 'domain guard'}); original operation ${operationId} remains inspectable and its materialization is revisable.`);
        optimistic.delete(operationId);
        await refreshInbox();
      } catch (error) {
        const item = optimistic.get(operationId);
        if (item) { item.status = 'error'; renderMerged(); }
        throw error;
      }
    },
  });

  const refreshInbox = () => {
    const pending = refreshTail.then(async () => {
    if (lifetime.aborted) return;
    try {
      const result = await session.query('agentInbox', null);
      const requests = (result?.value?.requests ?? []).filter(r => r.recipient === peer && r.topic === topic);
      const next = [];
      for (const req of requests) {
        const phase = requestDelivery(req);
        next.push({
          id: req.requestOperationId,
          role: 'user',
          text: req.text,
          at: req.sentAtMs ?? undefined,
          status: phase === 'answered' ? 'answered' : phase === 'seen' ? 'seen' : 'delivered',
        });
        for (const ans of req.answers) {
          next.push({
            id: ans.operationId || `${req.requestOperationId}:${ans.eventId}`,
            role: 'agent',
            text: ans.text,
            at: ans.atMs ?? undefined,
          });
        }
      }
      inboxMessages = next;
      renderMerged();
    } catch { /* Initial or transient read failure will retry on next change. */ }
    });
    refreshTail = pending.catch(() => {});
    return pending;
  };

  const presence = watchAgentPresence(session, {
    peer,
    consumerId,
    requestTopic: topic,
    signal: lifetime,
    onChange(snap) {
      const status = snap.status === 'available' ? 'online'
        : snap.status === 'busy' ? 'busy'
        : snap.status === 'stopped' || snap.status === 'stale' ? 'offline' : 'unknown';
      const label = snap.status === 'available' ? 'Agent online'
        : snap.status === 'busy' ? 'Agent thinking…'
        : snap.status === 'stopped' ? 'Agent stopped'
        : snap.status === 'stale' ? 'Agent offline' : 'Connecting…';
      chat.setPresence({ status, label });
    },
  });

  const stream = watchAgentStream(session, {
    peer,
    signal: lifetime,
    onChunk(chunk) {
      chat.setStreamingReply(chunk.done ? null : chunk.text);
    },
  });

  const changeLoop = (async () => {
    try {
      for await (const _change of session.changes({ signal: lifetime })) {
        await refreshInbox();
      }
    } catch { /* closed */ }
  })();

  await refreshInbox();

  return Object.freeze({
    ...chat,
    refresh: refreshInbox,
    done: changeLoop,
    close() {
      stop.abort();
      presence.close();
      stream.close();
      chat.dispose();
    },
  });
}
