import { createOAuthVerifier } from './auth.mjs';
import { createConsentManagementHandler, createConsentService } from './consent.mjs';
import { createSessionBridge } from './bridge.mjs';
import { createLifecycleService } from './lifecycle.mjs';
import { createWorkspaceAgentAdapter } from './workspace-agent.mjs';
import { createSubscriptions, selectedTail } from './subscriptions.mjs';
import { createOutbox } from './outbox.mjs';
import { openDeliveryStore } from './store.mjs';
import { createMcpHandler } from './server.mjs';
import { fail, SCOPES } from './common.mjs';

function waitForWake(signal, delay, setWake) {
  return new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); setWake(null); resolve(); };
    timer = setTimeout(finish, delay); setWake(finish);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Compose explicit deployment adapters; it never provisions or grants a peer. */
export async function createIntegration(config = {}) {
  const resource = new URL(config.resource);
  if (resource.protocol !== 'https:' || resource.username || resource.password || resource.search || resource.hash ||
      typeof config.authorizeAccountAccess !== 'function')
    fail('INTEGRATION_CONFIGURATION_REQUIRED', 'Configure an HTTPS MCP resource and an authoritative account-to-application lookup');
  const clock = config.clock ?? Date.now;
  if (!Number.isSafeInteger(config.tickMs ?? 1000) || (config.tickMs ?? 1000) < 25 || (config.tickMs ?? 1000) > 60000)
    fail('INTEGRATION_CONFIGURATION_REQUIRED', 'Delivery tickMs must be between 25 and 60000 milliseconds');
  const report = (component, error) => {
    const details = { component, code: String(error?.code ?? error?.name ?? 'UNAVAILABLE').slice(0, 128) };
    try { config.onError?.(details); } catch { /* diagnostics never override the original state */ }
  };
  const store = config.store ?? openDeliveryStore({ path: config.storePath, key: config.storeKey });
  let bridge;
  try {
    const auth = config.auth ?? createOAuthVerifier({ ...(config.oauth ?? {}), issuer: config.issuer, resource: config.resource,
      jwksUri: config.jwksUri, scopesSupported: SCOPES });
    bridge = config.bridge ?? createSessionBridge({ applications: config.applications, ...(config.bridgeLimits ?? {}) });
    const originalConsent = createConsentService({ store, authorizeOwner: config.authorizeOwner, clock });
    const lifetime = new AbortController(), watchers = new Map();
    let started = false, closed = false, loop, wake;
    const wakeUp = () => wake?.();
    async function authorized(principal, applicationId, eventName) {
      if (await config.authorizeAccountAccess(principal, applicationId) !== true)
        fail('ACCOUNT_ACCESS_DENIED', 'Current account access to the application is required', { status: 403 });
      await originalConsent.assertAccess(principal, { applicationId, kind: eventName == null ? 'read' : 'event', ...(eventName == null ? {} : { name: eventName }) });
      return true;
    }
    const subscriptions = createSubscriptions({ store, clock, authorize: authorized,
      captureCursor: id => selectedTail(bridge, id), applicationIds: async principal => {
        const ids = [];
        for (const item of bridge.listApplications()) if (await config.authorizeAccountAccess(principal, item.id) === true) ids.push(item.id);
        return ids;
      }, ...(config.delivery?.send ? { send: config.delivery.send } : {}), ...(config.subscriptionLimits ?? {}) });
    const outbox = createOutbox({ store, bridge, clock, authorize: authorized,
      ...(config.delivery?.send ? { send: config.delivery.send } : {}), ...(config.outboxLimits ?? {}) });
    async function recheckSubscriptions() {
      for (const sub of await subscriptions.active()) {
        try { await authorized(sub.owner, sub.applicationId, sub.name); }
        catch (error) {
          if (error.status === 401 || error.status === 403) {
            await store.transaction(state => {
              const current = state.subscriptions?.[sub.id];
              if (current?.activationId !== sub.activationId) return;
              current.active = false; current.stopReason = 'authorization_revoked'; current.version++;
              delete current.secret; delete current.previousSecret;
              for (const job of Object.values(state.jobs ?? {})) if (job.subscriptionId === sub.id && ['queued', 'retry', 'sending'].includes(job.state))
                Object.assign(job, { state: 'cancelled', reason: 'authorization_revoked', updatedAt: clock() });
            });
          } else report('subscription_authorization', error);
        }
      }
      await outbox.cancelInactive();
    }
    const changed = () => { void recheckSubscriptions().catch(error => report('subscription_change', error)); wakeUp(); };
    const detach = subscriptions.onChange(changed);
    const consent = { ...originalConsent,
      async grant(principal, input) { const result = await originalConsent.grant(principal, input); await recheckSubscriptions(); wakeUp(); return result; },
      async revoke(principal, input) { const result = await originalConsent.revoke(principal, input); await recheckSubscriptions(); wakeUp(); return result; },
    };
    let management;
    if (config.management) management = createConsentManagementHandler({ ...config.management, service: consent, origin: resource.origin, clock });
    const publicationApproval = config.lifecycle?.authorizePublication;
    const lifecycle = config.lifecycle ? createLifecycleService({ ...config.lifecycle, store, clock,
      ...(publicationApproval ? { authorizePublication: async (principal, review) => {
        await authorized(principal, review.applicationId, null);
        return await publicationApproval(principal, review) === true;
      } } : {}),
    }) : undefined;
    const workspaceAgent = config.workspaceAgent ? createWorkspaceAgentAdapter({ ...config.workspaceAgent,
      store, bridge, authorize: authorized, clock }) : undefined;
    const handler = createMcpHandler({ auth, bridge, consent, subscriptions, outbox, store,
      authorizeAccountAccess: config.authorizeAccountAccess, resource: config.resource, lifecycle, workspaceAgent,
      management, clock, onSubscriptionsChanged: changed,
      ...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
      ...(config.maxRequestBytes ? { maxRequestBytes: config.maxRequestBytes } : {}),
      ...(config.requestsPerMinute ? { requestsPerMinute: config.requestsPerMinute } : {}),
    });
    async function observationFailure(id, error) {
      await store.transaction(state => {
        const sub = state.subscriptions?.[id];
        if (sub) { sub.observerError = String(error.code ?? error.name ?? 'SOURCE_UNAVAILABLE').slice(0, 128); sub.observerErrorAt = clock(); }
      });
      report('native_observer', error);
    }
    async function reconcile() {
      await recheckSubscriptions();
      const active = new Map((await subscriptions.active()).filter(sub => !sub.pausedReason).map(sub => [sub.id, sub]));
      for (const [id, watcher] of watchers) {
        const sub = active.get(id);
        if (!sub || watcher.version !== sub.version || watcher.activationId !== sub.activationId) watcher.controller.abort();
      }
      for (const [id, sub] of active) {
        if (watchers.has(id)) continue;
        const controller = new AbortController(), signal = AbortSignal.any([lifetime.signal, controller.signal]);
        const watcher = { controller, version: sub.version, activationId: sub.activationId, task: null };
        watchers.set(id, watcher);
        watcher.task = (async () => {
          let cursor = sub.sourceCursor;
          try {
            for await (const batch of bridge.observe(sub.applicationId, { ...(cursor == null ? {} : { cursor }), signal })) {
              if (signal.aborted) break;
              if (batch.kind === 'recovery') { await outbox.pauseForRecovery(id, batch); wakeUp(); break; }
              if (!await outbox.ingest(id, batch, { expectedCursor: cursor })) break;
              cursor = batch.cursor;
              await store.transaction(state => { const current = state.subscriptions?.[id]; if (current?.activationId === watcher.activationId) { delete current.observerError; delete current.observerErrorAt; } });
              wakeUp();
            }
          } catch (error) { if (!signal.aborted) await observationFailure(id, error); }
          finally { if (watchers.get(id) === watcher) watchers.delete(id); }
        })();
        void watcher.task.catch(error => report('observer_shutdown', error));
      }
    }
    return {
      handler, auth, bridge, consent, subscriptions, outbox, store, lifecycle, workspaceAgent,
      start() {
        if (closed) fail('INTEGRATION_CLOSED', 'Integration is closed');
        if (started) return; started = true;
        loop = (async () => {
          while (!lifetime.signal.aborted) {
            try { await reconcile(); await outbox.dispatchDue({ signal: lifetime.signal }); }
            catch (error) { if (!lifetime.signal.aborted) report('delivery_worker', error); }
            await waitForWake(lifetime.signal, config.tickMs ?? 1000, value => { wake = value; });
          }
        })();
      },
      async close() {
        if (closed) return; closed = true; detach(); lifetime.abort(); wakeUp();
        for (const watcher of watchers.values()) watcher.controller.abort();
        await loop;
        await Promise.allSettled([...watchers.values()].map(watcher => watcher.task));
        await bridge.close(); await store.close();
      },
    };
  } catch (error) { await bridge?.close?.(); await store.close(); throw error; }
}
