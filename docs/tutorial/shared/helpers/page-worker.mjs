// Shared browser Worker composition helper for Chronolog v2 Tendriller pages.
// Collapses the ~70 lines of QuickJS/SQLite WASM loading, local-first bootstrap,
// first-browser $publications adoption, admission, participation, blind mailbox sync,
// and hosted MCP sealing into one maintained 3-line entry per page.
import quickJsWasmUrl from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import { createApplicationSession } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { participateApplication } from '@tendriller/core/participation';
import { composeOwnerExtensions } from '@tendriller/core/admission';
import { browserProfileId } from './browser-profile.mjs';
import { admitBrowserSession, bootstrapBrowser, finalizeFirstBrowserGenesis } from './browser-bootstrap.mjs';
import { hostedMcpExtensions } from './hosted-mcp.mjs';

const compileWasm = async url => {
  const res = await fetch(new URL(url, self.location.href));
  if (!res.ok) throw Error(`Failed to load WASM (${res.status})`);
  return WebAssembly.compile(await res.arrayBuffer());
};

const quickJsWasmPromise = compileWasm(quickJsWasmUrl);

/**
 * Start the page's dedicated Chronolog v2 browser owner Worker.
 * Pass `sqliteWasmUrl` (imported from `@chronolog/peer-session/sqlite-cas.wasm`) when the
 * page uses `chronolog/sql` or `chronolog:sqlite`.
 */
export function servePageWorker({
  definition,
  imports,
  topics,
  sqliteWasmUrl = null,
  configUrl = './configuration.json',
  extraExtensions,
} = {}) {
  const sqliteWasmPromise = sqliteWasmUrl ? compileWasm(sqliteWasmUrl) : Promise.resolve(undefined);

  return serveBrowserOwner({
    async load({ signal }) {
      const response = await fetch(new URL(configUrl, import.meta.url), { signal });
      if (!response.ok) throw Error('Application configuration is unavailable');
      const configuration = await response.json();
      const profileId = browserProfileId(configuration.applicationId);
      return {
        profileId,
        async createIdentity() {
          const device = await openBrowserDevice({ name: profileId, create: true });
          try { return device.identity.publicKey; } finally { await device.close(); }
        },
        async openSession({ signal: openSignal, openDirectConnection }) {
          const device = await openBrowserDevice({ name: profileId, create: true });
          let session, participation, admission;
          try {
            const [opened, wasmModule, sqliteWasmModule] = await Promise.all([
              bootstrapBrowser({ configuration, device, imports, topics, signal: openSignal }),
              quickJsWasmPromise,
              sqliteWasmPromise,
            ]);
            const epochKeys = opened.epoch0Key ? new Map([[0, opened.epoch0Key]]) : undefined;
            session = await createApplicationSession({
              device,
              applicationId: configuration.applicationId,
              genesis: opened.genesisBytes,
              casNodes: opened.casNodes,
              wasmModule,
              ...(sqliteWasmModule ? { sqliteWasmModule } : {}),
              ...(epochKeys ? { epochKeys } : {}),
              ...(definition ? { definition } : {}),
            });
            if (opened.publicOps.length > 0) {
              await session.mergeFacts({
                publicOps: opened.publicOps,
                encryptedEnvelopes: [],
                casNodes: opened.casNodes,
                retentions: [],
                checkpoints: [],
              });
            }
            await finalizeFirstBrowserGenesis({ session, opened });
            admission = admitBrowserSession(session, { peers: opened.peers, wrapKey: opened.wrapKey });
            participation = participateApplication(session, {
              peers: opened.peers,
              openDirectConnection,
              onNotification: () => void admission.refresh(),
            });
            Object.defineProperty(session, 'participation', { value: participation });
            const custom = typeof extraExtensions === 'function' ? extraExtensions({ session, admission, opened }) : [];
            const extList = [admission.extensions, hostedMcpExtensions({ session, admission }), ...(Array.isArray(custom) ? custom : custom ? [custom] : [])];
            return {
              session,
              extensions: composeOwnerExtensions(...extList),
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
}
