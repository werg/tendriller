import quickJsWasmUrl from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { admitBrowserSession, bootstrapBrowser } from '../../shared/helpers/browser-bootstrap.mjs';
import { hostedMcpExtensions } from '../../shared/helpers/hosted-mcp.mjs';
import { composeOwnerExtensions } from '@tendriller/core/admission';
import { createApplicationSession } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { participateApplication } from '@tendriller/core/participation';
import { definition, imports, topics } from './domain.mjs';

const quickJsWasmPromise = (async () => {
  const res = await fetch(new URL(quickJsWasmUrl, self.location.href));
  if (!res.ok) throw Error(`Failed to load QuickJS WASM (${res.status})`);
  return WebAssembly.compile(await res.arrayBuffer());
})();

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
        try { return device.identity.publicKey; } finally { await device.close(); }
      },
      async openSession({ signal, openDirectConnection }) {
        const device = await openBrowserDevice({ name: profileId, create: true });
        let session, participation, admission;
        try {
          const [opened, wasmModule] = await Promise.all([
            bootstrapBrowser({ configuration, device, imports, topics, signal }),
            quickJsWasmPromise,
          ]);
          const epochKeys = opened.epoch0Key ? new Map([[0, opened.epoch0Key]]) : undefined;
          session = await createApplicationSession({
            device,
            genesis: opened.genesisBytes,
            casNodes: opened.casNodes,
            wasmModule,
            ...(epochKeys ? { epochKeys } : {}),
            definition,
          });
          if (opened.publicOps.length > 0) {
            await session.mergeFacts({ publicOps: opened.publicOps, encryptedEnvelopes: [], casNodes: opened.casNodes, retentions: [], checkpoints: [] });
          }
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
