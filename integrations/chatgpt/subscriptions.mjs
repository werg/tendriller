import { randomUUID } from 'node:crypto';
import { bounded, canonical, digest, fail, fields, text } from './common.mjs';
import { callbackUrl, verifyCallback, webhookKey, createPublicWebhookTransport } from './webhooks.mjs';

const descriptions = {
  'assistant.help_requested': 'A person explicitly requested help in the selected application. Fetch current authorized context before replying.',
  'inventory.review_requested': 'An application requests a person to review a bounded inventory observation. Photos are not included.',
  'shopping.trip_completed': 'A person marked a shopping trip complete. This is an optional summary notification.',
  'application.recovery_notice': 'The selected application history changed during recovery. Review uncertain or abandoned operations.',
};
export const EVENT_CATALOG = Object.freeze(Object.entries(descriptions).map(([name, description]) => ({
  name, description, delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { application_id: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['application_id'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: {
    application_id: { type: 'string' }, source_event_id: { type: 'string' }, source_operation_id: { type: 'string' },
    request_id: { type: 'string' }, kind: { type: 'string' }, summary: { type: 'string', maxLength: 512 },
    selected_generation: { type: 'string' }, context_revision: { type: 'object' }, details_tool: { type: 'string' },
  }, required: ['application_id', 'source_event_id', 'selected_generation'], additionalProperties: false },
})));

export function ownerIdentity(principal) {
  return { id: text(principal?.id, 'principal ID', 512), issuer: text(principal?.issuer, 'issuer', 2048) };
}
export function subscriptionIdentity(principal, name, args, url) {
  return 'sub_' + digest([ownerIdentity(principal), url, name, args]);
}

export function createSubscriptions({ store, authorize, captureCursor, applicationIds,
  send = createPublicWebhookTransport(), clock = Date.now, ttlMs = 86400000,
  maxTtlMs = 604800000, maxPerOwner = 50, catalog = EVENT_CATALOG } = {}) {
  if (!store || typeof authorize !== 'function' || typeof captureCursor !== 'function' || typeof applicationIds !== 'function')
    fail('SUBSCRIPTION_CONFIGURATION_REQUIRED', 'Subscriptions require durable storage, account consent and a selected-history cursor reader');
  if (![ttlMs, maxTtlMs, maxPerOwner].every(value => Number.isSafeInteger(value) && value > 0))
    fail('SUBSCRIPTION_CONFIGURATION_REQUIRED', 'Subscription lifetimes and quota must be positive safe integers');
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) { try { listener(); } catch { /* observers own their failures */ } } };
  const validate = (params, subscription) => {
    fields(params, subscription ? ['name', 'arguments', 'delivery', 'cursor', 'ttlMs'] : ['name', 'arguments', 'delivery'], ['name', 'arguments', 'delivery']);
    if (!catalog.some(event => event.name === params.name)) fail('EVENT_NOT_FOUND', 'Unknown event name');
    fields(params.arguments, ['application_id'], ['application_id']);
    text(params.arguments.application_id, 'application ID', 128);
    fields(params.delivery, subscription ? ['mode', 'url', 'secret'] : ['mode', 'url'], subscription ? ['mode', 'url', 'secret'] : ['mode', 'url']);
    if (params.delivery.mode !== 'webhook') fail('DELIVERY_MODE_UNSUPPORTED', 'Only webhook delivery is supported');
    const url = callbackUrl(params.delivery.url);
    if (subscription) {
      if (params.cursor !== undefined && params.cursor !== null) fail('REPLAY_UNSUPPORTED', 'This event catalog does not expose protocol replay cursors');
      webhookKey(params.delivery.secret);
      if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0))
        fail('INVALID_TTL', 'ttlMs must be a positive safe integer or null');
    }
    return url;
  };
  const result = sub => ({ id: sub.id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: null, truncated: false });
  return {
    catalog,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async list(principal) {
      const apps = await applicationIds(principal), available = [];
      for (const event of catalog) for (const applicationId of apps) {
        try { await authorize(ownerIdentity(principal), applicationId, event.name); available.push(event); break; } catch { /* do not disclose inaccessible event types */ }
      }
      return { events: structuredClone(available) };
    },
    async subscribe(principal, params, { signal } = {}) {
      const url = validate(params, true), owner = ownerIdentity(principal);
      const applicationId = params.arguments.application_id;
      const id = subscriptionIdentity(principal, params.name, params.arguments, url);
      const attempt = randomUUID();
      // Reserve before the first asynchronous authorization. Unsubscribe can
      // remove this exact attempt; a later completion must never resurrect it.
      const previous = await store.transaction(state => {
        state.subscriptions ??= {};
        for (const [key, item] of Object.entries(state.subscriptions))
          if ((!item.active || item.expiresAt <= clock()) && !(item.pendingUntil > clock())) delete state.subscriptions[key];
        const current = state.subscriptions[id];
        if (current?.pendingUntil > clock()) fail('SUBSCRIPTION_PENDING', 'Subscription verification is already pending', { status: 409 });
        const count = Object.values(state.subscriptions).filter(item => item.id !== id &&
          (item.active && item.expiresAt > clock() || item.pendingUntil > clock()) && canonical(item.owner) === canonical(owner)).length;
        if (count >= maxPerOwner) fail('SUBSCRIPTION_LIMIT', 'Too many active or pending subscriptions', { status: 429 });
        const before = current ? structuredClone(current) : null;
        state.subscriptions[id] = { ...(current ?? { id, owner, applicationId, name: params.name, active: false, version: 0 }),
          pendingToken: attempt, pendingUntil: clock() + 60000 };
        return before;
      });
      try {
        await authorize(owner, applicationId, params.name);
        const secret = params.delivery.secret, canReuse = previous?.active && previous.expiresAt > clock();
        const cachedVerification = canReuse && previous.secret === secret && previous.verifiedAt > clock() - 300000;
        if (!cachedVerification) await verifyCallback({ subscriptionId: id, url, secret, send, now: clock(), signal });
        // Internal crash recovery uses the selected tail; cursor:null promises
        // no protocol replay. Refresh must preserve any concurrently advanced cursor.
        const baseline = canReuse ? null : await captureCursor(applicationId);
        await authorize(owner, applicationId, params.name);
        const now = clock();
        const sub = await store.transaction(state => {
          const current = state.subscriptions?.[id];
          if (current?.pendingToken !== attempt || current.pendingUntil <= now)
            fail('SUBSCRIPTION_CHANGED', 'Subscription changed while authorization or callback verification was in progress; refresh explicitly', { status: 409 });
          const replacement = { id, owner, applicationId, name: params.name, arguments: bounded(params.arguments), url, secret,
            active: true, version: (current.version ?? 0) + 1, createdAt: canReuse ? previous.createdAt : now,
            verifiedAt: cachedVerification ? previous.verifiedAt : now,
            expiresAt: now + Math.min(params.ttlMs ?? ttlMs, maxTtlMs),
            sourceCursor: (canReuse ? current.sourceCursor : baseline.cursor) ?? null,
            sourceRevision: (canReuse ? current.sourceRevision : baseline.revision) ?? null,
            pausedReason: canReuse ? current.pausedReason ?? null : null,
            recoveryRevision: canReuse ? current.recoveryRevision ?? null : null,
            previousSecret: canReuse && previous.secret !== secret ? { secret: previous.secret, expiresAt: now + 300000 } :
              canReuse && previous.previousSecret?.expiresAt > now ? previous.previousSecret : null,
          };
          state.subscriptions[id] = replacement; return replacement;
        });
        changed(); return result(sub);
      } finally {
        await store.transaction(state => {
          const current = state.subscriptions?.[id];
          if (current?.pendingToken !== attempt) return;
          if (!current.active) delete state.subscriptions[id];
          else { delete current.pendingToken; delete current.pendingUntil; }
        });
      }
    },
    async unsubscribe(principal, params) {
      const url = validate(params, false), owner = ownerIdentity(principal);
      const id = subscriptionIdentity(principal, params.name, params.arguments, url);
      await store.transaction(state => {
        state.subscriptions ??= {};
        // An unknown unsubscribe stores no tombstone. Pending activation checks
        // its random reservation token, so removal also cancels in-flight work.
        delete state.subscriptions[id];
        for (const job of Object.values(state.jobs ?? {})) if (job.subscriptionId === id && ['queued', 'retry', 'sending'].includes(job.state))
          Object.assign(job, { state: 'cancelled', reason: 'unsubscribed', updatedAt: clock() });
      });
      changed(); return {};
    },
    async active() {
      return Object.values((await store.read()).subscriptions ?? {}).filter(sub => sub.active && sub.expiresAt > clock());
    },
  };
}

export async function selectedTail(bridge, applicationId, { maxBatches = 256 } = {}) {
  let cursor, revision;
  for (let i = 0; i < maxBatches; i++) {
    const batch = await bridge.readEvents(applicationId, { ...(cursor == null ? {} : { cursor }), limit: 128 });
    if (batch.hasMore && batch.cursor === cursor) fail('SOURCE_CURSOR_STALLED', 'Selected history cursor did not advance');
    cursor = batch.cursor; revision = batch.revision;
    if (!batch.hasMore) return { cursor: cursor ?? null, revision };
  }
  fail('SOURCE_BASELINE_LIMIT', 'Selected history is too large for one subscription baseline; configure a larger bounded scan budget');
}
