import { randomUUID } from 'node:crypto';
import { bounded, canonical, digest, fail, text } from './common.mjs';
import { ownerIdentity, selectedTail, sourceCursorScope } from './subscriptions.mjs';
import { consumerIdentity, accountIdentity } from './consumer.mjs';
import { signedHeaders, deliveryDisposition } from './webhook-data.mjs';

const pending = state => ['queued', 'retry', 'sending'].includes(state);
const sameOwner = (a, b) => canonical(ownerIdentity(a)) === canonical(ownerIdentity(b));
const live = (sub, now) => sub?.active && sub.expiresAt > now;
const sameActivation = (job, sub) => (job.activationId ?? null) === (sub?.activationId ?? null);
const recovered = error => error?.code === 'APPLICATION_VIEW_RECOVERED' || error?.message === 'APPLICATION_VIEW_RECOVERED';

function envelope(sub, event, now) {
  const projected = event.data ?? {};
  const allowed = ['request_id', 'kind', 'summary', 'details_tool'];
  if (Object.keys(projected).some(key => !allowed.includes(key)))
    fail('EVENT_PROJECTION_FIELDS', 'Event projection contains fields outside the declared minimal egress schema');
  const data = { application_id: sub.applicationId, source_event_id: text(event.sourceEventId, 'source event ID', 512),
    selected_generation: text(event.revision?.generation, 'selected generation', 256), context_revision: bounded(event.revision, 16384) };
  if (event.sourceOperationId) data.source_operation_id = text(event.sourceOperationId, 'source operation ID', 256);
  if (event.sourceAuthor) data.source_author = text(event.sourceAuthor, 'source author', 512);
  if (event.sourceAttemptId) data.source_attempt_id = text(event.sourceAttemptId, 'source attempt ID', 512);
  if (event.export) data.export = bounded(event.export, 16384);
  data.source_evidence = event.sourceAuthor && event.sourceAttemptId ? 'native-verified' : 'projection-asserted';
  for (const key of ['request_id', 'kind', 'summary']) if (projected[key] !== undefined)
    data[key] = text(projected[key], key, key === 'summary' ? 512 : 128);
  if (projected.details_tool !== undefined) {
    if (projected.details_tool !== 'get_event_details') fail('EVENT_PROJECTION_FIELDS', 'Event details must use the authorized details tool');
    data.details_tool = 'get_event_details';
  }
  const sourceTime = Number.isSafeInteger(event.sourceTimestampMs) && event.sourceTimestampMs >= 0 && event.sourceTimestampMs <= 8640000000000000 ? event.sourceTimestampMs : now;
  return bounded({ eventId: 'evt_' + digest([sub.id, event.sourceEventId, event.export?.fingerprint ?? null]), name: event.name,
    timestamp: new Date(sourceTime).toISOString(), data, cursor: null }, 65536);
}

export function createOutbox({ store, bridge, authorize, send,
  clock = Date.now, sourceCursorLookup = false, maxAttempts = 8, maxJobs = 100000, leaseMs = 30000,
  maxConcurrent = 4, maxConcurrentPerAccount = Math.min(2, maxConcurrent),
  maxConcurrentPerConsumer = Math.min(2, maxConcurrentPerAccount) } = {}) {
  if (!store || !bridge || typeof bridge.readRevision !== 'function' || typeof bridge.assertSelection !== 'function' || typeof authorize !== 'function')
    fail('OUTBOX_CONFIGURATION_REQUIRED', 'Outbox requires a real bridge with selected-generation fences and current authorization');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 16 || !Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 100000 ||
      !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000 ||
      !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32 ||
      !Number.isSafeInteger(maxConcurrentPerAccount) || maxConcurrentPerAccount < 1 || maxConcurrentPerAccount > maxConcurrent ||
      !Number.isSafeInteger(maxConcurrentPerConsumer) || maxConcurrentPerConsumer < 1 || maxConcurrentPerConsumer > maxConcurrentPerAccount)
    fail('OUTBOX_CONFIGURATION_REQUIRED', 'Delivery bounds are outside the supported range');
  const sending = new Map();
  const cancelInactive = async () => {
    const state = await store.read();
    for (const [lease, { eventId, controller }] of sending) {
      const job = state.jobs?.[eventId], sub = state.subscriptions?.[job?.subscriptionId];
      if (!job || job.state !== 'sending' || job.lease !== lease || !live(sub, clock()) || !sameActivation(job, sub) || sub.pausedReason && job.sourceKind !== 'recovery') controller.abort();
    }
  };
  function insert(state, sub, event, sourceKind = 'domain', sourceCursor) {
    const value = envelope(sub, event, clock());
    state.jobs ??= {};
    if (state.jobs[value.eventId]) return;
    if (Object.keys(state.jobs).length >= maxJobs) fail('OUTBOX_CAPACITY', 'Delivery journal is full; archive reviewed receipts before resuming observation');
    state.jobs[value.eventId] = { eventId: value.eventId, subscriptionId: sub.id, applicationId: sub.applicationId,
      activationId: sub.activationId ?? null,
      owner: sub.owner, sourceEventId: event.sourceEventId,
      ...(sourceCursor !== undefined ? { sourceCursor } : {}), sourceRevision: event.revision, sourceExport: event.export ?? null, sourceKind,
      envelope: value, state: 'queued', attempts: 0, createdAt: clock(), nextAttemptAt: clock() };
  }
  async function finish(eventId, lease, update, { stopSubscription, authorizedSubscription } = {}) {
    await store.transaction(state => {
      const current = state.jobs?.[eventId];
      if (current?.state === 'sending' && current.lease === lease) {
        const subscription = state.subscriptions?.[current.subscriptionId];
        const staleAuthorization = authorizedSubscription && live(subscription, clock()) && sameActivation(current, subscription) &&
          (subscription.version !== authorizedSubscription.version || canonical(subscription.owner) !== canonical(authorizedSubscription.owner));
        Object.assign(current, staleAuthorization
          ? { state: 'queued', reason: 'subscription_refreshed', attempts: Math.max(0, current.attempts - 1) }
          : update, { updatedAt: clock(), lease: null, leaseUntil: null });
        if (stopSubscription && subscription && subscription.version === stopSubscription.version && sameActivation(current, subscription)) {
          subscription.active = false; subscription.stoppedAt = clock(); subscription.stopReason = 'callback_gone'; subscription.version++;
          delete subscription.secret; delete subscription.previousSecret;
          delete subscription.pendingToken; delete subscription.pendingUntil;
        }
      }
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
      const due = [], accountTurns = new Map(), consumerTurns = new Map();
      const accountSending = new Map(), consumerSending = new Map(), subscriptionSending = new Set();
      let active = 0;
      for (const candidate of Object.values(state.jobs ?? {})) {
        const account = digest(accountIdentity(candidate.owner)), consumer = consumerIdentity(candidate.owner).consumerId;
        accountTurns.set(account, Math.max(accountTurns.get(account) ?? 0, candidate.dispatchTurn ?? 0));
        consumerTurns.set(consumer, Math.max(consumerTurns.get(consumer) ?? 0, candidate.dispatchTurn ?? 0));
        if (!pending(candidate.state)) continue;
        const sub = state.subscriptions?.[candidate.subscriptionId];
        if (!live(sub, clock()) || !sameActivation(candidate, sub)) {
          Object.assign(candidate, { state: 'cancelled', reason: !sameActivation(candidate, sub) ? 'subscription_replaced' : sub?.active ? 'subscription_expired' : 'subscription_stopped', updatedAt: clock() }); continue;
        }
        if (candidate.state === 'sending' && candidate.leaseUntil > clock()) {
          active++; accountSending.set(account, (accountSending.get(account) ?? 0) + 1);
          consumerSending.set(consumer, (consumerSending.get(consumer) ?? 0) + 1);
          subscriptionSending.add(candidate.subscriptionId); continue;
        }
        if (sub.pausedReason && candidate.sourceKind !== 'recovery') continue;
        if (candidate.nextAttemptAt > clock()) continue;
        if (candidate.attempts >= maxAttempts) { Object.assign(candidate, { state: 'failed', reason: 'retry_limit', updatedAt: clock() }); continue; }
        due.push(candidate);
      }
      // Durable account and consumer turn counters prevent one old backlog or
      // many sibling bindings from monopolizing the next bounded dispatch.
      const accountTurn = owner => accountTurns.get(digest(accountIdentity(owner))) ?? 0;
      const consumerTurn = owner => consumerTurns.get(consumerIdentity(owner).consumerId) ?? 0;
      due.sort((a, b) => accountTurn(a.owner) - accountTurn(b.owner) || consumerTurn(a.owner) - consumerTurn(b.owner) || a.createdAt - b.createdAt);
      // Admission is inside the same durable transaction as the lease, so
      // concurrent dispatch calls/processes cannot multiply account capacity.
      if (active >= maxConcurrent) return null;
      const candidate = due.find(item => !subscriptionSending.has(item.subscriptionId) &&
        (accountSending.get(digest(accountIdentity(item.owner))) ?? 0) < maxConcurrentPerAccount &&
        (consumerSending.get(consumerIdentity(item.owner).consumerId) ?? 0) < maxConcurrentPerConsumer);
      if (!candidate) return null;
      state.deliverySequence = (state.deliverySequence ?? 0) + 1;
      Object.assign(candidate, { state: 'sending', dispatchTurn: state.deliverySequence, lease: randomUUID(), leaseUntil: clock() + leaseMs, attempts: candidate.attempts + 1 });
      return candidate;
    });
    if (!job) return false;
    const controller = new AbortController(); sending.set(job.lease, { eventId: job.eventId, controller });
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let sub, authorized;
    try {
      sub = (await store.read()).subscriptions?.[job.subscriptionId];
      if (!live(sub, clock()) || !sameActivation(job, sub)) {
        await finish(job.eventId, job.lease, { state: 'cancelled', reason: 'subscription_changed' }); return true;
      }
      await authorize(sub.owner, sub.applicationId, sub.name);
      authorized = sub;
      if (job.sourceKind === 'domain' && typeof bridge.exportDefinition === 'function') {
        const exported = await bridge.exportDefinition(job.applicationId);
        if (canonical(job.sourceExport ?? null) !== canonical(exported)) {
          await outbox.pauseForExport(job.subscriptionId, { export: exported, revision: await bridge.readRevision(job.applicationId) }, { subscription: sub, job });
          await finish(job.eventId, job.lease, { state: 'queued', reason: 'export_review_required', attempts: Math.max(0, job.attempts - 1) });
          return true;
        }
      }
      let selectedRevision;
      if (job.sourceKind === 'domain') {
        const source = await bridge.verifySource(job.applicationId, job.sourceEventId, job.sourceRevision, sourceCursorLookup ? job.sourceCursor : undefined);
        if (!source.selected) { await finish(job.eventId, job.lease, { state: 'abandoned', reason: 'source_not_selected' }); return true; }
        selectedRevision = source.currentRevision;
      } else selectedRevision = await bridge.readRevision(job.applicationId);
      await authorize(sub.owner, sub.applicationId, sub.name);
      // Another process may have cancelled or reclaimed this job while source
      // verification awaited I/O. Reacquire only this exact lease before egress.
      sub = await store.transaction(state => {
        const current = state.jobs?.[job.eventId], subscription = state.subscriptions?.[job.subscriptionId];
        if (current?.state !== 'sending' || current.lease !== job.lease || current.leaseUntil <= clock()) return null;
        if (!live(subscription, clock()) || !sameActivation(current, subscription)) {
          Object.assign(current, { state: 'cancelled', reason: 'subscription_changed', updatedAt: clock(), lease: null, leaseUntil: null });
          return null;
        }
        if (subscription.pausedReason && job.sourceKind !== 'recovery') {
          Object.assign(current, { state: 'queued', reason: 'recovery_review_required', updatedAt: clock(), lease: null, leaseUntil: null });
          return null;
        }
        if (subscription.version !== sub.version || canonical(subscription.owner) !== canonical(sub.owner)) {
          Object.assign(current, { state: 'queued', reason: 'subscription_refreshed', attempts: Math.max(0, current.attempts - 1),
            updatedAt: clock(), lease: null, leaseUntil: null });
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
      const beforeWrite = () => {
        bridge.assertSelection(job.applicationId, selectedRevision);
        if (job.sourceKind === 'domain') bridge.assertExport?.(job.applicationId, job.sourceExport);
      };
      const prepareWrite = async () => {
        await authorize(sub.owner, sub.applicationId, sub.name);
        const state = await store.read(), current = state.jobs?.[job.eventId];
        const subscription = state.subscriptions?.[job.subscriptionId];
        if (current?.state !== 'sending' || current.lease !== job.lease || current.leaseUntil <= clock() ||
            !live(subscription, clock()) || !sameActivation(job, subscription) || subscription.version !== sub.version ||
            (subscription.pausedReason && job.sourceKind !== 'recovery'))
          fail('DELIVERY_LEASE_CHANGED', 'Delivery changed while connecting');
      };
      const request = { body, prepareWrite, beforeWrite, sourceGeneration: selectedRevision.generation, headers: signedHeaders({ id: job.eventId, subscriptionId: sub.id, body, secrets, now: clock() }), signal: combined };
      beforeWrite();
      const response = await send(sub.url, request);
      const disposition = deliveryDisposition(response.status);
      if (disposition === 'accepted') await finish(job.eventId, job.lease, { state: 'accepted', acceptedAt: clock(), responseStatus: response.status });
      else if (disposition === 'retry') await finish(job.eventId, job.lease, { state: job.attempts >= maxAttempts ? 'failed' : 'retry',
        nextAttemptAt: clock() + Math.min(300000, 1000 * 2 ** job.attempts), responseStatus: response.status, reason: 'transient_callback_failure' });
      else {
        // Settle and stop atomically under the exact sending lease. A reclaimed
        // worker's late 410 cannot deactivate a newer successful delivery.
        await finish(job.eventId, job.lease, { state: 'failed', reason: disposition === 'gone' ? 'callback_gone' : 'callback_rejected', responseStatus: response.status },
          { stopSubscription: disposition === 'gone' ? sub : undefined });
      }
    } catch (error) {
      if (error.code === 'BRIDGE_EXPORT_CHANGED') {
        await outbox.pauseForExport(job.subscriptionId, { export: await bridge.exportDefinition(job.applicationId), revision: await bridge.readRevision(job.applicationId) }, { subscription: authorized, job });
        await finish(job.eventId, job.lease, { state: 'queued', reason: 'export_review_required', attempts: Math.max(0, job.attempts - 1) }); return true;
      }
      if (recovered(error)) {
        await outbox.pauseForRecovery(job.subscriptionId, { revision: await bridge.readRevision(job.applicationId) }, { subscription: authorized, job });
        await finish(job.eventId, job.lease, { state: 'queued', reason: 'recovery_review_required', attempts: Math.max(0, job.attempts - 1) });
        return true;
      }
      const forbidden = error.status === 401 || error.status === 403 || ['BRIDGE_GRANT_REQUIRED', 'CALLBACK_ADDRESS_BLOCKED', 'CALLBACK_REDIRECT'].includes(error.code);
      await finish(job.eventId, job.lease, { state: forbidden ? 'cancelled' : job.attempts >= maxAttempts ? 'failed' : 'retry',
        reason: forbidden ? 'authorization_or_destination_revoked' : combined.aborted ? 'delivery_interrupted' : 'delivery_unavailable',
        lastError: String(error.code ?? error.name ?? 'DELIVERY_FAILED').slice(0, 128),
        nextAttemptAt: clock() + Math.min(300000, 1000 * 2 ** job.attempts) }, { authorizedSubscription: forbidden ? sub : undefined });
    } finally { sending.delete(job.lease); }
    return true;
  }
  const outbox = {
    cancelInactive,
    async ingest(subscriptionId, batch, { expectedCursor } = {}) {
      const sub = (await store.read()).subscriptions?.[subscriptionId];
      if (!live(sub, clock()) || sub.pausedReason) return false;
      if (batch.applicationId !== sub.applicationId) fail('SOURCE_SCOPE_MISMATCH', 'Event batch belongs to another application');
      await authorize(sub.owner, sub.applicationId, sub.name);
      if (canonical(sub.sourceExport ?? null) !== canonical(batch.export ?? null)) {
        await outbox.pauseForExport(subscriptionId, batch, { subscription: sub }); return false;
      }
      // Projection validation happens before the transaction can advance a cursor.
      const events = batch.events.filter(event => event.name === sub.name);
      for (const event of events) envelope(sub, event, clock());
      return store.transaction(state => {
        const current = state.subscriptions?.[subscriptionId];
        if (!live(current, clock()) || current.pausedReason || current.version !== sub.version ||
            canonical(current.sourceCursor ?? null) !== canonical(expectedCursor ?? null)) return false;
        for (const event of events) insert(state, current, event, 'domain', expectedCursor ?? null);
        current.sourceCursor = batch.cursor ?? null; current.sourceRevision = batch.revision;
        current.cursorScope = sourceCursorScope(current, batch.export, batch.revision);
        current.observedAt = clock(); return true;
      });
    },
    async dispatchDue({ limit = 8, signal } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) fail('DELIVERY_BATCH_LIMIT', 'Dispatch at most 128 deliveries per turn');
      let reserved = 0, processed = 0;
      const worker = async () => {
        while (reserved < limit && !signal?.aborted) {
          reserved++;
          if (!await one(signal)) { reserved--; return; }
          processed++;
        }
      };
      // A stalled callback occupies one bounded worker. Other consumers keep
      // progressing, with one current lease per subscription to retain order.
      const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, maxConcurrent) }, worker));
      const failed = settled.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      return processed;
    },
    async pauseForExport(subscriptionId, notice, { subscription, job } = {}) {
      const exported = bounded(notice?.export, 16384), revision = bounded(notice?.revision, 16384);
      if (!exported || exported.applicationId !== revision?.applicationId || typeof exported.fingerprint !== 'string')
        fail('SOURCE_EXPORT_INVALID', 'A changed export must identify its application and immutable definition');
      const paused = await store.transaction(state => {
        const source = state.subscriptions?.[subscriptionId];
        if (!source?.active || exported.applicationId !== source.applicationId) return false;
        if (subscription && (!sameActivation(subscription, source) || source.version !== subscription.version)) return false;
        if (job) {
          const current = state.jobs?.[job.eventId];
          if (current?.state !== 'sending' || current.lease !== job.lease || current.leaseUntil <= clock()) return false;
        }
        for (const sub of Object.values(state.subscriptions ?? {})) if (sub.active && sub.applicationId === source.applicationId) {
          if (sub.pausedReason === 'export_review_required' && canonical(sub.cursorReset?.currentExport) === canonical(exported)) continue;
          sub.version = (sub.version ?? 0) + 1; sub.recoveryVersion = (sub.recoveryVersion ?? 0) + 1;
          sub.pausedReason = 'export_review_required'; sub.recoveryRevision = revision; sub.recoveryAt = clock();
          sub.cursorReset = { kind: 'export-changed', previousExport: sub.sourceExport ?? null, currentExport: exported, revision,
            previousCursorScope: sub.cursorScope ?? null, requiresReview: true };
          sub.reviewToken = 'review_' + digest([sub.id, ownerIdentity(sub.owner), sub.recoveryVersion, sub.cursorReset]);
        }
        return true;
      });
      if (paused) await cancelInactive();
      return { paused };
    },
    async pauseForRecovery(subscriptionId, notice, { subscription, job } = {}) {
      const snapshot = await store.read(), observed = snapshot.subscriptions?.[subscriptionId];
      if (!observed?.active) return;
      let revision, projectionError = null;
      try { revision = bounded(notice?.revision, 16384); text(revision?.generation, 'selected generation', 256); }
      catch { revision = null; projectionError = 'RECOVERY_NOTICE_INVALID'; }
      const recoveryId = 'recovery_' + digest([observed.applicationId, revision]);
      // Persist the fail-closed pause before any authorization I/O or outbox
      // insertion. A full journal must never undo a recovery safety boundary.
      const recoverySubscribers = await store.transaction(state => {
        const source = state.subscriptions?.[subscriptionId];
        if (subscription && (!live(source, clock()) || !sameActivation(subscription, source) ||
            source.version !== subscription.version)) return null;
        if (job) {
          const current = state.jobs?.[job.eventId];
          if (current?.state !== 'sending' || current.lease !== job.lease || current.leaseUntil <= clock()) return null;
        }
        if (subscription && revision) {
          try { bridge.assertSelection(source.applicationId, revision); }
          catch (error) { if (recovered(error)) return null; throw error; }
        }
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
          sub.cursorReset = { kind: 'history-recovered', previousCursorScope: sub.cursorScope ?? null, revision, requiresReview: true };
          sub.reviewToken = 'review_' + digest([sub.id, ownerIdentity(sub.owner), sub.recoveryVersion, sub.cursorReset]);
          if (live(sub, clock()) && sub.name === 'application.recovery_notice') recipients.push(sub);
        }
        return recipients;
      });
      if (!recoverySubscribers) return { paused: false };
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
    async resume(principal, { subscriptionId, strategy, recoveryRevision, reviewToken }) {
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
      const exportReview = sub.pausedReason === 'export_review_required';
      if ((exportReview || reviewToken !== undefined) && reviewToken !== sub.reviewToken)
        fail('EXPORT_REVIEW_CHANGED', 'Supply the exact reviewToken from this consumer subscription status', { status: 409 });
      await authorize(sub.owner, sub.applicationId, sub.name);
      const changed = async revision => {
        await outbox.pauseForRecovery(subscriptionId, { revision }, { subscription: sub });
        fail('RECOVERY_CHANGED', 'Selected history changed after the reviewed recovery; review the current subscription status', { status: 409 });
      };
      try {
        const baseline = strategy === 'from_current' ? await selectedTail(bridge, sub.applicationId)
          : { cursor: null, revision: await bridge.readRevision(sub.applicationId), export: await bridge.exportDefinition?.(sub.applicationId) ?? null };
        await authorize(sub.owner, sub.applicationId, sub.name);
        const currentRevision = await bridge.readRevision(sub.applicationId);
        const currentExport = typeof bridge.exportDefinition === 'function' ? await bridge.exportDefinition(sub.applicationId) : baseline.export ?? null;
        const reviewedExport = exportReview ? sub.cursorReset.currentExport : sub.sourceExport ?? null;
        if (canonical(currentExport) !== canonical(baseline.export ?? null) || canonical(currentExport) !== canonical(reviewedExport)) {
          await outbox.pauseForExport(subscriptionId, { export: currentExport, revision: currentRevision }, { subscription: sub });
          fail('EXPORT_REVIEW_CHANGED', 'The event export changed; review the new export and cursor reset before resuming', { status: 409 });
        }
        if (baseline.revision?.generation !== reviewed.generation || currentRevision.generation !== reviewed.generation)
          await changed(currentRevision);
        await store.transaction(state => {
          const current = state.subscriptions?.[subscriptionId];
          if (!live(current, clock()) || !sameActivation(sub, current) || current.version !== sub.version ||
              current.recoveryVersion !== sub.recoveryVersion || current.pausedReason !== sub.pausedReason ||
              canonical(current.recoveryRevision ?? null) !== canonical(reviewed))
            fail('SUBSCRIPTION_CHANGED', 'Subscription changed during recovery review', { status: 409 });
          bridge.assertSelection(sub.applicationId, currentRevision);
          bridge.assertExport?.(sub.applicationId, currentExport);
          Object.assign(current, { pausedReason: null, sourceCursor: baseline.cursor, sourceRevision: baseline.revision,
            sourceExport: currentExport, cursorScope: sourceCursorScope(current, currentExport, baseline.revision),
            cursorReset: { ...current.cursorReset, requiresReview: false, strategy, reviewedAt: clock() },
            resumedAt: clock(), resumeStrategy: strategy, version: current.version + 1 });
          if (strategy === 'from_current' || exportReview) for (const job of Object.values(state.jobs ?? {})) if (job.subscriptionId === subscriptionId && pending(job.state) && job.sourceKind === 'domain')
            Object.assign(job, { state: 'cancelled', reason: exportReview ? 'reviewed_export_replaced' : 'reviewed_start_from_current', updatedAt: clock() });
        });
      } catch (error) {
        if (recovered(error)) await changed(await bridge.readRevision(sub.applicationId));
        throw error;
      }
      await cancelInactive();
      return { subscriptionId, strategy, resumed: true };
    },
    async status(principal, applicationId, requestId) {
      const state = await store.read();
      const subscriptions = Object.values(state.subscriptions ?? {}).filter(sub => sub.applicationId === applicationId && sameOwner(principal, sub.owner))
        .map(sub => ({ id: sub.id, name: sub.name, active: live(sub, clock()), expiresAt: sub.expiresAt ?? null,
          pausedReason: sub.pausedReason ?? null, observedAt: sub.observedAt ?? null, recoveryAt: sub.recoveryAt ?? null,
          stopReason: sub.stopReason ?? null, observerError: sub.observerError ?? null, observerErrorAt: sub.observerErrorAt ?? null,
          recoveryRevision: structuredClone(sub.recoveryRevision ?? null),
          reviewToken: sub.reviewToken ?? null, cursorScope: structuredClone(sub.cursorScope ?? null), cursorReset: structuredClone(sub.cursorReset ?? null),
          export: structuredClone(sub.sourceExport ?? null),
          recoveryNoticeError: sub.recoveryNoticeError ?? null, recoveryNoticeQueuedAt: sub.recoveryNoticeQueuedAt ?? null }));
      const jobs = Object.values(state.jobs ?? {}).filter(job => job.applicationId === applicationId && sameOwner(principal, job.owner) &&
        (requestId === undefined || job.envelope.data.request_id === requestId))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
        .map(job => ({ eventId: job.eventId, sourceEventId: job.sourceEventId, state: job.state, attempts: job.attempts,
          reason: job.reason ?? null, acceptedAt: job.acceptedAt ?? null,
          responseStatus: job.responseStatus ?? null, receiptAfterStop: job.receiptAfterStop === true,
          deliveryMayHaveOccurred: job.lastDeliveryAttemptAt != null && job.acceptedAt == null,
          deliveryState: job.acceptedAt != null ? 'delivered' : ['queued', 'retry', 'sending'].includes(job.state) ? 'pending'
            : job.lastDeliveryAttemptAt != null && job.responseStatus == null ? 'outcome-unknown'
              : job.reason === 'subscription_expired' ? 'expired' : job.reason?.includes('revoked') ? 'revoked'
                : job.state === 'cancelled' || job.state === 'abandoned' ? 'cancelled' : 'rejected',
          source: { applicationId: job.applicationId, eventId: job.sourceEventId, revision: job.sourceRevision ?? null,
            author: job.envelope.data.source_author ?? null, attemptId: job.envelope.data.source_attempt_id ?? null,
            export: job.sourceExport ?? null },
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
  return outbox;
}
