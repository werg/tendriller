// Run in the already installed synthetic starter. The operator prepares/reviews optional MCP access first.
// This bootstrap owns exactly one native store; it performs no setup, enrollment, or model invocation.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export function bootstrapOptions(args) {
  const { values } = parseArgs({ args, options: { assistant: { type: 'boolean', default: false }, events: { type: 'boolean', default: false } } });
  if (values.events && !values.assistant) throw Error('EVENTS_REQUIRE_ASSISTANT');
  return values;
}
function untilStopped(task, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error('NATIVE_BOOTSTRAP_STOPPED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Observation/readiness only: assistant lifecycle and preparation remain in the app's canonical runAssistant. */
export async function runNativeBootstrap({ assistant = false, events = false, signal, record, send }, {
  openSession, superviseParticipant, runAssistant,
}) {
  if (events && !assistant) throw Error('EVENTS_REQUIRE_ASSISTANT');
  if (typeof record !== 'function' || typeof send !== 'function') throw Error('START_WITH_IDLE_SOAK_RUNNER');
  signal?.throwIfAborted();
  const stop = new AbortController(), opening = AbortSignal.any([stop.signal, ...[signal].filter(Boolean)]);
  const owned = await openSession({ signal: opening });
  const lifetime = AbortSignal.any([opening, owned.session.signal].filter(Boolean));
  let lifecycle, unsubscribeNetwork, unsubscribeStatus, assistantTask, changesTask, closing;
  let participationReady = false, localReady = false, activated = false, adapterReady = !assistant, sentReady = false;
  let observing = true, lastOnline, lastBlocked, eventsForwardingBlocked = false, ownerClosed = false, observersSettled = false;
  const assistantStatus = online => {
    adapterReady = online;
    if (!assistant || lastOnline === online && lastBlocked === eventsForwardingBlocked) return;
    lastOnline = online; lastBlocked = eventsForwardingBlocked;
    send({ idleSoakAssistantStatus: 1, online, eventsForwarding: events, eventsForwardingBlocked });
  };
  const closeOwned = () => closing ??= Promise.resolve().then(async () => { await owned.close(); ownerClosed = true; });
  const ready = () => {
    if (sentReady || lifetime.aborted || !participationReady || !localReady || !activated || !adapterReady || eventsForwardingBlocked) return;
    sentReady = true;
    send({ idleSoakCoverage: 1, bootstrapScope: assistant ? 'native-with-mcp-adapter' : 'native-only-without-mcp-adapter', wakeups: true, modelTurns: false, eventsForwarding: assistant && events });
    send({ idleSoakReady: 1 });
  };
  try {
    if (typeof owned.session.onStatus !== 'function' || typeof owned.participation?.onStatus !== 'function' || typeof owned.watchSetup !== 'function') throw Error('CURRENT_EVENT_DRIVEN_STARTER_REQUIRED');
    const observed = { ...owned, close: closeOwned, ...(typeof owned.watchSetup === 'function' ? { watchSetup: options => owned.watchSetup({ ...options,
      onChange(value) { record('wakeups'); return options.onChange(value); },
    }) } : {}) };
    unsubscribeStatus = owned.session.onStatus(status => {
      record('wakeups'); localReady = status.canAuthor === true; ready();
    });
    unsubscribeNetwork = owned.participation.onStatus(status => {
      record('wakeups'); participationReady = status.phase === 'connected' && !status.error; ready();
    });
    if (assistant) {
      assistantStatus(false);
      if (typeof runAssistant !== 'function' || typeof observed.watchSetup !== 'function') throw Error('CANONICAL_ASSISTANT_AND_CONSENT_WATCH_REQUIRED');
      assistantTask = Promise.resolve().then(() => runAssistant({ signal: lifetime, events }, {
        // runAssistant must reuse this observed owner, never open a second signing store.
        open: async () => { lifetime.throwIfAborted(); return observed; },
        report(value) {
          if (!observing || lifetime.aborted) return;
          record('wakeups');
          if (value.state === 'adapter_activity_failed' && events) { eventsForwardingBlocked = true; assistantStatus(adapterReady); }
          if (value.state === 'adapter_online') assistantStatus(true);
          if (['adapter_offline', 'assistant_stopped', 'setup_channel_closed', 'awaiting_assistant_consent', 'stopped'].includes(value.state) ||
              ['disconnected', 'closed'].includes(value.assistant?.state)) assistantStatus(false);
          ready();
        },
      }));
      assistantTask.catch(() => {});
    }
    if (!assistant) lifecycle = superviseParticipant({ owned: observed, signal: lifetime, watch: observed.watchSetup, report() {} });
    changesTask = (async () => { for await (const _change of owned.session.changes({ signal: lifetime })) record('wakeups'); })();
    changesTask.catch(() => {});
    await untilStopped(Promise.race([owned.session.query('notes', null), ...[assistantTask, changesTask].filter(Boolean).map(task => task.then(() => { throw Error('NATIVE_OBSERVER_EXITED_BEFORE_ACTIVATION'); }))]), lifetime);
    activated = true; ready();
    await untilStopped(Promise.race([changesTask, ...[assistantTask].filter(Boolean)]), lifetime);
  } catch (error) { if (!lifetime.aborted) throw error; }
  finally {
    observing = false; assistantStatus(false);
    stop.abort();
    unsubscribeNetwork?.(); unsubscribeStatus?.();
    try {
      // Close the aborted owner before waiting for readers which can be
      // blocked on that owner's transport. The canonical hook shares this promise.
      await closeOwned();
      await lifecycle?.close();
      await Promise.allSettled([assistantTask, changesTask].filter(Boolean));
      observersSettled = true;
    } finally { await closeOwned(); }
  }
  return { ownerClosed, observersSettled, assistantSettled: !assistant || observersSettled };
}

// The dedicated runner child owns its process too. Dispose it only after all
// application work/bytes close; a peer-initiated Undici close handshake may otherwise
// retain TCP handles indefinitely. This is explicit process disposal, not a
// claim that every WebSocket completed a graceful remote close handshake.
export async function disposeStoppedBootstrap(receipt, { send, disconnect, exit }) {
  if (!receipt?.ownerClosed || !receipt.observersSettled || !receipt.assistantSettled) throw Error('NATIVE_OWNED_SHUTDOWN_REQUIRED');
  await send({ idleSoakStopped: 1, ownerClosed: true, observersSettled: true, assistantSettled: true, processDisposal: true });
  disconnect(); exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = bootstrapOptions(process.argv.slice(2));
  const record = globalThis[Symbol.for('tendriller.idle-soak.record')];
  if (!record || !process.send) throw Error('START_WITH_IDLE_SOAK_RUNNER');
  const stop = new AbortController(), abort = () => stop.abort();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, abort);
  try {
    const { openSession } = await import(pathToFileURL(resolve('session.mjs')).href);
    const dependencies = { openSession, ...(options.assistant ? { runAssistant: (await import(pathToFileURL(resolve('assistant.mjs')).href)).runAssistant } : { superviseParticipant: (await import(pathToFileURL(resolve('helpers/participant-lifecycle.mjs')).href)).superviseParticipant }) };
    const receipt = await runNativeBootstrap({ ...options, record, send: value => process.send(value), signal: stop.signal }, dependencies);
    await disposeStoppedBootstrap(receipt, { send: value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve())),
      disconnect: () => { if (process.connected) process.disconnect(); }, exit: code => process.exit(code) });
  } finally { for (const event of ['SIGTERM', 'SIGINT']) process.removeListener(event, abort); }
}
