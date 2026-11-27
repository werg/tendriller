// Connects @tendriller/runtime/voice's mountAgentChat to a multi-agent Chronolog
// session: durable agentMessage/agentReceipt feed (chat + agents backchannel),
// runtime.agents roster + primary selection, ephemeral multi-agent Agent Cards,
// concurrent streaming previews, and non-blocking primary failover UX.
import {
  evaluateFailover,
  messageDelivery,
  parseAddressing,
  watchAgentsPresence,
  watchAgentStreams,
} from '../helpers/agent-requests.mjs';
import { enableHostedMcp } from '../helpers/hosted-mcp.mjs';

export async function mountConnectedAgentChat({
  runtime = window.tendril,
  session,
  peers,
  container,
  title = 'Assistant',
  layout = container ? 'embedded' : 'dock',
  open,
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

  const voiceModule = await loadVoice();
  const stop = new AbortController();
  const lifetime = AbortSignal.any([stop.signal, session.signal].filter(Boolean));
  const optimistic = new Map();
  let lastFeed = { messages: [], activity: [], receipts: {} };
  let liveMap = {};
  let selectedTarget = null; // null = primary, agent.id = specific agent, '*' = @all
  let primaryOfflineSinceMs = null;
  let dismissedFailoverFor = null;
  let switchedFromPrimaryId = null;
  let refreshTail = Promise.resolve();

  const currentRoster = () => runtime.agents?.snapshot?.() ?? { primary_agent_id: null, agents: [], can_manage: false };
  const agentByKey = key => currentRoster().agents.find(a => a.public_key === key) ?? null;
  const agentById = id => currentRoster().agents.find(a => a.id === id) ?? null;

  const syncRosterToUi = () => {
    const roster = currentRoster();
    const items = roster.agents.map(agent => {
      const live = liveMap[agent.public_key] ?? liveMap[agent.id];
      const state = agent.kind === 'hosted-mcp'
        ? 'online'
        : (live?.state ?? 'unknown');
      return {
        id: agent.id,
        handle: agent.handle,
        bio: agent.bio,
        publicKey: agent.public_key,
        kind: agent.kind,
        isPrimary: agent.id === roster.primary_agent_id || agent.is_primary,
        state,
        enrolled: agent.kind === 'hosted-mcp' ? true : live?.enrolled,
      };
    });
    chat.setRoster({
      primaryId: roster.primary_agent_id ?? null,
      agents: items,
      targetId: selectedTarget,
      canSetPrimary: Boolean(roster.can_manage),
    });
    updateFailoverBanner();
  };

  const renderFeed = () => {
    const roster = currentRoster();
    const myKey = session.identity?.publicKey;
    const chatMessages = lastFeed.messages.map(m => {
      const sender = agentByKey(m.author);
      const isUser = !sender && m.author === myKey;
      const toHandles = (m.to ?? []).map(target => {
        if (target === '*') return '*';
        const hit = agentByKey(target);
        return hit ? hit.handle : target.slice(0, 8);
      });
      let attachments;
      if (Array.isArray(m.attachments) && m.attachments.length > 0) {
        let refsById = {};
        if (typeof m.data === 'string' && m.data.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(m.data);
            if (parsed && typeof parsed.attachmentRefs === 'object' && parsed.attachmentRefs) {
              refsById = parsed.attachmentRefs;
            }
          } catch { /* ignore */ }
        }
        attachments = m.attachments.map(a => ({
          contentId: a.contentId,
          name: a.name || 'image',
          mime: a.mime || 'application/octet-stream',
          ...(typeof a.size === 'number' ? { size: a.size } : {}),
          ...(refsById[a.contentId] !== undefined ? { ref: refsById[a.contentId] } : {}),
        }));
      }
      return {
        id: m.operationId || `${m.author}:${m.eventId}`,
        role: isUser ? 'user' : 'agent',
        text: m.text,
        at: m.atMs ?? undefined,
        ...(isUser ? { status: messageDelivery(m, lastFeed) } : {}),
        ...(sender ? {
          senderHandle: sender.handle,
          senderId: sender.id,
          isPrimary: sender.id === roster.primary_agent_id || sender.is_primary,
        } : {}),
        ...(toHandles.length ? { toHandles } : {}),
        ...(attachments ? { attachments } : {}),
      };
    });
    for (const pending of optimistic.values()) {
      if (!chatMessages.some(m => m.id === pending.id)) chatMessages.push(pending);
    }
    chat.setMessages(chatMessages);

    const activityItems = lastFeed.activity.map(item => {
      const sender = agentByKey(item.author);
      const toHandles = (item.to ?? []).map(t => t === '*' ? '*' : (agentByKey(t)?.handle ?? t.slice(0, 8)));
      return {
        id: item.operationId || `${item.author}:${item.eventId}`,
        senderHandle: sender?.handle ?? item.author.slice(0, 8),
        toHandles,
        text: item.text,
        at: item.atMs ?? undefined,
      };
    });
    chat.setActivity(activityItems);
    updateFailoverBanner();
  };

  const sendMessage = async ({ text, context, explicitTo, files }) => {
    const roster = currentRoster();
    const messageText = String(text ?? '').trim() || (files?.length ? (files.length === 1 ? 'Sent an image' : `Sent ${files.length} images`) : '');
    const parsed = parseAddressing(messageText, roster);
    let to = explicitTo ?? parsed.to;
    if (!explicitTo && to.length === 0 && selectedTarget) {
      if (selectedTarget === '*') {
        to = ['*'];
      } else {
        const chosen = agentById(selectedTarget);
        const isPrimary = chosen && (chosen.id === roster.primary_agent_id || chosen.is_primary);
        if (chosen && !isPrimary) to = [chosen.public_key];
      }
    }
    const operationId = crypto.randomUUID();
    const body = context ? `[Context: ${typeof context === 'string' ? context : JSON.stringify(context)}]\n${messageText}` : messageText;
    const attachments = [];
    const attachmentRefs = {};
    if (Array.isArray(files) && files.length > 0 && session.content?.put) {
      const visibility = session.genesis?.privateLog === false ? 'public' : 'private';
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const stored = await session.content.put(bytes, {
          visibility,
          mediaType: file.type || 'image/png',
          deduplicate: true,
        });
        const contentId = stored.id || stored.hash;
        attachmentRefs[contentId] = stored;
        attachments.push({
          contentId,
          name: file.name || 'image.png',
          mime: file.type || 'image/png',
          size: file.size,
        });
      }
    }
    optimistic.set(operationId, {
      id: operationId,
      role: 'user',
      text: messageText,
      at: Date.now(),
      status: 'sending',
      ...(attachments.length ? { attachments } : {}),
      ...(context ? { contextLabel: typeof context === 'string' ? context : context.title || 'Card' } : {}),
    });
    renderFeed();
    try {
      const payload = {
        channel: 'chat',
        to,
        text: body.slice(0, 8000),
        ...(attachments.length ? { attachments, data: JSON.stringify({ attachmentRefs }) } : {}),
      };
      const op = await session.command('agentMessage', payload, { operationId });
      const item = optimistic.get(operationId);
      if (item) { item.status = 'delivered'; renderFeed(); }
      const materialized = await op.materialized({ signal: AbortSignal.any([lifetime, AbortSignal.timeout(20_000)]) });
      if (materialized.outcome === 'rejected') {
        throw Error(`Currently rejected (${materialized.rejectionCode ?? 'domain guard'}); original operation ${operationId} remains inspectable.`);
      }
      optimistic.delete(operationId);
      await refreshFeed();
    } catch (error) {
      const item = optimistic.get(operationId);
      if (item) { item.status = 'error'; renderFeed(); }
      throw error;
    }
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
    onSelectTarget(target) {
      selectedTarget = target;
      syncRosterToUi();
    },
    async onSetPrimary(agentId) {
      await runtime.agents.setPrimary(agentId);
      selectedTarget = null;
      dismissedFailoverFor = null;
      syncRosterToUi();
    },
    async onSend({ text, context, files }) {
      await sendMessage({ text, context, files });
    },
  });

  const lastUnansweredUserMessage = () => {
    const myKey = session.identity?.publicKey;
    for (let i = lastFeed.messages.length - 1; i >= 0; i--) {
      const msg = lastFeed.messages[i];
      if (msg.author !== myKey) continue;
      if ((msg.to ?? []).length > 0) continue; // Only general messages depend on primary
      const delivery = messageDelivery(msg, lastFeed);
      if (delivery === 'delivered') {
        return { ...msg, sentAtMs: msg.atMs ?? Date.now() };
      }
      break;
    }
    return null;
  };

  const updateFailoverBanner = () => {
    const roster = currentRoster();
    const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    const primary = roster.agents.find(a => a.id === roster.primary_agent_id || a.is_primary) ?? null;

    // Track how long the current primary has been offline.
    if (primary && primary.kind !== 'hosted-mcp') {
      const live = liveMap[primary.public_key] ?? liveMap[primary.id];
      const healthy = live?.state === 'online' || live?.state === 'busy';
      if (healthy) primaryOfflineSinceMs = null;
      else if (primaryOfflineSinceMs === null) primaryOfflineSinceMs = Date.now();
    } else {
      primaryOfflineSinceMs = null;
    }

    // If we previously switched away from a primary and it came back online, offer a gentle return chip.
    if (switchedFromPrimaryId && switchedFromPrimaryId !== roster.primary_agent_id) {
      const original = agentById(switchedFromPrimaryId);
      const origLive = original ? (liveMap[original.public_key] ?? liveMap[original.id]) : null;
      if (original && (origLive?.state === 'online' || origLive?.state === 'busy')) {
        chat.setBanner({
          kind: 'info',
          message: `@${original.handle} is back online.`,
          actions: [
            { id: 'restore', label: roster.can_manage ? `Make @${original.handle} primary again` : `Switch back to @${original.handle}`, primary: true },
          ],
          async onAction() {
            if (roster.can_manage) await runtime.agents.setPrimary(original.id);
            else selectedTarget = original.id;
            switchedFromPrimaryId = null;
            chat.setBanner(null);
            syncRosterToUi();
          },
          onDismiss() {
            switchedFromPrimaryId = null;
            chat.setBanner(null);
          },
        });
        return;
      }
    }

    const failover = evaluateFailover({
      roster,
      liveMap,
      online,
      lastPendingUserMessage: lastUnansweredUserMessage(),
      primaryOfflineSinceMs,
    });
    if (!failover || dismissedFailoverFor === failover.primary.id) {
      chat.setBanner(null);
      return;
    }

    const { primary: p, backup, lastPendingUserMessage: pending } = failover;
    const reasonText = failover.reason === 'stopped'
      ? `@${p.handle} stopped.`
      : failover.reason === 'unacknowledged'
        ? `@${p.handle} hasn't picked up your last message.`
        : `@${p.handle} appears offline.`;
    const actions = roster.can_manage
      ? [
          ...(pending ? [{ id: 'switch-forward', label: `Switch primary to @${backup.handle} & forward`, primary: true }] : []),
          { id: 'switch', label: `Switch primary to @${backup.handle}`, primary: !pending },
        ]
      : [
          ...(pending ? [{ id: 'target-forward', label: `Send to @${backup.handle}`, primary: true }] : []),
          { id: 'target', label: `Message @${backup.handle} for now`, primary: !pending },
        ];

    chat.setBanner({
      kind: 'warning',
      message: `${reasonText} @${backup.handle} is online.`,
      actions,
      async onAction(actionId) {
        switchedFromPrimaryId = p.id;
        if (actionId === 'switch' || actionId === 'switch-forward') {
          await runtime.agents.setPrimary(backup.id);
          selectedTarget = null;
        } else {
          selectedTarget = backup.id;
        }
        chat.setBanner(null);
        syncRosterToUi();
        if ((actionId === 'switch-forward' || actionId === 'target-forward') && pending) {
          await sendMessage({
            text: pending.text,
            explicitTo: [backup.public_key],
          });
        }
      },
      onDismiss() {
        dismissedFailoverFor = p.id;
        chat.setBanner(null);
      },
    });
  };

  const refreshFeed = () => {
    const pending = refreshTail.then(async () => {
      if (lifetime.aborted) return;
      try {
        const result = await session.query('agentFeed', null);
        if (result?.value) {
          lastFeed = result.value;
          renderFeed();
        }
      } catch { /* Initial or transient read failure retries on next change. */ }
    });
    refreshTail = pending.catch(() => {});
    return pending;
  };

  const presence = watchAgentsPresence(session, {
    signal: lifetime,
    onChange(snap) {
      liveMap = snap;
      runtime.agents?.reportLiveStatus?.(snap);
      syncRosterToUi();
    },
  });

  const streams = watchAgentStreams(session, {
    signal: lifetime,
    onChange(entries) {
      chat.setStreamingReplies(entries.map(e => ({
        id: e.id,
        senderHandle: e.senderHandle ?? agentByKey(e.author)?.handle,
        text: e.text,
      })));
    },
  });

  const offAgents = runtime.agents?.onChange?.(() => {
    syncRosterToUi();
    renderFeed();
  }) ?? (() => {});

  const failoverTicker = setInterval(updateFailoverBanner, 5_000);
  const onOnlineChange = () => updateFailoverBanner();
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnlineChange);
    window.addEventListener('offline', onOnlineChange);
  }

  const changeLoop = (async () => {
    try {
      for await (const _change of session.changes({ signal: lifetime })) {
        await refreshFeed();
      }
    } catch { /* closed */ }
  })();

  const hostedMcp = peers
    ? enableHostedMcp({ runtime, session, peers, label: title, signal: lifetime })
    : null;

  await runtime.agents?.refresh?.().catch(() => {});
  syncRosterToUi();
  await refreshFeed();

  return Object.freeze({
    ...chat,
    refresh: refreshFeed,
    syncHostedMcp: () => hostedMcp?.syncNow?.() ?? Promise.resolve({ supported: false, uploaded: 0, merged: 0 }),
    done: changeLoop,
    close() {
      stop.abort();
      clearInterval(failoverTicker);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnlineChange);
        window.removeEventListener('offline', onOnlineChange);
      }
      hostedMcp?.close();
      offAgents();
      presence.close();
      streams.close();
      chat.dispose();
    },
  });
}
