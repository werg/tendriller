// Shared browser Worker composition helper for Tendriller pages.
// Uses WebAssembly.compileStreaming, lazy SQLite WASM loading, inline boot configuration
// (zero configuration.json round-trip when provided), lock-free multi-tab IndexedDB,
// and stealable network leadership so sibling tabs never bounce host sockets.
import quickJsWasmUrl from '@jitl/quickjs-ng-wasmfile-release-sync/wasm';
import { createApplicationSession } from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '@tendriller/core/worker-owner';
import { participateApplication } from '@tendriller/core/participation';
import { composeOwnerExtensions } from '@tendriller/core/admission';
import { recoverPublicationAsset } from '@tendriller/core/publication-blobs';
import { browserProfileId } from './browser-profile.mjs';
import { admitBrowserSession, bootstrapBrowser, finalizeFirstBrowserGenesis } from './browser-bootstrap.mjs';
import { hostedMcpExtensions } from './hosted-mcp.mjs';

const compileWasm = async url => {
  const response = await fetch(new URL(url, self.location.href));
  if (!response.ok) throw Error(`Failed to load WASM (${response.status})`);
  if (typeof WebAssembly.compileStreaming === 'function') {
    try { return await WebAssembly.compileStreaming(response.clone()); } catch { /* Fallback if MIME isn't application/wasm */ }
  }
  return WebAssembly.compile(await response.arrayBuffer());
};

const quickJsWasmPromise = compileWasm(quickJsWasmUrl);

/**
 * Start the page's dedicated Chronolog browser owner Worker.
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
  let sqliteWasmPromise = null;
  const sqliteWasmLoader = sqliteWasmUrl
    ? () => (sqliteWasmPromise ??= compileWasm(sqliteWasmUrl))
    : undefined;

  return serveBrowserOwner({
    async load({ signal, configuration: inlineConfig }) {
      let configuration = inlineConfig;
      if (!configuration || typeof configuration !== 'object' || !configuration.applicationId) {
        const response = await fetch(new URL(configUrl, self.location.href), { signal });
        if (!response.ok) throw Error('Application configuration is unavailable');
        configuration = await response.json();
      }
      const profileId = browserProfileId(configuration.applicationId);
      return {
        profileId,
        async createIdentity() {
          const device = await openBrowserDevice({ name: profileId, create: true });
          try { return device.identity.publicKey; } finally { await device.close(); }
        },
        async openSession({ signal: openSignal, openDirectConnection, initialNetworkActive = true }) {
          const device = await openBrowserDevice({ name: profileId, create: true });
          let session, participation, admission;
          try {
            const [opened, wasmModule] = await Promise.all([
              bootstrapBrowser({ configuration, device, imports, topics, signal: openSignal }),
              quickJsWasmPromise,
            ]);
            const epochKeys = opened.epoch0Key ? new Map([[0, opened.epoch0Key]]) : undefined;
            const mirrorBase = new URL('_tendril', configuration.page_url).href.replace(/\/+$/u, '');
            session = await createApplicationSession({
              device,
              applicationId: configuration.applicationId,
              genesis: opened.genesisBytes,
              casNodes: opened.casNodes,
              casMirrors: [mirrorBase],
              wasmModule,
              ...(sqliteWasmLoader ? { sqliteWasmLoader } : {}),
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
              active: initialNetworkActive,
              // The admission controller owns public-control sync; each host push
              // re-reads only the scopes it changed.
              syncControl: false,
              onNotification: notification => admission.notify(notification),
            });
            Object.defineProperty(session, 'participation', { value: participation });
            const pubRecoveryExtension = Object.freeze({
              async call(name, args) {
                if (name !== 'publication.recoverAsset') throw Object.assign(Error('EXTENSION_UNKNOWN'), { code: 'EXTENSION_UNKNOWN' });
                const [req] = args ?? [];
                const pubState = session.topic?.('$publications');
                const versions = [pubState?.current, ...(Array.isArray(pubState?.history) ? pubState.history : [])].filter(Boolean);
                let matched = null;
                for (const ver of versions) {
                  for (const f of ver.files ?? []) {
                    if ((req?.sha256 && f.hash === req.sha256) || (req?.path && f.path === req.path)) {
                      matched = f;
                      break;
                    }
                  }
                  if (matched) break;
                }
                const target = matched ?? (req?.sha256 ? { hash: req.sha256, size: req.size ?? 0, type: req.type || 'application/octet-stream', path: req.path || '' } : null);
                if (!target?.hash) return null;
                const found = await recoverPublicationAsset(session, target, { cache: true });
                return found ? { bytes: found.bytes, type: target.type || 'application/octet-stream', source: found.source } : null;
              },
            });
            const baseHref = new URL('_tendril/', configuration.page_url).href;
            const custom = typeof extraExtensions === 'function' ? extraExtensions({ session, admission, opened }) : [];
            const extList = [
              admission.extensions,
              hostedMcpExtensions({ session, admission, base: baseHref }),
              pubRecoveryExtension,
              ...(Array.isArray(custom) ? custom : custom ? [custom] : []),
            ];
            return {
              session,
              extensions: composeOwnerExtensions(...extList),
              onWake() { void admission?.refresh(); },
              setNetworkActive(active) { participation?.setActive?.(active); },
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
