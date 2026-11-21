import { verifyAuthorityBundle } from '@chronolog/peer-session';
import { openBrowserDevice, openBrowserApplication, serveApplicationWorker } from '@chronolog/peer-session/worker';
import { openWorkerWebRtcConnection } from '@chronolog/peer-session/webrtc';
import { createPeersClient } from '@tendriller/core/peers';
import { participateApplication } from '@tendriller/core/collaboration/participation';
import { definition } from './domain.mjs';

let opening = false;
self.addEventListener('message', async ({ data }) => {
  if (!['tutorial-create', 'tutorial-connect'].includes(data?.type) || opening) return;
  opening = true;
  let device, session;
  try {
    const configuration = await fetch(new URL('./configuration.json', import.meta.url)).then(response => {
      if (!response.ok) throw Error('Application configuration is unavailable.');
      return response.json();
    });
    if (new URL(configuration.page_url).origin !== self.location.origin) {
      throw Error('This is a layout preview. Enroll and connect from the published page at its own host origin.');
    }
    const name = `tendriller-kitchen-${configuration.applicationId}`;
    device = await openBrowserDevice({ name, ...(data.type === 'tutorial-create' ? { create: true } : {}) });
    const publicKey = device.identity.publicKey;
    if (data.type === 'tutorial-create') {
      await device.close();
      self.postMessage({ type: 'tutorial-identity', publicKey });
      return;
    }
    const base = new URL('_tendril/', configuration.page_url);
    const peers = createPeersClient({ base: base.href, applicationId: configuration.applicationId,
      async request(path, { method = 'GET', body, signal } = {}) {
        const response = await fetch(new URL(path, base), { method, signal, credentials: 'same-origin', cache: 'no-store',
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        const value = await response.json();
        if (!response.ok) throw Object.assign(Error(value.error?.message || `Host request failed (${response.status})`), {
          code: value.error?.code, status: response.status });
        return value;
      },
    });
    const authority = await peers.application();
    const verified = await verifyAuthorityBundle(authority, configuration.descriptor);
    if (!verified.grant(publicKey)?.reader) {
      throw Error(`This browser is not enrolled. Verify this public key with the owner and run npm run enroll -- ${publicKey}`);
    }
    // No plaintext epoch key or agent credential comes from page code. A current
    // reader supplies keys over the session's authenticated encrypted peer link.
    session = await openBrowserApplication({ device, definition, authority });
    const control = session.connectControlParticipant({ exchange: (message, options) => peers.exchange(message, options) });
    await participateApplication(session, { peers, control,
      openDirectConnection: options => openWorkerWebRtcConnection(self, options),
    });
    serveApplicationWorker(session, self, { host: control });
    self.postMessage({ type: 'tutorial-opened', publicKey });
  } catch (error) {
    try { if (session) await session.close(); else await device?.close(); } catch { /* Preserve the opening failure. */ }
    self.postMessage({ type: 'tutorial-failure', message: `${error.code ?? error.name}: ${error.message}` });
  }
});
