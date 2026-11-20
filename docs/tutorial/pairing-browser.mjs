import { createDevicePairingClient, validateDevicePairingChallenge } from '@tendriller/core/pairing';

// One public intent per retained device, shared across tabs. No private device
// key, host token or OAuth credential is stored in page storage or messages.
export function createBrowserPairing({ configuration, storage = localStorage, locks = navigator.locks,
  workerUrl = new URL('./pairing-worker.mjs', import.meta.url), WorkerClass = Worker }) {
  const key = `tendriller-notes-${configuration.applicationId}:pairing`;
  const endpoint = new URL('_tendril/peers/pairing', configuration.page_url);
  const client = createDevicePairingClient({ url: endpoint });
  function retained() {
    const text = storage.getItem(key);
    if (text === null) return null;
    const value = JSON.parse(text);
    if (value.applicationId !== configuration.applicationId || value.pageOrigin !== endpoint.origin ||
      typeof value.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(value.publicKey))
      throw Error('The retained pairing request is invalid. Preserve this device and inspect its setup.');
    return value;
  }
  function validate(status, intent) {
    const c = validateDevicePairingChallenge(status.challenge);
    const review = new URL(status.reviewUrl);
    if (status.pairingId !== c.pairingId || c.requestId !== intent.requestId || c.publicKey !== intent.publicKey ||
      c.applicationId !== configuration.applicationId || c.serviceOrigin !== configuration.serviceOrigin ||
      c.pageOrigin !== endpoint.origin || !c.rights.reader || !c.rights.writer ||
      review.origin !== configuration.serviceOrigin || review.username || review.password || review.search || review.hash ||
      !review.pathname.endsWith('/' + c.pairingId) || !review.pathname.startsWith('/pairings/'))
      throw Error('The pairing result does not match this retained device, application and service.');
    return status;
  }
  async function prove(intent) {
    const status = await new Promise((resolve, reject) => {
      const worker = new WorkerClass(workerUrl, { type: 'module' });
      const done = (error, value) => { clearTimeout(timer); worker.terminate(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => done(Error('Pairing reply unavailable. Resume this same request to inspect its result.')), 30_000);
      worker.onerror = () => done(Error('The pairing owner could not open. Close any connected view before resuming this request.'));
      worker.onmessage = ({ data }) => data?.ok ? done(null, data.status)
        : done(Object.assign(Error(data?.message || 'Pairing failed; keep this request.'), { code: data?.code }));
      worker.postMessage({ action: 'prove', requestId: intent.requestId, publicKey: intent.publicKey });
    });
    validate(status, intent);
    // An uncertain write leaves the original request ID intact. Challenge retry
    // recovers its server record even when the first reply was never saved.
    const current = retained();
    if (current.requestId !== intent.requestId) throw Error('Another view changed this pairing intent; reload its current state.');
    storage.setItem(key, JSON.stringify({ ...intent, pairingId: status.pairingId }));
    return status;
  }
  return {
    retained,
    async prepare(publicKey, { renew = false } = {}) {
      if (!locks?.request) throw Error('This browser needs exclusive device locks to pair safely.');
      return locks.request(key, async () => {
        let intent = retained();
        if (intent && intent.publicKey !== publicKey) throw Error('Resume the original browser device; do not replace its pairing key.');
        if (renew && intent) {
          if (!intent.pairingId) throw Error('Inspect the original request before asking for a new review.');
          const status = validate(await client.inspect(intent.pairingId, { signal: AbortSignal.timeout(15_000) }), intent);
          if (!['expired', 'stale', 'denied'].includes(status.state)) throw Error('This pairing is still active or committed. Resume it without a new request.');
        }
        if (!intent || renew) {
          intent = { applicationId: configuration.applicationId, pageOrigin: endpoint.origin,
            requestId: crypto.randomUUID(), publicKey };
          storage.setItem(key, JSON.stringify(intent));
          if (JSON.stringify(retained()) !== JSON.stringify(intent)) throw Error('The pairing intent was not retained. No request was sent.');
        }
        return prove(intent);
      });
    },
    async inspect() {
      const intent = retained();
      if (!intent) return null;
      return intent.pairingId ? validate(await client.inspect(intent.pairingId, { signal: AbortSignal.timeout(15_000) }), intent)
        : this.prepare(intent.publicKey);
    },
  };
}
