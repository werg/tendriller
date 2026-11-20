import { browserProfileId } from './helpers/browser-profile.mjs';
import { createDevicePairingClient, validateDevicePairingChallenge, pairingProofBytes } from '@tendriller/core/pairing';

const fail = (code, message) => Object.assign(new Error(message), { code });
const hex = /^[a-f0-9]{64}$/;
export function checkBrowserPairing(status, configuration, retained) {
  const c = validateDevicePairingChallenge(status?.challenge);
  if (status.pairingId !== c.pairingId || status.requestId !== c.requestId || status.expiresAt !== c.expiresAt ||
      c.applicationId !== configuration.applicationId || c.serviceOrigin !== configuration.serviceOrigin ||
      c.pageOrigin !== new URL(configuration.page_url).origin || c.requestId !== retained.requestId ||
      retained.publicKey && c.publicKey !== retained.publicKey || c.rights.reader !== true || c.rights.writer !== true)
    throw fail('PAIRING_SCOPE_MISMATCH', 'The request does not match this retained browser, application and selected service.');
  const review = new URL(status.reviewUrl);
  if (review.origin !== configuration.serviceOrigin || review.username || review.password || review.search || review.hash ||
      review.pathname !== `/pairings/${configuration.pageId}/${c.pairingId}`)
    throw fail('PAIRING_REVIEW_ORIGIN', 'Device review must open the exact authenticated service origin for this page.');
  if (retained.challenge && pairingProofBytes(retained.challenge).toString() !== pairingProofBytes(c).toString())
    throw fail('PAIRING_CHALLENGE_CHANGED', 'The retained challenge changed. Preserve this original request for inspection.');
  return status;
}

/** The public request ID is retained before the first Worker or host call.
 * Local browser keys stay in the owner Worker store, never in this record. */
export function createBrowserPairing({ configuration, profileId = browserProfileId(configuration.applicationId),
  workerUrl, storage = localStorage, locks = globalThis.navigator?.locks, WorkerClass = globalThis.Worker,
  createWorker = url => new WorkerClass(url, { type: 'module' }), fetch: transport = fetch }) {
  const key = `${profileId}:pairing-v1`;
  if (!workerUrl) throw fail('PAIRING_WORKER_REQUIRED', 'Provide the signed publication’s pairing Worker URL.');
  const endpoint = new URL('_tendril/peers/pairing', configuration.page_url);
  const client = createDevicePairingClient({ url: endpoint, fetch: transport });
  const read = () => {
    let value;
    try { value = JSON.parse(storage.getItem(key) || 'null'); } catch { throw fail('PAIRING_STORAGE_CORRUPT', 'Preserve this browser profile; the retained pairing reference cannot be read.'); }
    if (value !== null && (!value || value.version !== 1 || value.applicationId !== configuration.applicationId ||
        typeof value.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.requestId) ||
        value.pairingId !== undefined && !hex.test(value.pairingId) || value.publicKey !== undefined && !hex.test(value.publicKey)))
      throw fail('PAIRING_STORAGE_CORRUPT', 'The saved pairing reference does not match this application. Do not create a replacement identity.');
    return value;
  };
  const write = value => {
    const text = JSON.stringify(value);
    try { storage.setItem(key, text); if (storage.getItem(key) !== text) throw Error(); }
    catch { throw fail('PAIRING_STORAGE_REQUIRED', 'This browser must retain its request before contacting the host. Enable durable browser storage and retry.'); }
    return value;
  };
  async function requestLocked({ newReview = false, signal, publicKey } = {}) {
    let retained = read();
    if (publicKey !== undefined && (!hex.test(publicKey) || retained?.publicKey && retained.publicKey !== publicKey))
      throw fail('PAIRING_KEY_CHANGED', 'Resume the original browser device; do not replace its pairing key.');
    if (newReview) {
      if (!retained?.pairingId) throw fail('PAIRING_INSPECT_REQUIRED', 'Inspect or resume the original request before asking for another review.');
      const old = checkBrowserPairing(await client.inspect(retained.pairingId, { signal }), configuration, retained);
      if (!['expired', 'denied', 'stale'].includes(old.state))
        throw fail('PAIRING_STILL_PENDING', 'Resolve this original request first. A pending, uncertain or committed request cannot be replaced.');
      // Preserve the old public reference alongside the new one. The host also
      // retains its exact outcome; this never changes the browser signing key.
      const history = [...(retained.history ?? []), { requestId: retained.requestId, pairingId: retained.pairingId }];
      if (history.length > 20) throw fail('PAIRING_HISTORY_FULL', 'This browser has reached its bounded review history. Inspect its retained requests before proceeding.');
      retained = write({ version: 1, applicationId: configuration.applicationId, requestId: crypto.randomUUID(),
        ...(retained.publicKey ? { publicKey: retained.publicKey } : {}), history });
    }
    retained ??= write({ version: 1, applicationId: configuration.applicationId, requestId: crypto.randomUUID(),
      ...(publicKey ? { publicKey } : {}) });
    signal?.throwIfAborted();
    const worker = createWorker(workerUrl), id = crypto.randomUUID();
    let cleanup;
    try {
      const status = await new Promise((resolve, reject) => {
        const finish = (error, value) => { cleanup(); error ? reject(error) : resolve(value); };
        const message = ({ data }) => {
          if (data?.protocol !== 'tendriller-tutorial-pairing-v1' || data.id !== id) return;
          if (data.error) finish(fail(data.error.code || 'PAIRING_FAILED', data.error.message));
          else finish(null, data.status);
        };
        const error = () => finish(fail('PAIRING_WORKER_UNAVAILABLE', 'The device owner could not answer. Resume this same request and browser profile.'));
        const abort = () => finish(signal.reason);
        const timer = setTimeout(() => finish(fail('PAIRING_TIMEOUT', 'The pairing reply was not observed. Resume the same request; do not create a replacement key.')), 35000);
        cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', message); worker.removeEventListener('error', error); signal?.removeEventListener('abort', abort); };
        worker.addEventListener('message', message); worker.addEventListener('error', error); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        worker.postMessage({ protocol: 'tendriller-tutorial-pairing-v1', id, profileId, requestId: retained.requestId,
          ...(retained.publicKey ? { publicKey: retained.publicKey } : {}) });
      });
      checkBrowserPairing(status, configuration, retained);
      write({ ...retained, pairingId: status.pairingId, publicKey: status.challenge.publicKey, challenge: status.challenge });
      return status;
    } finally { cleanup?.(); worker.terminate(); }
  }
  async function request(options = {}) {
    if (!locks?.request) throw fail('PAIRING_LOCK_REQUIRED', 'This browser needs exclusive intent locks before starting or resuming pairing.');
    const signal = AbortSignal.any([AbortSignal.timeout(35000), ...[options.signal].filter(Boolean)]);
    return locks.request(key, { mode: 'exclusive', signal }, () => requestLocked({ ...options, signal }));
  }
  async function refresh({ signal } = {}) {
    const retained = read();
    if (!retained?.pairingId) throw fail('PAIRING_RESUME_REQUIRED', 'Resume this browser request to inspect its exact host identity.');
    return checkBrowserPairing(await client.inspect(retained.pairingId, { signal }), configuration, retained);
  }
  return Object.freeze({ read, retained: read, request, refresh,
    prepare: (publicKey, { renew = false, signal } = {}) => request({ publicKey, newReview: renew, signal }),
    async inspect(options) { const retained = read(); return !retained ? null : retained.pairingId ? refresh(options) : request(options); },
  });
}
