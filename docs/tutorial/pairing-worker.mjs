import { browserProfileId } from './helpers/browser-profile.mjs';
// Only this fenced Worker opens the browser signer for a pairing proof.
import { openBrowserDevice, acquireApplicationOwnerLock } from '@chronolog/peer-session/worker';
import { createDevicePairingClient, signDevicePairingChallenge } from '@tendriller/core/pairing';
import { checkBrowserPairing } from './pairing-browser.mjs';

let handling = false;
self.addEventListener('message', async ({ data }) => {
  if (handling || data?.protocol !== 'tendriller-tutorial-pairing-v1') return;
  handling = true;
  let device, lock, status, failure;
  try {
    const signal = AbortSignal.timeout(30000);
    const response = await fetch(new URL('./configuration.json', import.meta.url), { signal, cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw Error('The signed application configuration is unavailable.');
    const configuration = await response.json(), profileId = browserProfileId(configuration.applicationId);
    if (data.profileId !== profileId) throw Object.assign(new Error('The page and pairing Worker must use browserProfileId(configuration.applicationId) from the same helper. Keep the existing browser profile when changing application labels.'), { code: 'PAIRING_PROFILE_MISMATCH' });
    if (typeof data.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(data.requestId))
      throw Object.assign(new Error('Resume the saved browser pairing request.'), { code: 'PAIRING_REQUEST_INVALID' });
    if (new URL(configuration.page_url).origin !== self.location.origin)
      throw Object.assign(new Error('Open the published page at its own Tendriller address. Keep configuration.page_url from that page handle; do not substitute the service origin.'), { code: 'PAIRING_PAGE_ORIGIN_MISMATCH' });
    // Wait for the profile's owner fence instead of failing while another tab's
    // attempt briefly holds it; the signal still bounds the whole request.
    lock = await acquireApplicationOwnerLock(profileId, { wait: true, signal });
    device = await openBrowserDevice({ name: profileId, create: data.publicKey === undefined });
    if (data.publicKey && data.publicKey !== device.identity.publicKey) throw Error('The retained browser key changed. Preserve this request and recover the original profile.');
    const client = createDevicePairingClient({ url: new URL('_tendril/peers/pairing', configuration.page_url) });
    const retained = { requestId: data.requestId, publicKey: device.identity.publicKey };
    status = checkBrowserPairing(await client.challenge({ requestId: data.requestId, publicKey: device.identity.publicKey,
      rights: { reader: true, writer: true } }, { signal }), configuration, retained);
    retained.challenge = status.challenge;
    if (status.state === 'challenge') {
      const signature = await signDevicePairingChallenge(status.challenge, device.identity);
      status = checkBrowserPairing(await client.prove(status.pairingId, signature, { signal }), configuration, retained);
    }
  } catch (error) { failure = { code: error.code || error.name, message: error.message || 'Pairing could not be completed. Resume the retained request.' }; }
  finally {
    try { await device?.close(); } catch { failure ??= { code: 'PAIRING_DEVICE_CLOSE', message: 'The browser device did not close cleanly. Preserve this profile and request.' }; }
    try { await lock?.close(); } catch { failure ??= { code: 'PAIRING_LOCK_CLOSE', message: 'The browser owner fence did not release. Retry this same profile after it closes.' }; }
    // The page terminates this Worker only after all owned resources released.
    self.postMessage({ protocol: 'tendriller-tutorial-pairing-v1', id: data.id, ...(failure ? { error: failure } : { status }) });
  }
});
