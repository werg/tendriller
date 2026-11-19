import { createSessionBridge } from './bridge.mjs';
import { createConsentManagementHandler, createConsentService } from './consent.mjs';
import { createSubscriptions, selectedTail } from './subscriptions.mjs';
import { createOutbox } from './outbox.mjs';
import { createDeliveryDrain } from './drain.mjs';
import { createMcpHandler } from './server.mjs';
import { createWorkerDeliveryStore } from './worker-store.mjs';
import { callbackUrl } from './webhook-data.mjs';
import { definition } from './examples/kitchen/domain.mjs';
import { kitchenEventProjection } from './examples/kitchen/projection.mjs';
import { widgetResource } from './widget/metadata.mjs';
import { fail } from './common.mjs';

/** Deployment-trusted code supplies the executable definition. Verify its immutable
 * commitments when opening the enrolled session before reading or writing history. */
export async function withWorkerAssistant(t, deps, work) {
  const { applicationId, oauth, auth, authorizeAccountAccess, authorizeOwner, authenticateOwner, openSession } = deps;
  const queries = ['kitchenContext', 'assistanceStatus'];
  const commands = ['requestAssistance', 'replyToAssistance'];
  const events = ['assistant.help_requested', 'application.recovery_notice'];
  const label = 'Kitchen assistance';
  const clock = () => t.now();
  const store = createWorkerDeliveryStore(t, t.env.ASSISTANT_STORE_KEY);
  const bridge = createSessionBridge({ applyBudgetMs: 4000, applications: [{ id: applicationId, label, openSession: openSession(definition),
    allowedQueries: queries, allowedCommands: commands, eventTopics: ['assistant'], eventProjection: kitchenEventProjection }] });
  const origins = new Set((t.env.ASSISTANT_CALLBACK_ORIGINS ?? '').split(/\s+/).filter(Boolean).map(value => {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== 'https:') throw Error('ASSISTANT_CALLBACK_ORIGIN_INVALID');
    return url.origin;
  }));
  async function send(target, { body, headers, signal, prepareWrite, beforeWrite }) {
    const url = new URL(callbackUrl(target));
    if (!origins.has(url.origin)) fail('CALLBACK_ADDRESS_BLOCKED', 'Callback must use a configured provider origin', { status: 403 });
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)]);
    if (prepareWrite) await prepareWrite();
    deadline.throwIfAborted();
    beforeWrite?.();
    const response = await fetch(url.href, { method: 'POST', redirect: 'manual', body, headers, signal: deadline });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      fail('CALLBACK_REDIRECT', 'Webhook redirects are unavailable', { status: 403 });
    }
    if (beforeWrite) {
      await response.body?.cancel();
      return { status: response.status, body: '' };
    }
    const reader = response.body?.getReader(), decoder = new TextDecoder();
    let value = '', bytes = 0;
    if (reader) try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8192) fail('CALLBACK_RESPONSE_TOO_LARGE', 'Callback response exceeds 8 KiB');
        value += decoder.decode(chunk.value, { stream: true });
      }
      value += decoder.decode();
    } finally { await reader.cancel(); }
    return { status: response.status, body: value };
  }
  const consent = createConsentService({ store, authorizeOwner, clock });
  const authorize = async (principal, id, event) => {
    if (!await authorizeAccountAccess(principal, id))
      fail('ACCOUNT_ACCESS_DENIED', 'Current account access is required', { status: 403 });
    await consent.assertAccess(principal, { applicationId: id, kind: 'event', name: event });
  };
  const subscriptions = createSubscriptions({ store, authorize, send, clock, maxPerOwner: 8,
    captureCursor: id => selectedTail(bridge, id), applicationIds: async principal =>
      await authorizeAccountAccess(principal, applicationId) ? [applicationId] : [] });
  const outbox = createOutbox({ store, bridge, authorize, send, clock, maxJobs: 128 });
  const management = createConsentManagementHandler({ service: consent, authenticate: authenticateOwner,
    applicationsForPrincipal: async principal => await authorizeOwner(principal, applicationId)
      ? [{ applicationId, label, queries, commands, events, allowEventDetails: true }] : [],
    csrfKey: Buffer.from(t.env.ASSISTANT_STORE_KEY, 'base64'), origin: oauth.issuer, clock });
  const handler = createMcpHandler({ auth, bridge, consent, subscriptions, outbox, store,
    authorizeAccountAccess, resource: oauth.resource, management, clock, maxOperations: 128,
    async widget() {
      const response = await t.env.ASSETS.fetch(new Request(oauth.issuer + '/assistant-widget.html'));
      if (!response.ok) throw Error('ASSISTANT_WIDGET_UNAVAILABLE');
      return widgetResource(await response.text());
    } });
  try {
    return await work({ handler, drain: createDeliveryDrain({ subscriptions, bridge, outbox, store, authorize, clock }),
      active: async () => (await subscriptions.active()).some(sub => !sub.pausedReason) });
  } finally {
    await bridge.close();
    await store.close();
  }
}
