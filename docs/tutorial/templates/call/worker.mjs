import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { admitBrowserSession, bootstrapBrowser } from '../../shared/helpers/browser-bootstrap.mjs';
import { hostedMcpExtensions } from '../../shared/helpers/hosted-mcp.mjs';
import { composeOwnerExtensions } from '@tendriller/core/admission';
import { createApplicationSession } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { participateApplication } from '@tendriller/core/participation';
import { definition } from './domain.mjs';

serveBrowserOwner({
  async load({ signal }) {
    const response = await fetch(new URL('./configuration.json', import.meta.url), { signal });
    if (!response.ok) throw Error('Application configuration is unavailable');
    const configuration = await response.json();
    const profileId = browserProfileId(configuration.applicationId);
    return {
      profileId,
      async createIdentity() {
        const device = await openBrowserDevice({ name: profileId, create: true });
        try { return device.identity.publicKey; }
        finally { await device.close(); }
      },
      async openSession({ signal, openDirectConnection }) {
        const device = await openBrowserDevice({ name: profileId, create: true });
        let session, participation, admission;
        try {
          const { authority, peers, wrapKey } = await bootstrapBrowser({ configuration, device, signal });
          session = await createApplicationSession({ device, definition, authority });
          admission = admitBrowserSession(session, { peers, wrapKey });
          participation = participateApplication(session, { peers, openDirectConnection, onNotification: () => void admission.refresh() });
          Object.defineProperty(session, 'participation', { value: participation });
          return {
            session,
            extensions: composeOwnerExtensions(admission.extensions, hostedMcpExtensions({ session, admission })),
            async close() { admission.close(); await participation.close(); },
          };
        } catch (error) {
          admission?.close();
          if (session) await session.close(); else await device.close();
          throw error;
        }
      },
    };
  },
});
