import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { activityTimeline, assertIdle, assertDirectWork, counterDelta } from './evidence.mjs';

export const NETWORK_PROFILES = Object.freeze(['relay-upgrade', 'offline', 'impaired', 'freeze', 'background', 'idle']);
const proofFields = ['commandApplied', 'remoteRead', 'operationIdentityPreserved', 'signalDelivered', 'cameraDelivered'];

function assertWork(proof) {
  for (const field of proofFields) assert.equal(proof?.[field], true, `Missing actual application proof: ${field}`);
}

// The maintained first-app adapter owns the real application assertions. No
// synthetic protocol, test command handler or copied application implementation
// is supplied here. All asynchronous adapter methods must honor their signal.
export async function runNetworkScenario(adapter, {
  profile, idleMs = 15_000, pauseMs = 2000, signal,
  phaseMs = 45_000, timeline = activityTimeline(),
} = {}) {
  assert.ok(NETWORK_PROFILES.includes(profile));
  for (const duration of [pauseMs, phaseMs]) assert.ok(Number.isSafeInteger(duration) && duration > 0 && duration <= 60_000);
  assert.ok(Number.isSafeInteger(idleMs) && idleMs >= 1000 && idleMs <= 48 * 60 * 60 * 1000);
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let phase = 'startup';
  let supported = true;
  let idle;
  let failure;
  let cleanup;

  async function bounded(action) {
    const deadline = AbortSignal.timeout(phaseMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(combined.reason); });
    combined.addEventListener('abort', rejectAbort, { once: true });
    try { return await Promise.race([action(combined), aborted]); }
    finally { combined.removeEventListener('abort', rejectAbort); }
  }

  async function work() {
    assertWork(await bounded(signal => adapter.exercise({ signal })));
    timeline.record(phase, 'command');
    timeline.record(phase, 'signal-verified');
    timeline.record(phase, 'sensor-verified');
  }

  try {
    timeline.record(phase, 'start');
    if (profile === 'relay-upgrade') {
      // The adapter has already observed direct, applied a real packet block,
      // and waited for authenticated relay fallback. This phase proves relay
      // application work before restoring packets and promoting back to direct.
      phase = 'blocked';
      const before = await bounded(signal => adapter.snapshot({ signal }));
      assert.equal(before.kind, 'relay', 'Initial authenticated route must be relay');
      await work();
      const after = await bounded(signal => adapter.snapshot({ signal }));
      assert.ok(counterDelta(before, after).relayBytes > 0, 'Real blocked-UDP fallback carried no application payload');
      timeline.record(phase, 'relay');
      await bounded(() => adapter.faults.restoreUdp());
      phase = 'restored'; timeline.record(phase, 'fault-off');
      // Browser/network integration must generate an observable browser network
      // event. Calling reconsiderConnections directly would bypass that boundary.
      const event = await bounded(signal => adapter.networkChange({ signal }));
      assert.equal(event.observed, true, 'Browser network event was not observed');
      assert.ok(['online', 'connection-change', 'visible-pageshow'].includes(event.type));
      timeline.record(phase, 'network-event');
      await bounded(signal => adapter.waitForDirect({ signal }));
    } else if (profile === 'offline') {
      phase = 'offline';
      await bounded(signal => adapter.setOffline(true, { signal }));
      timeline.record(phase, 'fault-on');
      await bounded(signal => adapter.waitForDisconnected({ signal }));
      timeline.record(phase, 'disconnected');
      await sleep(pauseMs, undefined, { signal });
      await bounded(signal => adapter.setOffline(false, { signal }));
      phase = 'restored'; timeline.record(phase, 'fault-off');
      await bounded(signal => adapter.waitForDirect({ signal }));
    } else if (profile === 'impaired') {
      phase = 'impaired';
      await bounded(() => adapter.faults.impair());
      timeline.record(phase, 'fault-on');
      await work();
      await bounded(() => adapter.faults.restoreImpairment());
      phase = 'restored'; timeline.record(phase, 'fault-off');
    } else if (profile === 'freeze') {
      phase = 'frozen';
      await bounded(signal => adapter.setFrozen(true, { signal }));
      timeline.record(phase, 'fault-on');
      await sleep(pauseMs, undefined, { signal });
      await bounded(signal => adapter.setFrozen(false, { signal }));
      phase = 'restored'; timeline.record(phase, 'fault-off');
      await bounded(signal => adapter.waitForDirect({ signal }));
    } else if (profile === 'background') {
      const result = await bounded(signal => adapter.background({ signal, pauseMs }));
      supported = result.hiddenObserved === true;
      // Headless browsers can keep all tabs visible. Record unsupported instead
      // of pretending bringToFront simulated mobile background execution.
      if (supported) await bounded(signal => adapter.waitForDirect({ signal }));
    }

    if (supported) {
      const before = await bounded(signal => adapter.snapshot({ signal }));
      assert.equal(before.kind, 'direct', 'Authenticated direct route required after recovery');
      await work();
      const after = await bounded(signal => adapter.snapshot({ signal }));
      assert.equal(after.kind, 'direct');
      assertDirectWork(before, after);
      timeline.record(phase, 'direct');
      assertWork(await bounded(signal => adapter.reloadAndVerify({ signal })));
      timeline.record(phase, 'reload-verified');
      await bounded(signal => adapter.waitForDirect({ signal }));
      const reopened = await bounded(signal => adapter.snapshot({ signal }));
      assert.equal(reopened.relayBytes, after.relayBytes, 'Reopen after promotion used host relay payload');

      phase = 'idle';
      await bounded(signal => adapter.settle({ signal }));
      const initial = await bounded(signal => adapter.snapshot({ signal }));
      timeline.record(phase, 'start', initial);
      const idleStarted = performance.now();
      await sleep(idleMs, undefined, { signal }); // No polling/requests during this segment.
      const final = await bounded(signal => adapter.snapshot({ signal }));
      const observedMs = performance.now() - idleStarted;
      idle = { ...assertIdle(initial, final), requestedMs: idleMs, observedMs };
      timeline.record(phase, 'end', final);
    }
  } catch (error) {
    failure = error;
    timeline.record(phase, signal?.aborted ? 'stop-request' : 'failure');
  } finally {
    phase = 'cleanup';
    try { await adapter.cleanup(); cleanup = true; }
    catch (error) { cleanup = false; failure ??= error; }
    timeline.record(phase, 'end');
  }
  const report = { version: 1, profile, startedAt, finishedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started, supported, success: !failure && supported, cleanup, idle,
    scope: 'sealed-first-app-browser-network-emulation', timeline: timeline.snapshot(),
    hardwareScope: 'No physical mobile radio, carrier NAT or OS sleep qualification.' };
  // Preserve the original assertion for the caller while making its safe report
  // available. Arbitrary exception messages never enter the public evidence.
  if (failure) { failure.networkReport = report; throw failure; }
  return report;
}
