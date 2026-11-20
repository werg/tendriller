// Run with native.cwd set to the already installed synthetic starter. Reuses its native store and helpers.
// No setup, enrollment, assistant consent, publication or model invocation is performed here.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const record = globalThis[Symbol.for('tendriller.idle-soak.record')];
if (!record || !process.send) throw Error('START_WITH_IDLE_SOAK_RUNNER');
const { openSession } = await import(pathToFileURL(resolve('session.mjs')).href);
const { superviseParticipant } = await import(pathToFileURL(resolve('helpers/participant-lifecycle.mjs')).href);
const stop = new AbortController();
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => stop.abort());
// Always open the application first. Optional adapters must never determine its lifetime.
const owned = await openSession({ signal: stop.signal });
let lifecycle, unsubscribe, participationReady = false, reconciled = false, activated = false, sentReady = false;
const ready = () => { if (!sentReady && participationReady && reconciled && activated) { sentReady = true; process.send({ idleSoakReady: 1 }); } };
try {
  const processPairings = owned.processPairings?.bind(owned);
  const observed = { ...owned, processPairings: processPairings ? async (...args) => {
    // Includes watch notifications, bounded active retries, expiry and manual reconciliation, through the same drain.
    record('wakeups'); const result = await processPairings(...args); reconciled = true; ready(); return result;
  } : undefined };
  if (!processPairings || typeof owned.watchSetup !== 'function') throw Error('CURRENT_EVENT_DRIVEN_STARTER_REQUIRED');
  lifecycle = superviseParticipant({ owned: observed, signal: stop.signal, watch: owned.watchSetup, report() {} });
  unsubscribe = owned.session.participation.onStatus(status => { record('wakeups');
    participationReady = ['coordinating', 'following'].includes(status.phase); ready();
  });
  await owned.session.query('notes', null); activated = true; ready();
  process.send({ idleSoakCoverage: 1, bootstrapScope: 'native-only-without-mcp-adapter', wakeups: true, modelTurns: false });
  // The wakeup definition is actual native reconciliation/status/change callbacks, not a future chat wake.
  for await (const _change of owned.session.changes({ signal: stop.signal })) record('wakeups');
} finally {
  if (typeof unsubscribe === 'function') unsubscribe();
  try { await lifecycle?.close(); } finally { await owned.close(); }
}
