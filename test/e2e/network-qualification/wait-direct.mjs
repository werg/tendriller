import { performance } from 'node:perf_hooks';

// Route readiness and its observations have separate outcomes. A failed
// observation never replaces the route failure, but cannot qualify a success.
export async function waitForDirectEvidence({ evidence, snapshot, wait, counters,
  publish, now = () => performance.now() }) {
  const started = now();
  let failure;
  let failed = false;
  let hostEpoch;
  evidence.completed = false;
  evidence.diagnosticFailed = false;
  evidence.diagnosticFailures = {};
  const observe = async (stage, read) => {
    try { return await read(); }
    catch (error) {
      evidence.diagnosticFailed = true;
      evidence.diagnosticFailures[stage] = true;
      if (!failed) { failure = error; failed = true; }
    }
  };
  const publicCounters = value => {
    const { instance, ...publicValue } = value;
    return { instance, publicValue };
  };
  evidence.before = await observe('beforeSnapshot', snapshot);
  await observe('hostBefore', async () => {
    const value = publicCounters(await counters());
    hostEpoch = value.instance;
    evidence.hostBefore = value.publicValue;
  });
  if (!failed) {
    try {
      evidence.after = await wait();
      evidence.completed = true;
    } catch (error) {
      // Assign before reading anything else: even two failed observations must
      // leave this exact primary error available to the qualification caller.
      failure = error;
      failed = true;
      evidence.after = await observe('afterSnapshot', snapshot);
    }
  }
  evidence.elapsedMs = now() - started;
  await observe('hostAfter', async () => {
    const value = publicCounters(await counters());
    evidence.hostAfter = value.publicValue;
    if (evidence.hostBefore) evidence.sameHostEpoch = hostEpoch === value.instance;
  });
  if (publish) await observe('progress', async () => {
    try { await publish(evidence); }
    catch (error) { evidence.progressFailed = true; throw error; }
  });
  if (failed) throw failure;
  return evidence;
}
