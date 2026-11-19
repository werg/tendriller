/** One bounded pass over selected application events and due webhook deliveries. */
export function createDeliveryDrain({ subscriptions, bridge, outbox, store, authorize, clock = Date.now,
  batches = 4, deliveries = 4 } = {}) {
  async function scan(subscription, signal) {
    const { id, applicationId } = subscription;
    let cursor = subscription.sourceCursor ?? undefined;
    let more = false;
    try {
      await authorize(subscription.owner, applicationId, subscription.name);
      for (let i = 0; i < batches; i++) {
        signal?.throwIfAborted();
        const batch = await bridge.readEvents(applicationId, { cursor });
        more = batch.hasMore;
        if (batch.cursor === cursor) {
          if (more) throw Object.assign(Error('Source cursor stalled'), { code: 'BRIDGE_EVENT_CURSOR_STALLED' });
          break;
        }
        if (!await outbox.ingest(id, batch, { expectedCursor: cursor })) return false;
        cursor = batch.cursor;
        if (!more) break;
      }
    } catch (error) {
      if (error.code === 'APPLICATION_VIEW_RECOVERED' || error.message === 'APPLICATION_VIEW_RECOVERED') {
        await outbox.pauseForRecovery(id, { revision: await bridge.readRevision(applicationId) }, { subscription });
        return false;
      }
      if (error.status !== 401 && error.status !== 403 && error.code !== 'BRIDGE_GRANT_REQUIRED') throw error;
      await store.transaction(state => {
        const current = state.subscriptions?.[id];
        if (!current || current.version !== subscription.version || current.activationId !== subscription.activationId) return;
        current.active = false;
        current.stopReason = 'authorization_revoked';
        current.version++;
        delete current.secret;
        delete current.previousSecret;
        delete current.pendingToken;
        delete current.pendingUntil;
      });
      return false;
    }
    return more;
  }
  return async function drain({ observe = false, signal } = {}) {
    let more = false;
    if (observe) for (const subscription of await subscriptions.active()) {
      if (!subscription.pausedReason) more = await scan(subscription, signal) || more;
    }
    await outbox.dispatchDue({ limit: deliveries, signal });
    const now = clock(), state = await store.read();
    let nextDue = null;
    for (const job of Object.values(state.jobs ?? {})) {
      const sub = state.subscriptions?.[job.subscriptionId];
      if (!sub?.active || sub.expiresAt <= now || (sub.activationId ?? null) !== (job.activationId ?? null) ||
          (sub.pausedReason && job.sourceKind !== 'recovery')) continue;
      const due = job.state === 'sending' ? Math.max(job.leaseUntil ?? now, job.nextAttemptAt)
        : ['queued', 'retry'].includes(job.state) ? job.nextAttemptAt : null;
      if (due !== null && (nextDue === null || due < nextDue)) nextDue = due;
    }
    return { more, nextDue };
  };
}
