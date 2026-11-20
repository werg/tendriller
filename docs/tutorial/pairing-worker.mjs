// A short-lived, fenced device owner signs the account-bound challenge. The page
// receives public status only; the signing key stays in retained Worker storage.
import { acquireApplicationOwnerLock, openBrowserDevice } from '@chronolog/peer-session/worker';
import { createDevicePairingClient, signDevicePairingChallenge } from '@tendriller/core/pairing';

self.onmessage = async ({ data }) => {
  self.onmessage = null;
  let lock, device, reply;
  try {
    if (data?.action !== 'prove' || typeof data.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(data.publicKey))
      throw Error('A retained public pairing request is required.');
    const signal = AbortSignal.timeout(25_000);
    const response = await fetch(new URL('./configuration.json', import.meta.url), { signal, cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw Error('Application configuration is unavailable.');
    const configuration = await response.json();
    if (new URL(configuration.page_url).origin !== self.location.origin)
      throw Error('Pair this device from its own signed application page.');
    lock = await acquireApplicationOwnerLock(`tendriller-notes-${configuration.applicationId}`, { signal });
    device = await openBrowserDevice({ name: lock.profileId });
    if (device.identity.publicKey !== data.publicKey) throw Error('Reopen the retained browser device for this pairing request.');
    const client = createDevicePairingClient({ url: new URL('_tendril/peers/pairing', configuration.page_url) });
    let status = await client.challenge({ requestId: data.requestId, publicKey: data.publicKey,
      rights: { reader: true, writer: true } }, { signal });
    if (status.challenge.applicationId !== configuration.applicationId || status.challenge.serviceOrigin !== configuration.serviceOrigin)
      throw Error('The pairing challenge belongs to another service or application.');
    if (status.state === 'challenge') {
      const signature = await signDevicePairingChallenge(status.challenge, device.identity);
      status = await client.prove(status.pairingId, signature, { signal });
    }
    reply = { ok: true, status };
  } catch (error) {
    reply = { ok: false, code: error.code || error.name, message: error.message };
  } finally {
    try { try { await device?.close(); } finally { await lock?.close(); } }
    catch { reply = { ok: false, code: 'pairing_cleanup_failed', message: 'The pairing owner could not close cleanly. Preserve this device and inspect the same request after reloading.' }; }
  }
  self.postMessage(reply);
};
