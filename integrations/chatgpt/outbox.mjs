import { randomUUID } from 'node:crypto';
import { bounded, canonical, digest, fail, text } from './common.mjs';
import { ownerIdentity, selectedTail } from './subscriptions.mjs';
import { signedHeaders, deliveryDisposition, createPublicWebhookTransport } from './webhooks.mjs';

const pending = state => ['queued', 'retry', 'sending'].includes(state);
const sameOwner = (a, b) => canonical(ownerIdentity(a)) === canonical(ownerIdentity(b));
const live = (sub, now) => sub?.active && sub.expiresAt > now;
const sameActivation = (job, sub) => (job.activationId ?? null) === (sub?.activationId ?? null);

function envelope(sub, event, now) {
  const projected = event.data ?? {};
  const allowed = ['request_id', 'kind', 'summary', 'details_tool'];
  if (Object.keys(projected).some(key => !allowed.includes(key)))
    fail('EVENT_PROJECTION_FIELDS', 'Event projection contains fields outside the declared minimal egress schema');
  const data = { application_id: sub.applicationId, source_event_id: text(event.sourceEventId, 'source event ID', 512),
    selected_generation: text(event.revision?.generation, 'selected generation', 256), context_revision: bounded(event.revision, 16384) };
  if (event.sourceOperationId) data.source_operation_id = text(event.sourceOperationId, 'source operation ID', 256);
  for (const key of ['request_id', 'kind', 'summary']) if (projected[key] !== undefined)
    data[key] = text(projected[key], key, key === 'summary' ? 512 : 128);
  if (projected.details_tool !== undefined) {
    if (projected.details_tool !== 'get_event_details') fail('EVENT_PROJECTION_FIELDS', 'Event details must use the authorized details tool');
    data.details_tool = 'get_event_details';
  }
  const sourceTime = Number.isSafeInteger(event.sourceTimestampMs) && event.sourceTimestampMs >= 0 && event.sourceTimestampMs <= 8640000000000000 ? event.sourceTimestampMs : now;
  return bounded({ eventId: 'evt_' + digest([sub.id, event.sourceEventId]), name: event.name,
    timestamp: new Date(sourceTime).toISOString(), data, cursor: null }, 65536);
}

export function createOutbox({ store, bridge, authorize, send = createPublicWebhookTransport(),
  clock = Date.now, maxAttempts = 8, maxJobs = 100000, leaseMs = 30000 } = {}) {
  if (!store || !bridge || typeof authorize !== 'function') fail('OUTBOX_CONFIGURATION_REQUIRED', 'Outbox requires a real bridge and current authorization');
  const sending = new Map();
  const cancelInactive = async () => {
    const state = await store.read();
    for (const [lease, { eventId, controller }] of sending) {
      const job = state.jobs?.[eventId], sub = state.subscriptions?.[job?.subscriptionId];
      if (!job || job.state !== 'sending' || job.lease !== lease || !live(sub, clock()) || !sameActivation(job, sub) || sub.pausedReason && job.sourceKind !== 'recovery') controller.abort();
    }
  };
  function insert(state, sub, event, sourceKind = 'domain') {
    const value = envelope(sub, event, clock());
    state.jobs ??= {};
    if (state.jobs[value.eventId]) return;
    if (Object.keys(state.jobs).length >= maxJobs) fail('OUTBOX_CAPACITY', 'Delivery journal is full; archive reviewed receipts before resuming observation');
    state.jobs[value.eventId] = { eventId: value.eventId, subscriptionId: sub.id, applicationId: sub.applicationId,
      activationId: sub.activationId ?? null,
      owner: sub.owner, sourceEventId: event.sourceEventId, sourceRevision: event.revision, sourceKind,
      envelope: value, state: 'queued', attempts: 0, createdAt: clock(), nextAttemptAt: clock() };
  }
  async function finish(eventId, lease, update) {
    await store.transaction(state => {
      const current = state.jobs?.[eventId];
      if (current?.state === 'sending' && current.lease === lease) Object.assign(current, update, { updatedAt: clock(), lease: null, leaseUntil: null });
      else if (current?.lease === lease && update.state === 'accepted' && ['cancelled', 'abandoned'].includes(current.state)) {
        // Disconnect can stop future attempts, but cannot retract an HTTP
        // request already sent. Keep a late positive receipt without reopening.
        Object.assign(current, { acceptedAt: update.acceptedAt, responseStatus: update.responseStatus,
          receiptAfterStop: true, updatedAt: clock(), lease: null, leaseUntil: null });
      }
    });
  }
  async function one(signal) {
    const job = await store.transaction(state => {
      for (const candidate of Object.values(state.jobs ?? {})) {
        if (!pending(candidate.state)) continue;
        const sub = state.subscriptions?.[candidate.subscriptionId];
        if (!live(sub, clock()) || !sameActivation(candidate, sub)) {
          Object.assign(candidate, { state: 'cancelled', reason: !sameActivation(candidate, sub) ? 'subscription_replaced' : sub?.active ? 'subscription_expired' : 'subscription_stopped', updatedAt: clock() }); continue;
        }
        if (sub.pausedReason && candidate.sourceKind !== 'recovery') continue;
        if (candidate.state === 'sending' && candidate.leaseUntil > clock() || candidate.nextAttemptAt > clock()) continue;
        if (candidate.attempts >= maxAttempts) { Object.assign(candidate, { state: 'failed', reason: 'retry_limit', updatedAt: clock() }); continue; }
        Object.assign(candidate, { state: 'sending', lease: randomUUID(), leaseUntil: clock() + leaseMs, attempts: candidate.attempts + 1 });
        return candidate;
      }
      return null;
    });
    if (!job) return false;
    const controller = new AbortController(); sending.set(job.lease, { eventId: job.eventId, controller });
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      let sub = (await store.read()).subscriptions?.[job.subscriptionId];
      if (!live(sub, clock()) || !sameActivation(job, sub)) {
        await finish(job.eventId, job.lease, { state: 'cancelled', reason: 'subscription_changed' }); return true;
      }
      await authorize(sub.owner, sub.applicationId, sub.name);
      if (job.sourceKind === 'domain') {
        const source = await bridge.verifySource(job.applicationId, job.sourceEventId, job.sourceRevision);
        if (!source.selected) { await finish(job.eventId, job.lease, { state: 'abandoned', reason: 'source_not_selected' }); return true; }
      } else await bridge.getStatus(job.applicationId);
      await authorize(sub.owner, sub.applicationId, sub.name);
      // Another process may have cancelled or reclaimed this job while source
      // verification awaited I/O. Reacquire only this exact lease before egress.
      sub = await store.transaction(state => {
        const current = state.jobs?.[job.eventId], subscription = state.subscriptions?.[job.subscriptionId];
        if (current?.state !== 'sending' || current.lease !== job.lease) return null;
        if (!live(subscription, clock()) || !sameActivation(current, subscription)) {
          Object.assign(current, { state: 'cancelled', reason: 'subscription_changed', updatedAt: clock(), lease: null, leaseUntil: null });
          return null;
        }
        if (subscription.pausedReason && job.sourceKind !== 'recovery') {
          Object.assign(current, { state: 'queued', reason: 'recovery_review_required', updatedAt: clock(), lease: null, leaseUntil: null });
          return null;
        }
        current.leaseUntil = clock() + leaseMs;
        current.lastDeliveryAttemptAt = clock();
        return subscription;
      });
      if (!sub) return true;
      combined.throwIfAborted();
      const body = JSON.stringify(job.envelope);
      const secrets = [sub.secret, ...(sub.previousSecret?.expiresAt > clock() ? [sub.previousSecret.secret] : [])];
      const response = await send(sub.url, { body, headers: signedHeaders({ id: job.eventId, subscriptionId: sub.id, body, secrets, now: clock() }), signal: combined });
      const disposition = deliveryDisposition(response.status);
      if (disposition === 'accepted') await finish(job.eventId, job.lease, { state: 'accepted', acceptedAt: clock(), responseStatus: response.status });
      else if (disposition === 'retry') await finish(job.eventId, job.lease, { state: job.attempts >= maxAttempts ? 'failed' : 'retry',
        nextAttemptAt: clock() + Math.min(300000, 1000 * 2 ** job.attempts), responseStatus: response.status, reason: 'transient_callback_failure' });
      else {
        await finish(job.eventId, job.lease, { state: 'failed', reason: disposition === 'gone' ? 'callback_gone' : 'callback_rejected', responseStatus: response.status });
        if (disposition === 'gone') await store.transaction(state => {
          const current = state.subscriptions[sub.id];
          if (current?.version === sub.version && sameActivation(job, current)) {
            current.active = false; current.stoppedAt = clock(); current.stopReason = 'callback_gone'; current.version++;
            delete current.secret; delete current.previousSecret;
            delete current.pendingToken; delete current.pendingUntil;
          }
        });
      }
    } catch (error) {
      const forbidden = error.status === 401 || error.status === 403 || ['BRIDGE_GRANT_REQUIRED', 'CALLBACK_ADDRESS_BLOCKED', 'CALLBACK_REDIRECT'].includes(error.code);
      await finish(job.eventId, job.lease, { state: forbidden ? 'cancelled' : job.attempts >= maxAttempts ? 'failed' : 'retry',
        reason: forbidden ? 'authorization_or_destination_revoked' : combined.aborted ? 'delivery_interrupted' : 'delivery_unavailable',
        lastError: String(error.code ?? error.name ?? 'DELIVERY_FAILED').slice(0, 128),
        nextAttemptAt: clock() + Math.min(300000, 1000 * 2 ** job.attempts) });
    } finally { sending.delete(job.lease); }
    return true;
  }
  return {
    cancelInactive,
    async ingest(subscriptionId, batch, { expectedCursor } = {}) {
      const sub = (await store.read()).subscriptions?.[subscriptionId];
      if (!live(sub, clock()) || sub.pausedReason) return false;
      if (batch.applicationId !== sub.applicationId) fail('SOURCE_SCOPE_MISMATCH', 'Event batch belongs to another application');
      await authorize(sub.owner, sub.applicationId, sub.name);
      // Projection validation happens before the transaction can advance a cursor.
      const events = batch.events.filter(event => event.name === sub.name);
      for (const event of events) envelope(sub, event, clock());
      return store.transaction(state => {
        const current = state.subscriptions?.[subscriptionId];
        if (!live(current, clock()) || current.pausedReason || current.version !== sub.version ||
            canonical(current.sourceCursor ?? null) !== canonical(expectedCursor ?? null)) return false;
        for (const event of events) insert(state, current, event);
        current.sourceCursor = batch.cursor ?? null; current.sourceRevision = batch.revision;
        current.observedAt = clock(); return true;
      });
    },
    async dispatchDue({ limit = 8, signal } = {}) {
      let processed = 0;
      while (processed < limit && !signal?.aborted && await one(signal)) processed++;
      return processed;
    },
    async pauseForRecovery(subscriptionId, notice) {
      const snapshot = await store.read(), observed = snapshot.subscriptions?.[subscriptionId];
      if (!observed?.active) return;
      let revision, projectionError = null;
      try { revision = bounded(notice?.revision, 16384); text(revision?.generation, 'selected generation', 256); }
      catch { revision = null; projectionError = 'RECOVERY_NOTICE_INVALID'; }
      const recoveryId = 'recovery_' + digest([observed.applicationId, revision]);
      // Persist the fail-closed pause before any authorization I/O or outbox
      // insertion. A full journal must never undo a recovery safety boundary.
      const recoverySubscribers = await store.transaction(state => {
        const recipients = [];
        for (const sub of Object.values(state.subscriptions ?? {})) if (sub.active && sub.applicationId === observed.applicationId) {
          if (!sub.pausedReason || canonical(sub.recoveryRevision ?? null) !== canonical(revision)) {
            sub.version = (sub.version ?? 0) + 1;
            sub.recoveryVersion = (sub.recoveryVersion ?? 0) + 1;
            sub.recoveryAt = clock();
            sub.recoveryNoticeQueuedAt = null;
            sub.recoveryNoticeError = projectionError;
          }
          sub.pausedReason = 'recovery_review_required'; sub.recoveryRevision = revision;
          if (live(sub, clock()) && sub.name === 'application.recovery_notice') recipients.push(sub);
        }
        return recipients;
      });
      await cancelInactive();
      let failures = 0;
      for (const recipient of recoverySubscribers) {
        let errorCode = projectionError;
        if (!errorCode) {
          try { await authorize(recipient.owner, recipient.applicationId, recipient.name); }
          catch { errorCode = 'RECOVERY_NOTICE_UNAUTHORIZED'; }
        }
        await store.transaction(state => {
          const current = state.subscriptions?.[recipient.id];
          if (!live(current, clock()) || !sameActivation(recipient, current) || !current.pausedReason || current.recoveryVersion !== recipient.recoveryVersion) return;
          if (!errorCode) {
            try {
              insert(state, current, { name: 'application.recovery_notice', sourceEventId: recoveryId,
                revision, data: { summary: 'Selected application history changed. Review pending operations and choose how to resume notifications.' } }, 'recovery');
              current.recoveryNoticeQueuedAt = clock();
            } catch (error) { errorCode = error.code === 'OUTBOX_CAPACITY' ? 'OUTBOX_CAPACITY' : 'RECOVERY_NOTICE_INVALID'; }
          }
          current.recoveryNoticeError = errorCode;
          if (errorCode) failures++;
        });
      }
      return { paused: true, recoveryNoticeFailures: failures };
    },
    async resume(principal, { subscriptionId, strategy, recoveryRevision }) {
      if (!['from_current', 'replay_selected'].includes(strategy)) fail('INVALID_RECOVERY_STRATEGY', 'Choose from_current or replay_selected after reviewing recovery');
      const sub = (await store.read()).subscriptions?.[subscriptionId];
      if (!sub || !sameOwner(principal, sub.owner)) fail('SUBSCRIPTION_NOT_FOUND', 'Subscription not found', { status: 404 });
      let reviewed;
      try {
        if (!recoveryRevision || typeof recoveryRevision !== 'object' || Array.isArray(recoveryRevision)) throw Error('Missing reviewed revision');
        reviewed = bounded(recoveryRevision, 16384);
      } catch { fail('RECOVERY_CHANGED', 'Supply the exact recovery revision from the current subscription status', { status: 409 }); }
      if (canonical(reviewed) !== canonical(sub.recoveryRevision ?? null))
        fail('RECOVERY_CHANGED', 'The reviewed recovery revision is no longer current; review the current subscription status', { status: 409 });
      if (!live(sub, clock())) fail('SUBSCRIPTION_INACTIVE', 'Refresh the subscription before resuming');
      if (!sub.pausedReason) fail('RECOVERY_REVIEW_NOT_REQUIRED', 'This subscription is not paused for recovery');
      await authorize(sub.owner, sub.applicationId, sub.name);
      const baseline = strategy === 'from_current' ? await selectedTail(bridge, sub.applicationId) : { cursor: null, revision: sub.recoveryRevision };
      await authorize(sub.owner, sub.applicationId, sub.name);
      await store.transaction(state => {
        const current = state.subscriptions?.[subscriptionId];
        if (!live(current, clock()) || !sameActivation(sub, current) || current.version !== sub.version ||
            current.recoveryVersion !== sub.recoveryVersion || current.pausedReason !== sub.pausedReason ||
            canonical(current.recoveryRevision ?? null) !== canonical(reviewed))
          fail('SUBSCRIPTION_CHANGED', 'Subscription changed during recovery review', { status: 409 });
        Object.assign(current, { pausedReason: null, sourceCursor: baseline.cursor, sourceRevision: baseline.revision,
          resumedAt: clock(), resumeStrategy: strategy, version: current.version + 1 });
        if (strategy === 'from_current') for (const job of Object.values(state.jobs ?? {})) if (job.subscriptionId === subscriptionId && pending(job.state) && job.sourceKind === 'domain')
          Object.assign(job, { state: 'cancelled', reason: 'reviewed_start_from_current', updatedAt: clock() });
      });
      await cancelInactive();
      return { subscriptionId, strategy, resumed: true };
    },
    async status(principal, applicationId, requestId) {
      const state = await store.read();
      const subscriptions = Object.values(state.subscriptions ?? {}).filter(sub => sub.applicationId === applicationId && sameOwner(principal, sub.owner))
        .map(sub => ({ id: sub.id, name: sub.name, active: live(sub, clock()), expiresAt: sub.expiresAt ?? null,
          pausedReason: sub.pausedReason ?? null, observedAt: sub.observedAt ?? null, recoveryAt: sub.recoveryAt ?? null,
          recoveryRevision: structuredClone(sub.recoveryRevision ?? null),
          recoveryNoticeError: sub.recoveryNoticeError ?? null, recoveryNoticeQueuedAt: sub.recoveryNoticeQueuedAt ?? null }));
      const jobs = Object.values(state.jobs ?? {}).filter(job => job.applicationId === applicationId && sameOwner(principal, job.owner) &&
        (requestId === undefined || job.envelope.data.request_id === requestId))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
        .map(job => ({ eventId: job.eventId, sourceEventId: job.sourceEventId, state: job.state, attempts: job.attempts,
          reason: job.reason ?? null, acceptedAt: job.acceptedAt ?? null,
          responseStatus: job.responseStatus ?? null, receiptAfterStop: job.receiptAfterStop === true,
          deliveryMayHaveOccurred: job.lastDeliveryAttemptAt != null && job.acceptedAt == null,
          responseOperationId: job.responseOperationId ?? null, responseObservedAt: job.responseObservedAt ?? null }));
      return { subscriptions, jobs, receiptMeans: 'Webhook accepted is receipt only; inspect the application response operation separately.' };
    },
    async noteReply(principal, applicationId, requestId, operationId) {
      await store.transaction(state => {
        for (const job of Object.values(state.jobs ?? {})) if (job.applicationId === applicationId && sameOwner(principal, job.owner) && job.envelope.data.request_id === requestId)
          Object.assign(job, { responseOperationId: operationId, responseObservedAt: clock() });
      });
    },
  };
}
