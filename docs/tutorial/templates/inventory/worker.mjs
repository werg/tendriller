import { createApplicationSession } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { participateApplication } from '@tendriller/core/participation';
import { browserProfileId } from '../../shared/helpers/browser-profile.mjs';
import { admitBrowserSession, bootstrapBrowser } from '../../shared/helpers/browser-bootstrap.mjs';
import { hostedMcpExtensions } from '../../shared/helpers/hosted-mcp.mjs';
import { composeOwnerExtensions } from '@tendriller/core/admission';
import { definition } from './domain.mjs';
serveBrowserOwner({ async load({ signal }) {
  const response = await fetch(new URL('./configuration.json', import.meta.url), { signal });
  if (!response.ok) throw Error('Application configuration is unavailable');
  const configuration = await response.json(), profileId = browserProfileId(configuration.applicationId);
  return { profileId,
    async createIdentity() { const device = await openBrowserDevice({ name: profileId, create: true }); try { return device.identity.publicKey; } finally { await device.close(); } },
    async openSession({ signal, openDirectConnection }) {
      const device = await openBrowserDevice({ name: profileId, create: true }); let session, pool, participation, admission;
      const release = async () => { const owned = pool; pool = undefined; await owned?.pauseVfs(); };
      try {
        const { authority, peers, wrapKey } = await bootstrapBrowser({ configuration, device, signal });
        session = await createApplicationSession({ device, definition, authority,
          async createMaterializer({ signal, rootPrincipal }) {
            // The optional SQL graph stays out of the page's eager imports.
            const [{ createBrowserSqlEngine, loadBrowserEngine }, { createSqlMaterializationRuntime }] = await Promise.all([
              import('@chronolog/peer-session/sql-browser'), import('@chronolog/peer-session/sql')]);
            const loaded = await loadBrowserEngine(new URL('./engine/', import.meta.url)); signal.throwIfAborted();
            if (!loaded.module.installOpfsSAHPoolVfs) throw Error('SQL_OPFS_POOL_UNAVAILABLE');
            pool = await loaded.module.installOpfsSAHPoolVfs({ name: `inventory-${configuration.applicationId}`, directory: `inventory-${configuration.applicationId}`, initialCapacity: 12 });
            signal.throwIfAborted();
            return createSqlMaterializationRuntime({ engine: createBrowserSqlEngine({ ...loaded, vfs: pool.vfsName }), path: '/inventory.sqlite', rootPrincipal });
          },
        });
        admission = admitBrowserSession(session, { peers, wrapKey });
        participation = participateApplication(session, { peers, openDirectConnection, onNotification: () => void admission.refresh() }); Object.defineProperty(session, 'participation', { value: participation });
        return { session, extensions: composeOwnerExtensions(admission.extensions, hostedMcpExtensions({ session, admission })), async close() { admission.close(); await participation.close(); await release(); } };
      } catch (error) { admission?.close(); try { if (session) await session.close(); else await device.close(); } finally { await release(); } throw error; }
    },
  };
} });
