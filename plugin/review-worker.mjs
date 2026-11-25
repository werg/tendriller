// Browser-owned application Worker for the signed review page. Identity, keys and storage stay in this profile.
import { createApplicationSession } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { participateApplication } from '@tendriller/core/participation';
import { browserProfileId } from './support/browser-profile.mjs';
import { bootstrapBrowser } from './support/browser-bootstrap.mjs';
import { definition } from './review-domain.mjs';
serveBrowserOwner({ async load({ signal }) {
  const response = await fetch(new URL('./configuration.json', import.meta.url), { signal });
  if (!response.ok) throw Error('Application configuration is unavailable');
  const configuration = await response.json(), profileId = browserProfileId(configuration.applicationId);
  return { profileId,
    async createIdentity() { const device = await openBrowserDevice({ name: profileId, create: true }); try { return device.identity.publicKey; } finally { await device.close(); } },
    async openSession({ signal, openDirectConnection }) {
      // create:true initializes an empty profile only; a retained signer or binding mismatch fails closed.
      const device = await openBrowserDevice({ name: profileId, create: true });
      let session, participation;
      try {
        const { authority, peers } = await bootstrapBrowser({ configuration, device, signal });
        session = await createApplicationSession({ device, definition, authority });
        participation = participateApplication(session, { peers, openDirectConnection });
        Object.defineProperty(session, 'participation', { value: participation });
        return { session, async close() { await participation.close(); } };
      } catch (error) { if (session) await session.close(); else await device.close(); throw error; }
    },
  };
} });
