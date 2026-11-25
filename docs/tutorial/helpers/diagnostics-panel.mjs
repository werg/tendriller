// DevTools-free in-page diagnostics surface (W4).
// Publishes a machine-readable JSON snapshot in <script type="application/json" id="tendriller-diagnostics">
// and a lightweight toggleable panel so browser agents without JS injection or DevTools can inspect health.

export function mountDiagnosticsPanel(container, { appName = 'Tendriller app' } = {}) {
  let script = document.getElementById('tendriller-diagnostics');
  if (!script) {
    script = document.createElement('script');
    script.id = 'tendriller-diagnostics';
    script.type = 'application/json';
    document.head.appendChild(script);
  }

  const details = document.createElement('details');
  details.id = 'tendriller-diagnostics-panel';
  details.style.cssText = 'margin-top:1rem;border:1px solid #d0d7de;border-radius:8px;padding:0.5rem 0.75rem;font-size:0.875rem;';
  const summary = document.createElement('summary');
  summary.textContent = `${appName} diagnostics`;
  summary.style.cursor = 'pointer';
  const pre = document.createElement('pre');
  pre.id = 'tendriller-diagnostics-view';
  pre.style.cssText = 'margin:0.5rem 0 0;overflow:auto;max-height:240px;font-size:0.75rem;';
  details.append(summary, pre);
  if (container) container.appendChild(details);

  const state = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    capabilities: {
      webWorkers: typeof Worker === 'function',
      sharedWorker: typeof SharedWorker === 'function',
      webAssembly: typeof WebAssembly === 'object' && typeof WebAssembly.compile === 'function',
      webLocks: typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function',
      webCrypto: typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function',
      opfs: typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function',
      indexedDb: typeof indexedDB !== 'undefined',
      storageBackend: 'unknown',
      storagePersisted: 'unknown',
    },
    localOwnerStatus: 'unknown',
    transportReachability: { https: 'unknown', relayWebSocket: 'unknown', directWebRtc: 'unknown' },
    sessionStatus: { phase: 'unknown', canAuthor: false, connectedPeers: 0 },
    lastStoredOperationId: null,
    availabilityNotice: 'A closed or suspended browser tab cannot accept remote commands until reopened or handed off.',
  };

  function render() {
    state.updatedAt = new Date().toISOString();
    const serialized = JSON.stringify(state, null, 2);
    script.textContent = serialized;
    pre.textContent = serialized;
  }

  async function probePersistence() {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage) {
        const persisted = typeof navigator.storage.persisted === 'function' ? await navigator.storage.persisted() : false;
        if (persisted) state.capabilities.storagePersisted = true;
        else if (typeof navigator.storage.persist === 'function') {
          state.capabilities.storagePersisted = Boolean(await navigator.storage.persist());
        } else {
          state.capabilities.storagePersisted = false;
        }
        state.capabilities.storageBackend = state.capabilities.opfs ? 'opfs-or-indexeddb' : state.capabilities.indexedDb ? 'indexeddb' : 'unavailable';
      }
    } catch {
      state.capabilities.storagePersisted = false;
    }
    render();
  }

  void probePersistence();
  render();

  return Object.freeze({
    update(patch = {}) {
      if (patch.localOwnerStatus !== undefined) state.localOwnerStatus = patch.localOwnerStatus;
      if (patch.storageBackend !== undefined) state.capabilities.storageBackend = patch.storageBackend;
      if (patch.lastStoredOperationId !== undefined) state.lastStoredOperationId = patch.lastStoredOperationId;
      if (patch.sessionStatus) Object.assign(state.sessionStatus, patch.sessionStatus);
      if (patch.transportReachability) Object.assign(state.transportReachability, patch.transportReachability);
      render();
    },
    snapshot: () => structuredClone(state),
    close() { details.remove(); },
  });
}

/**
 * Best-effort lifecycle notification only. Callers must supply a real flush; a no-op
 * does not flush storage or create a checkpoint. Browsers need not await promises
 * during eviction. Durable intent must already be saved before sending commands.
 */
export function registerLifecycleFlush(onFlush, { onError = () => {} } = {}) {
  if (typeof onFlush !== 'function') throw TypeError('Provide a lifecycle flush callback.');
  // Observe asynchronous failures too, including a rejecting error reporter.
  const failed = error => { try { Promise.resolve(onError(error)).catch(() => {}); } catch {} };
  const flush = () => { try { Promise.resolve(onFlush()).catch(failed); } catch (error) { failed(error); } };
  const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flush);
  document.addEventListener('freeze', flush);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('freeze', flush);
  };
}
