// Browser-owned application Worker for the signed review page. Identity, keys and storage stay in this profile.
import { createApplicationSession } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { participateApplication } from '@tendriller/core/participation';
import { browserProfileId } from './support/browser-profile.mjs';
import { admitBrowserSession, bootstrapBrowser } from './support/browser-bootstrap.mjs';
import { hostedMcpExtensions } from './support/hosted-mcp.mjs';
import { composeOwnerExtensions } from '@tendriller/core/admission';
import { definition, imports, topics } from './review-domain.mjs';

serveBrowserOwner({
  async load({ signal }) {
    const response = await fetch(new URL('./configuration.json', import.meta.url), { signal });
    if (!response.ok) throw Error('Application configuration is unavailable');
    const configuration = await response.json(), profileId = browserProfileId(configuration.applicationId);
    return {
      profileId,
      async createIdentity() {
        const device = await openBrowserDevice({ name: profileId, create: true });
        try { return device.identity.publicKey; } finally { await device.close(); }
      },
      async openSession({ signal, openDirectConnection }) {
        const device = await openBrowserDevice({ name: profileId, create: true });
        let session, participation, admission;
        try {
          const opened = await bootstrapBrowser({ configuration, device, imports, topics, signal });
          session = await createApplicationSession({
            device,
            definition,
            genesis: opened.genesisBytes,
            casNodes: opened.casNodes,
            publicOps: opened.publicOps,
            ...(opened.epoch0Key ? { epochKeys: new Map([[0, opened.epoch0Key]]) } : {}),
          });
          admission = admitBrowserSession(session, { peers: opened.peers, wrapKey: opened.wrapKey });
          participation = participateApplication(session, { peers: opened.peers, openDirectConnection, onNotification: () => void admission.refresh() });
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
