import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CLOCK_CHANNEL = 'tendriller.first-app.signal-clock.v1';
const TOPIC = 'first-app-signal-freshness';
const COUNTERS = ['capacity', 'clockSkew', 'duplicate', 'expired', 'total', 'unauthorized'];

// The downloaded test application alone receives this fixture. Public packages,
// signing, transport, freshness limits and the shipped tutorial remain unchanged.
export async function prepareSignalQualification(app) {
  await appendFile(join(app, 'worker.mjs'), `\n;(${installWorkerClock.toString()})();\n`);
}

// Serialized into the private test application; contains no module references.
function installWorkerClock() {
  const originalNow = Date.now;
  let frozen = null, highWater = 0;
  const channel = new BroadcastChannel('tendriller.first-app.signal-clock.v1');
  channel.onmessage = ({ data }) => {
    if (data?.protocol !== 'first-app-signal-clock' || typeof data.id !== 'string') return;
    try {
      if (data.time !== null && (!Number.isSafeInteger(data.time) || data.time < highWater || data.time > originalNow() + 20_000))
        throw Error('INVALID_FIXTURE_CLOCK');
      frozen = data.time;
      if (frozen !== null) highWater = Math.max(highWater, frozen);
      Date.now = frozen === null ? originalNow : () => frozen;
      channel.postMessage({ protocol: data.protocol, id: data.id, time: frozen, highWater });
      if (data.close) { Date.now = originalNow; channel.close(); }
    } catch { channel.postMessage({ protocol: data.protocol, id: data.id, error: 'INVALID_FIXTURE_CLOCK' }); }
  };
}

// Serialized by nativeTestPeerSource. All imports are public consumer APIs.
export async function createSignalQualification(owned) {
  const { readTransportDiagnostics } = await import('@tendriller/core/transport-diagnostics');
  const session = owned.session, originalNow = Date.now;
  let frozen = null, highWater = 0, stop, collecting, failure, unwatch = () => {};
  const observed = [], revisions = [];
  const restore = () => { frozen = null; Date.now = originalNow; return { restored: true, highWater }; };
  const close = async () => {
    restore(); unwatch(); stop?.abort(); await collecting;
    if (failure) throw failure;
  };
  return { close, actions: {
    async 'signal-qualification-begin'() {
      if (stop) throw Error('SIGNAL_QUALIFICATION_ALREADY_STARTED');
      stop = new AbortController();
      revisions.push(session.participation.status.connectionRevision);
      unwatch = session.participation.onStatus(status => {
        if (revisions.at(-1) !== status.connectionRevision) {
          if (revisions.length >= 16) { failure = Error('SIGNAL_QUALIFICATION_RECONNECT_LOOP'); stop.abort(); }
          else revisions.push(status.connectionRevision);
        }
      });
      collecting = (async () => {
        for await (const signal of session.signals.subscribe({ topics: ['first-app-signal-freshness'], mode: 'all', signal: stop.signal })) {
          if (observed.length >= 8) throw Error('SIGNAL_QUALIFICATION_UNEXPECTED_DELIVERY');
          observed.push({ label: signal.payload, issuedAtMs: signal.issuedAtMs, expiresAtMs: signal.expiresAtMs });
        }
      })().catch(error => { if (!stop.signal.aborted) failure = error; });
      return { started: true };
    },
    async 'signal-qualification-clock'({ time }) {
      if (time === null) return restore();
      if (!Number.isSafeInteger(time) || time < highWater || time > originalNow() + 20_000) throw Error('INVALID_FIXTURE_CLOCK');
      frozen = time; highWater = Math.max(highWater, time); Date.now = () => frozen;
      return { time: frozen, highWater };
    },
    async 'signal-qualification-snapshot'() {
      if (failure) throw failure;
      return { observed: [...observed], revisions: [...revisions], aborted: session.signal.aborted,
        transport: await readTransportDiagnostics(session.participation) };
    },
    async 'signal-qualification-send'({ label }) {
      const sent = await session.signals.send('first-app-signal-freshness-reply', label, { ttlMs: 10_000 });
      return { issuedAtMs: sent.issuedAtMs, expiresAtMs: sent.expiresAtMs };
    },
  } };
}

async function browserClock(page, time, close = false) {
  return page.evaluate(({ name, time, close }) => new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(name), id = crypto.randomUUID();
    const finish = (error, value) => { clearTimeout(timer); channel.close(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(Error('SIGNAL_QUALIFICATION_WORKER_CLOCK_TIMEOUT')), 5000);
    channel.onmessage = ({ data }) => {
      if (data?.protocol !== 'first-app-signal-clock' || data.id !== id) return;
      if (data.error) finish(Error(data.error)); else finish(null, data);
    };
    channel.postMessage({ protocol: 'first-app-signal-clock', id, time, close });
  }), { name: CLOCK_CHANNEL, time, close });
}

/** Actual signed browser/native traffic, on the existing authenticated link. */
export async function qualifyFirstAppSignals({ page, peer, expect, transportCounters, transport = 'direct' }) {
  const snapshot = () => peer.request('signal-qualification-snapshot');
  const clockNative = time => peer.request('signal-qualification-clock', { time });
  const clockBrowser = time => browserClock(page, time);
  const send = async (label, time, ttlMs = 10_000) => {
    await clockBrowser(time);
    const sent = await page.evaluate(async ({ topic, label, ttlMs }) => {
      await window.tendril.signals.ready();
      const value = await window.tendril.signals.send(topic, label, { ttlMs });
      return { issuedAtMs: value.issuedAtMs, expiresAtMs: value.expiresAtMs };
    }, { topic: TOPIC, label, ttlMs });
    assert.equal(sent.issuedAtMs, time, 'The real browser signer must use the exact controlled clock.');
    assert.equal(sent.expiresAtMs, time + ttlMs);
    return sent;
  };
  const counts = value => {
    assert.equal(value.transport.state, 'available'); assert.equal(value.transport.sampled, true);
    assert.equal(value.transport.error, null); assert.equal(value.transport.connections.length, 1);
    const counters = value.transport.connections[0].signalRejections;
    assert.deepEqual(Object.keys(counters).sort(), COUNTERS);
    for (const value of Object.values(counters)) assert.ok(Number.isSafeInteger(value) && value >= 0);
    return counters;
  };
  await peer.request('signal-qualification-begin');
  await expect.poll(async () => (await snapshot()).transport.connections.length, { timeout: 30_000 }).toBe(1);
  const before = await snapshot(), baseline = counts(before), wireBefore = await transportCounters();
  const base = Date.now() + 500, lastClock = base + 3102;
  let checked, qualificationFailure;
  try {
    await clockNative(base);
    await send('inside-tolerance', base + 1999);
    await expect.poll(async () => (await snapshot()).observed.map(item => item.label)).toEqual(['inside-tolerance']);
    await send('at-tolerance', base + 2000);
    await expect.poll(async () => (await snapshot()).observed.map(item => item.label)).toEqual(['inside-tolerance', 'at-tolerance']);
    // Each frame is signed by the real browser. Local echo/send completion is
    // deliberately not accepted as evidence of delivery to the native receiver.
    await clockBrowser(base + 2001);
    const rejected = 65;
    const future = await page.evaluate(async ({ topic, count }) => {
      let last;
      for (let index = 0; index < count; index++) last = await window.tendril.signals.send(topic, 'outside-tolerance', { ttlMs: 10_000 });
      return { issuedAtMs: last.issuedAtMs, completedLocalSends: count };
    }, { topic: TOPIC, count: rejected });
    assert.equal(future.issuedAtMs, base + 2001);
    assert.equal(future.completedLocalSends, rejected);
    await expect.poll(async () => counts(await snapshot()).clockSkew - baseline.clockSkew, { timeout: 10_000 }).toBe(rejected);
    // Move only the receiver ahead: the sender still creates a valid, signed
    // positive-TTL frame, already expired at the receiving clock.
    await clockNative(lastClock);
    await send('already-expired', base + 2002, 1000);
    await expect.poll(async () => counts(await snapshot()).expired - baseline.expired).toBe(1);
    await send('valid-after-rejections', lastClock);
    await expect.poll(async () => (await snapshot()).observed.map(item => item.label))
      .toEqual(['inside-tolerance', 'at-tolerance', 'valid-after-rejections']);
    checked = await snapshot();
    const after = counts(checked);
    assert.equal(after.total - baseline.total, rejected + 1);
    assert.equal(after.unauthorized, baseline.unauthorized); assert.equal(after.duplicate, baseline.duplicate);
    assert.equal(after.capacity, baseline.capacity);
    assert.equal(checked.aborted, false);
    assert.equal(checked.transport.connectionRevision, before.transport.connectionRevision);
    assert.deepEqual(checked.revisions, before.revisions, 'Freshness rejects must not replace the healthy peer connection.');
  } catch (error) {
    qualificationFailure = { error };
    throw error;
  } finally {
    // Join both restorations even when one rejects or throws synchronously.
    const restored = await Promise.allSettled([
      Promise.resolve().then(() => clockNative(null)),
      Promise.resolve().then(() => browserClock(page, null, true)),
    ]);
    // Give the channel's documented monotone time guard time to catch up before
    // later independent scenarios, including after an assertion failure.
    const remaining = lastClock - Date.now();
    if (remaining > 0) await delay(Math.min(remaining + 5, 5000));
    const failures = restored.flatMap((result, index) => result.status === 'rejected'
      ? [{ clock: index === 0 ? 'native' : 'browser', error: result.reason }] : []);
    if (failures.length) {
      const errors = failures.map(failure => failure.error);
      const primary = qualificationFailure ? qualificationFailure.error : errors[0];
      const describe = error => error?.message ?? String(error);
      const detail = failures.map(failure => failure.clock + ': ' + describe(failure.error)).join('; ');
      const combined = new AggregateError(qualificationFailure ? [primary, ...errors] : errors,
        (qualificationFailure ? describe(primary) + '; ' : '') + 'Signal clock restoration failed: ' + detail,
        { cause: primary });
      if (primary?.code !== undefined) combined.code = primary.code;
      throw combined;
    }
  }
  await page.evaluate(async topic => {
    window.__firstAppSignalReply = { stop: new AbortController(), value: null, error: null };
    const state = window.__firstAppSignalReply;
    void (async () => {
      for await (const signal of window.tendril.signals.subscribe({ topics: [topic], mode: 'all', signal: state.stop.signal })) state.value = signal.payload;
    })().catch(error => { if (!state.stop.signal.aborted) state.error = error.code || error.name; });
  }, TOPIC + '-reply');
  try {
    await peer.request('signal-qualification-send', { label: 'native-reply-after-rejections' });
    await expect.poll(() => page.evaluate(() => window.__firstAppSignalReply.value)).toBe('native-reply-after-rejections');
    assert.equal(await page.evaluate(() => window.__firstAppSignalReply.error), null);
  } finally {
    await page.evaluate(() => { window.__firstAppSignalReply?.stop.abort(); delete window.__firstAppSignalReply; });
  }
  const browserText = 'Browser durable command after rejected signals';
  await page.locator('#note').fill(browserText); await page.locator('#submit').click();
  await expect(page.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
  await expect.poll(async () => (await peer.request('query')).value.some(note => note.text === browserText), { timeout: 30_000 }).toBe(true);
  const nativeText = 'Native durable command after rejected signals';
  const durable = await peer.request('command', { text: nativeText, operationId: 'first-app-signal-freshness-native' });
  assert.equal(durable.outcome, 'accepted');
  await expect(page.locator('#notes')).toContainText(nativeText, { timeout: 30_000 });
  const final = await snapshot(), wireAfter = await transportCounters();
  assert.equal(final.transport.connectionRevision, before.transport.connectionRevision);
  assert.deepEqual(final.revisions, before.revisions); assert.equal(final.aborted, false);
  assert.equal(wireAfter.instance, wireBefore.instance);
  if (transport === 'direct') assert.equal(wireAfter.relayBinaryBytes - wireBefore.relayBinaryBytes, 0);
  return { status: 'passed', futureToleranceMs: 2000, acceptedAheadMs: [1999, 2000], rejectedAheadMs: 2001,
    clockSkewRejections: counts(checked).clockSkew - baseline.clockSkew,
    expiredRejections: counts(checked).expired - baseline.expired,
    deliveredBrowserSignals: checked.observed.map(item => item.label), fixedDiagnosticFields: COUNTERS,
    connectionRevision: final.transport.connectionRevision, connectionReplaced: false,
    nativeSignalAfterRejections: true, durableReplicationBothDirections: true,
    limits: ['Real local Chromium/native connection; not physical-device clock or Internet qualification.',
      'Clock control is injected only into this private test application and native fixture; product artifacts and default limits are unchanged.'] };
}
