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
  let lifecycle, unsubscribe, assistantTask, changesTask, closing;
  let participationReady = false, reconciled = false, activated = false, adapterReady = !assistant, sentReady = false;
  const closeOwned = () => closing ??= Promise.resolve().then(() => owned.close());
  const ready = () => {
    if (sentReady || lifetime.aborted || !participationReady || !reconciled || !activated || !adapterReady) return;
    sentReady = true;
    send({ idleSoakCoverage: 1, bootstrapScope: assistant ? 'native-with-mcp-adapter' : 'native-only-without-mcp-adapter', wakeups: true, modelTurns: false });
    send({ idleSoakReady: 1 });
  };
  try {
    const processPairings = owned.processPairings?.bind(owned);
    if (!processPairings || typeof owned.watchSetup !== 'function') throw Error('CURRENT_EVENT_DRIVEN_STARTER_REQUIRED');
    const observed = { ...owned, close: closeOwned, processPairings: async (...args) => {
      // Counts every actual pass, including setup notifications, active retries and expiry.
      record('wakeups'); const result = await processPairings(...args); reconciled = true; ready(); return result;
    } };
    unsubscribe = owned.session.participation.onStatus(status => {
      record('wakeups'); participationReady = ['coordinating', 'following'].includes(status.phase) && !status.error && !status.recovery; ready();
    });
    if (assistant) {
      if (typeof runAssistant !== 'function') throw Error('CANONICAL_ASSISTANT_REQUIRED');
      assistantTask = Promise.resolve().then(() => runAssistant({ signal: lifetime, events }, {
        // runAssistant must reuse this observed owner, never open a second signing store.
        open: async () => { lifetime.throwIfAborted(); return observed; },
        report(value) {
          record('wakeups');
          if (value.state === 'adapter_online') adapterReady = true;
          if (['adapter_offline', 'assistant_stopped', 'setup_channel_closed', 'stopped'].includes(value.state) ||
              ['disconnected', 'closed'].includes(value.assistant?.state)) adapterReady = false;
          ready();
        },
      }));
      assistantTask.catch(() => {});
    } else lifecycle = superviseParticipant({ owned: observed, signal: lifetime, watch: owned.watchSetup, report() {} });
    changesTask = (async () => { for await (const _change of owned.session.changes({ signal: lifetime })) record('wakeups'); })();
    changesTask.catch(() => {});
    await untilStopped(Promise.race([owned.session.query('notes', null), ...[assistantTask, changesTask].filter(Boolean).map(task => task.then(() => { throw Error('NATIVE_OBSERVER_EXITED_BEFORE_ACTIVATION'); }))]), lifetime);
    activated = true; ready();
    await untilStopped(Promise.race([changesTask, ...[assistantTask].filter(Boolean)]), lifetime);
  } catch (error) { if (!lifetime.aborted) throw error; }
  finally {
    stop.abort();
    if (typeof unsubscribe === 'function') unsubscribe();
    try {
      await lifecycle?.close();
      await Promise.allSettled([assistantTask, changesTask].filter(Boolean));
    } finally { await closeOwned(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = bootstrapOptions(process.argv.slice(2));
  const record = globalThis[Symbol.for('tendriller.idle-soak.record')];
  if (!record || !process.send) throw Error('START_WITH_IDLE_SOAK_RUNNER');
  const stop = new AbortController(), abort = () => stop.abort();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, abort);
  try {
    const { openSession } = await import(pathToFileURL(resolve('session.mjs')).href);
    const dependencies = options.assistant
      ? { openSession, runAssistant: (await import(pathToFileURL(resolve('assistant.mjs')).href)).runAssistant }
      : { openSession, superviseParticipant: (await import(pathToFileURL(resolve('helpers/participant-lifecycle.mjs')).href)).superviseParticipant };
    await runNativeBootstrap({ ...options, record, send: value => process.send(value), signal: stop.signal }, dependencies);
  } finally { for (const event of ['SIGTERM', 'SIGINT']) process.removeListener(event, abort); }
}
