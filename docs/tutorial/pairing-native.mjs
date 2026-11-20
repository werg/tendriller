// Browser enrollment on the existing native owner, open while it runs. It never
// opens a second signing store or replaces a retained transition after an uncertain send.
import { peerDigest, verifyAuthorityBundle, signTransitionRequest } from '@chronolog/peer-session';
import { createDevicePairingClient } from '@tendriller/core/pairing';
import { readPrivate, savePrivate } from './local.mjs';

const PREFIX = 'pairing:';
const pauseId = id => PREFIX + id;
const saved = (id, kind) => `pairing-${id}-${kind}.json`;
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Pure identity checks used before a host result can influence retained state. */
export function assertPairingContext(status, { applicationId, serviceOrigin, pageOrigin }, pairingId) {
  const c = status?.challenge;
  if (!c || !/^[a-f0-9]{64}$/.test(status.pairingId) || status.pairingId !== c.pairingId ||
      pairingId && status.pairingId !== pairingId || c.applicationId !== applicationId ||
      c.serviceOrigin !== serviceOrigin || c.pageOrigin !== pageOrigin || status.requestId !== c.requestId ||
      status.expiresAt !== c.expiresAt || !Number.isSafeInteger(c.expiresAt) ||
      c.rights?.reader !== true || typeof c.rights.writer !== 'boolean')
    throw fail('PAIRING_CONTEXT_MISMATCH', 'The pairing response does not belong to this exact retained application and service.');
  const review = new URL(status.reviewUrl);
  if (review.origin !== serviceOrigin || review.username || review.password || review.search || review.hash ||
      !new RegExp(`^/pairings/[a-z2-7]{12}/${status.pairingId}$`).test(review.pathname))
    throw fail('PAIRING_CONTEXT_MISMATCH', 'The pairing review must stay on this service origin.');
  return status;
}

/** One tick is exported for deterministic lifecycle tests; callers use the
 * bounded window below. The actual signed-control selector remains the host. */
export async function advancePairing({ session, pairing, retain = savePrivate, restore = readPrivate, onStatus = () => {}, signal }) {
  signal?.throwIfAborted();
  const persist = async (name, value) => {
    await retain(name, value);
    const checked = await restore(name, true);
    if (!checked || await peerDigest(checked) !== await peerDigest(value))
      throw fail('PAIRING_STORAGE_REQUIRED', 'The exact pairing record was not durably retained. No new transition may be sent.');
    return checked;
  };
  if (typeof session.pauseOrdering !== 'function' || typeof session.orderingPause !== 'function' || typeof session.resumeOrdering !== 'function')
    throw fail('PAIRING_ORDERING_PAUSE_REQUIRED', 'Install the qualified Chronolog package with durable ordering pauses before enabling reviewed pairing.');
  let pause = await session.orderingPause(), result;
  if (pause && !/^pairing:[a-f0-9]{64}$/.test(pause.operationId))
    throw fail('PAIRING_OTHER_PAUSE', 'Another retained operation holds ordering. Resolve that original operation before device pairing.');
  if (pause) result = await pairing.client.inspect(pause.operationId.slice(PREFIX.length), { signal });
  else {
    const available = await pairing.client.pending({ signal });
    if (!Array.isArray(available?.pairings) || available.pairings.length > 20) throw fail('PAIRING_INVALID_RESPONSE', 'Expected a bounded pending pairing list.');
    result = available.pairings.find(value => ['pending', 'approved', 'committing'].includes(value.state));
    if (!result) return null;
  }
  const id = result.pairingId;
  assertPairingContext(result, pairing, pause?.operationId.slice(PREFIX.length));
  const authority = await pairing.authority({ signal }), verified = await verifyAuthorityBundle(authority, pairing.descriptor);
  const original = await restore(saved(id, 'prepared'), true);
  const transition = verified.bundle.generations.find(generation => generation.payload.transition.payload.transitionId === `pair-${id}`);
  // Resolve the original receipt before judging the newer selected generation.
  // Later revocation never triggers another admission of this key.
  if (transition) {
    if (!['committed', 'revoked'].includes(result.state))
      throw fail('PAIRING_OUTCOME_UNCERTAIN', 'The host has not verified this exact reviewed control/account outcome. Preserve the pause and original transition.');
    const prepared = original ?? result.prepared;
    if (!prepared || await peerDigest(transition.payload.transition) !== await peerDigest(prepared.request) ||
        !result.generation || await peerDigest(result.generation) !== await peerDigest(transition))
      throw fail('PAIRING_OUTCOME_UNCERTAIN', 'The original pairing receipt does not match the retained signed attempt. Keep ordering paused for reconciliation.');
    const control = verified.bundle.controls[transition.payload.controlRevision]?.payload;
    const expected = prepared.control;
    const order = grants => [...grants].sort((a, b) => a.publicKey.localeCompare(b.publicKey));
    if (!control || control.epoch !== expected.epoch || control.keyDigest !== expected.keyDigest ||
        await peerDigest(control.recoveryFloor) !== await peerDigest(expected.recoveryFloor) ||
        await peerDigest(order(control.grants)) !== await peerDigest(order(expected.grants)))
      throw fail('PAIRING_OUTCOME_UNCERTAIN', 'The receipt does not prove the exact reviewed grant set. Preserve the original transition.');
    await session.adopt(authority);
    await persist(saved(id, 'outcome'), { pairingId: id, generation: transition });
    if (pause) await session.resumeOrdering(pause.operationId);
    onStatus({ pairingId: id, state: result.state, nextAction: result.nextAction });
    return result;
  }
  if (result.generation || ['committed', 'reconciliation_required'].includes(result.state))
    throw fail('PAIRING_OUTCOME_UNCERTAIN', 'The host outcome is not present in verified authority. Preserve the pause and original request.');
  if (['denied', 'expired', 'stale'].includes(result.state)) {
    // A fresh terminal lifecycle result plus a verified absent original
    // transition prevents a late admission under this old approval.
    if (pause) {
      await session.adopt(authority);
      await session.resumeOrdering(pause.operationId);
    }
    onStatus({ pairingId: id, state: result.state, nextAction: result.nextAction });
    return result;
  }
  if (result.state === 'revoked') throw fail('PAIRING_ACCOUNT_REVOKED', 'This request lost account access. Keep its pause until a terminal review or exact outcome is reconciled.');
  if (!pause && original)
    throw fail('PAIRING_PAUSE_MISSING', 'A prepared transition exists without its durable ordering pause. Preserve the original project for reconciliation; do not prepare or send another transition.');
  const c = result.challenge, current = verified.current;
  if (!current || current.id !== c.expectedGeneration || verified.control.payload.revision !== c.controlRevision ||
      current.payload.coordinator !== session.deviceId || !verified.grant(session.deviceId)?.administrator)
    throw fail('PAIRING_AUTHORITY_CHANGED', 'Only the retained current coordinator and administrator may prepare this exact pairing. Do not select an older prefix.');
  if (verified.grant(c.publicKey)) throw fail('PAIRING_DEVICE_KNOWN', 'Inspect the existing device grant; pairing cannot replace or restore it.');
  await persist(saved(id, 'intent'), { pairingId: id, serviceOrigin: pairing.serviceOrigin,
    applicationId: pairing.applicationId, challenge: c });
  pause ??= await session.pauseOrdering(pauseId(id));
  if (pause.operationId !== pauseId(id) || pause.generation !== current.id || pause.base?.point.generation !== current.id)
    throw fail('PAIRING_PAUSE_MISMATCH', 'The retained ordering pause belongs to another generation or proposal. Preserve it for inspection.');
  let prepared = original;
  if (!prepared) {
    const before = verified.control.payload;
    const control = { epoch: before.epoch, keyDigest: before.keyDigest, grants: [...before.grants,
      { publicKey: c.publicKey, reader: true, writer: c.rights.writer, coordinator: false, recovery: false,
        administrator: false, publisher: false, dataRole: 'member' }], recoveryFloor: before.recoveryFloor,
      accounts: [{ publicKey: c.publicKey, accountId: c.accountId }] };
    const request = await pairing.signTransition({ applicationId: c.applicationId, profile: pairing.descriptor.payload.profile,
      policy: pairing.descriptor.payload.policy, transitionId: `pair-${id}`, expectedGeneration: c.expectedGeneration,
      coordinator: session.deviceId, requester: session.deviceId, controlRevision: c.controlRevision + 1,
      reason: 'control-change', base: pause.base });
    prepared = await persist(saved(id, 'prepared'), { request, control });
  }
  if (prepared.request?.payload.transitionId !== `pair-${id}` || prepared.request.payload.expectedGeneration !== pause.generation ||
      await peerDigest(prepared.request.payload.base) !== await peerDigest(pause.base) ||
      await peerDigest(await session.recoveryPoint()) !== await peerDigest(pause.base))
    throw fail('PAIRING_PREFIX_CHANGED', 'The exact reviewed history prefix changed. Preserve the proposal and obtain renewed review; never rebase it silently.');
  const digest = await peerDigest(prepared);
  if (result.prepared && await peerDigest(result.prepared) !== digest || result.preparedDigest && result.preparedDigest !== digest)
    throw fail('PAIRING_PROPOSAL_CHANGED', 'The host retained a different signed proposal. Keep the original local record.');
  if (!result.preparedDigest) {
    if (typeof pairing.client.prepare !== 'function') throw fail('PAIRING_PREPARE_REQUIRED', 'The selected host and SDK must support review of the exact prepared transition.');
    result = assertPairingContext(await pairing.client.prepare(id, prepared, { signal }), pairing, id);
    if (result.preparedDigest !== digest) throw fail('PAIRING_PROPOSAL_CHANGED', 'The host did not retain this exact prepared proposal.');
  }
  if (['approved', 'committing'].includes(result.state)) {
    // This local marker precedes any possibly lost HTTP send. The durable
    // Chronolog pause survives both process close and private-helper failure.
    await persist(saved(id, 'commit'), { pairingId: id, preparedDigest: digest, transitionId: prepared.request.payload.transitionId });
    result = assertPairingContext(await pairing.client.commit(id, prepared, { signal }), pairing, id);
    // Re-read and independently verify authority in the next tick before
    // releasing ordering, even when commit returned an apparent success.
  }
  onStatus({ pairingId: id, state: result.state, nextAction: result.nextAction,
    orderingPaused: true, expiresAt: result.expiresAt });
  return result;
}

/** Compatibility for the explicit `npm run pair` command and other native
 * consumers. All passes share one owner and serialize the exact same lifecycle. */
export function createReviewedPairingProcessor({ handle, host, descriptor, session, identity, store, client, pairing: supplied }) {
  const pairing = supplied ?? { applicationId: handle.application.id, serviceOrigin: new URL(handle.api).origin,
    pageOrigin: new URL(handle.page_url).origin, descriptor, authority: options => host.peers.application(options),
    signTransition: payload => signTransitionRequest(payload, identity),
    client: client ?? createDevicePairingClient({ url: handle.api + '/peers/pairing', headers: { Authorization: 'Bearer ' + handle.token } }),
  };
  let running;
  return options => {
    if (running) return running;
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...[options?.signal].filter(Boolean)]);
    running = advancePairing({ session, pairing, signal,
      ...(store ? { retain: (name, value) => store.save(name, value), restore: name => store.load(name) } : {}) })
      .then(result => result ? [{ pairingId: result.pairingId, state: result.state, publicKey: result.challenge.publicKey,
        nextAction: result.nextAction, expiresAt: result.expiresAt }] : []).finally(() => { running = undefined; });
    return running;
  };
}

const validDuration = value => value === Infinity || Number.isSafeInteger(value) && value >= 1;
function wakeableDelay(ms, signal, wakeups) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); wakeups.removeEventListener('pairing', done); resolve(); };
    const abort = () => { clearTimeout(timer); wakeups.removeEventListener('pairing', done); reject(signal.reason); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', abort, { once: true }); wakeups.addEventListener('pairing', done, { once: true });
  });
}

/** Checks pending pairings for as long as the participant runs (or a finite
 * `durationMs`). Idle checks back off; a host notice (`wakeups` dispatching
 * 'pairing', or `wake()`) checks immediately. Ending never releases a pause. */
export function startReviewedPairingLoop(process, { signal, report = () => {}, intervalMs = 2000,
  maxIdleMs = 30000, durationMs = Infinity, wakeups = new EventTarget() } = {}) {
  if (!validDuration(durationMs) || !Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 10000 ||
      !Number.isSafeInteger(maxIdleMs) || maxIdleMs < intervalMs || maxIdleMs > 30000 || typeof wakeups?.addEventListener !== 'function')
    throw fail('PAIRING_WINDOW_INVALID', 'Use a positive (or unbounded) pairing duration with bounded idle backoff.');
  const stopped = new AbortController(), lifetime = AbortSignal.any([stopped.signal,
    ...(durationMs === Infinity ? [] : [AbortSignal.timeout(durationMs)]), ...[signal].filter(Boolean)]);
  let woken = false;
  const wake = () => { woken = true; };
  wakeups.addEventListener('pairing', wake);
  const completion = (async () => {
    let delayMs = intervalMs;
    while (!lifetime.aborted) {
      woken = false;
      try {
        const results = await process({ signal: lifetime });
        for (const result of results) report({ pairing: result });
        delayMs = results.some(result => ['pending', 'approved', 'committing', 'committed'].includes(result.state))
          ? intervalMs : Math.min(maxIdleMs, delayMs * 2);
      } catch (error) {
        if (lifetime.aborted) break;
        report({ pairing: { state: 'inspection_unavailable', code: error.code || error.name, nextAction: error.message } });
        delayMs = Math.min(maxIdleMs, delayMs * 2);
      }
      // A notice that arrived during the pass is not lost: check again at once.
      if (woken) { delayMs = intervalMs; continue; }
      try { await wakeableDelay(delayMs, lifetime, wakeups); } catch { break; }
    }
    wakeups.removeEventListener('pairing', wake);
  })();
  return Object.freeze({ done: completion, wake() { wakeups.dispatchEvent(new Event('pairing')); },
    async close() { stopped.abort(); await completion; } });
}

/** Keeps enrollment open for the native participant's lifetime by default.
 * `owned.notices` (from openSession) wakes it as soon as a browser asks or the
 * owner approves. Closing never releases an uncertain ordering pause; the next
 * pass of the same owner reconciles the exact retained request. */
export function startPairingWindow({ owned, durationMs = Infinity, intervalMs = 2000, maxIdleMs = 30000, signal, onStatus = () => {} }) {
  if (!validDuration(durationMs) || !Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 10000)
    throw fail('PAIRING_WINDOW_INVALID', 'Use a positive (or unbounded) pairing duration.');
  if (!owned?.session || !owned.pairing) throw fail('PAIRING_OWNER_REQUIRED', 'Use the existing retained native owner returned by openSession.');
  const process = owned.processPairings ?? createReviewedPairingProcessor({ session: owned.session, pairing: owned.pairing });
  const loop = startReviewedPairingLoop(process, { durationMs, intervalMs, maxIdleMs, ...(owned.notices ? { wakeups: owned.notices } : {}),
    signal: AbortSignal.any([owned.session.signal, ...[signal].filter(Boolean)]), report: ({ pairing }) => onStatus(pairing) });
  const done = (async () => {
    await loop.done;
    const pause = await owned.session.orderingPause().catch(() => undefined);
    onStatus({ state: 'window_closed', orderingPaused: Boolean(pause),
      nextAction: pause ? 'A reviewed or uncertain transition still holds ordering. Start this same native peer again; its first pass reconciles the original request.'
        : 'Enrollment stopped with this native peer. Start it again to accept browser requests.' });
  })();
  return Object.freeze({ done, wake: loop.wake, async close() { await loop.close(); await done; } });
}
