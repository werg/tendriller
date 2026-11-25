// Optional presentation controller for local owner opening, not a peer/finality authoring gate.
const codeOf = error => String(error?.code ?? error?.message ?? error?.name ?? 'OPEN_FAILED');
export function describeConnectionError(error, { appName = 'this app' } = {}) {
  const code = codeOf(error), technical = code;
  if (['browser_account_required', 'owner_required', 'unauthorized'].includes(code) || error?.status === 401)
    return { title: 'Sign in to initialize this device', detail: `Open the signed ${appName} page with its actual owner/account session.`, action: 'reload', technical };
  if (['AUTHORITY_CACHE_MISSING', 'BOOTSTRAP_KEY_MISSING', 'APPLICATION_DEVICE_KEYS_MISSING'].includes(code))
    return { title: 'Restore this device’s retained setup', detail: 'Keep its private identity, bootstrap intent and original data keys. Never initialize replacement keys for an existing epoch.', technical };
  if (['OWNER_BUSY', 'OWNER_UNREACHABLE', 'ENDPOINT_STALE'].includes(code))
    return { title: 'The local owner could not answer', detail: 'Reattach this same profile, or close its other tabs and reopen. Original signed operations remain retained.', retry: true, technical };
  if (['OWNER_CAPABILITY_UNAVAILABLE', 'OWNER_STORAGE_UNSUPPORTED', 'QuotaExceededError'].includes(code))
    return { title: 'Local browser storage needs attention', detail: 'Use the supported owner/Worker mode without clearing this retained profile. Copy unsent drafts if storage cannot retain them.', technical };
  return { title: 'This local session could not open', detail: error?.message ?? String(error), technical };
}
export function createOwnerConnection({ configuration, connect, onState = () => {}, appName = 'this app' }) {
  if (typeof connect !== 'function') throw TypeError('Supply the real retained owner attachment function');
  const lifetime = new AbortController(); let opening, closed = false, stopStatus = () => {};
  let state = { phase: 'opening', title: 'Opening this device…', detail: 'Retained local identity and storage open before background discovery.' };
  const emit = value => { if (closed) return; state = Object.freeze(value); try { onState(state); } catch {} };
  function start() {
    if (closed) return Promise.reject(lifetime.signal.reason);
    if (opening) return opening;
    if (globalThis.location?.origin !== new URL(configuration.page_url).origin) { emit({ phase: 'preview', title: 'Layout preview only', detail: 'Open the signed page at its authorized origin for actual local storage and enrollment.' }); return Promise.resolve(); }
    emit({ phase: 'opening', title: 'Opening this device…', detail: 'A native participant, peer and finalizer are not prerequisites.' });
    opening = (async () => {
      try {
        const connected = await connect({ signal: lifetime.signal }); lifetime.signal.throwIfAborted();
        const session = connected?.session ?? connected;
        const observe = status => emit(status?.canAuthor === false ? { phase: 'key-required', title: 'Device attached; authoring prerequisites missing', detail: 'Use explicit key provisioning/crypto grants. Other devices can keep writing; account access alone cannot decrypt old data.' }
          : { phase: 'connected', title: 'Local session ready', detail: 'Save can store signed work with zero peers. Network and optional finality are separate.' });
        stopStatus(); stopStatus = session?.onStatus?.(observe) ?? (() => {}); if (closed) stopStatus(); else observe(session?.status);
        return connected;
      } catch (error) { if (!closed) { const copy = describeConnectionError(error, { appName }); emit({ ...copy, phase: 'failed', ...(copy.retry ? { action: { label: 'Retry this local attachment', run: start } } : copy.action === 'reload' ? { action: { label: 'Reload and sign in', run: () => location.reload() } } : { action: undefined }) }); } throw error; }
      finally { opening = undefined; }
    })(); return opening;
  }
  return Object.freeze({ start, retry: start, get state() { return state; }, close() { if (closed) return; closed = true; stopStatus(); lifetime.abort(Error('Local opening view closed')); } });
}
export function reloadOnOwnerReplaced() { location.reload(); }
