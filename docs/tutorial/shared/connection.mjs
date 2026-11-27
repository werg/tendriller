// Optional presentation controller for local owner opening, not a peer/finality authoring gate.
const codeOf = error => String(error?.code ?? error?.message ?? error?.name ?? 'OPEN_FAILED');

export function describeConnectionError(error, { appName = 'this app' } = {}) {
  const code = codeOf(error), technical = code;
  if (['browser_account_required', 'owner_required', 'unauthorized', 'AUTH_REQUIRED'].includes(code) || error?.status === 401)
    return { title: 'Sign in to initialize this device', detail: `Open the signed ${appName} page with its actual owner/account session.`, action: 'reload', technical };
  if (['AUTHORITY_CACHE_MISSING', 'BOOTSTRAP_KEY_MISSING', 'APPLICATION_DEVICE_KEYS_MISSING'].includes(code))
    return { title: 'Restore this device’s retained setup', detail: 'Keep its private identity, bootstrap intent and original data keys. Never initialize replacement keys for an existing epoch.', technical };
  if (code === 'WORKER_LOAD_FAILED')
    return { title: 'Could not load the local session worker', detail: 'Check your connection or reload to fetch the latest page worker.', action: 'reload', technical };
  if (['BOOT_TIMEOUT', 'CONNECT_TIMEOUT'].includes(code))
    return { title: 'Local session startup timed out', detail: 'Local storage or worker startup took too long. Retry without clearing your profile.', retry: true, technical };
  if (['OWNER_BUSY', 'OWNER_UNREACHABLE', 'ENDPOINT_STALE'].includes(code))
    return { title: 'The local owner could not answer', detail: 'Retry attaching this profile. Original signed operations remain retained locally.', retry: true, technical };
  if (['OWNER_CAPABILITY_UNAVAILABLE', 'OWNER_STORAGE_UNSUPPORTED', 'QuotaExceededError'].includes(code))
    return { title: 'Local browser storage needs attention', detail: 'Use the supported Worker/IndexedDB storage without clearing this retained profile. Copy unsent drafts if storage is full.', technical };
  return { title: 'This local session could not open', detail: error?.message ?? String(error), retry: true, technical };
}

export function describeAdmissionStatus(status, admission = null) {
  const phase = admission?.phase ?? null;
  if (phase === 'waiting-admission') return { phase: 'key-required', admissionPhase: phase, title: 'Device attached; waiting for admission', detail: 'Waiting for one of your already-admitted devices or your agent to come online to admit this browser. Other admitted devices can keep writing offline.' };
  if (phase === 'waiting-approval') return { phase: 'key-required', admissionPhase: phase, title: 'Waiting for approval', detail: 'This page uses strict mode. Approve this browser in Devices and access on one of your already-admitted devices (or via your agent).' };
  if (phase === 'waiting-keys') return { phase: 'key-required', admissionPhase: phase, title: 'Waiting for page keys', detail: 'This browser is already admitted and is fetching or waiting for the latest encrypted page key from another admitted device or agent.' };
  if (phase === 'removed') return { phase: 'key-required', admissionPhase: phase, title: 'This browser was removed', detail: 'This browser was removed from the page. Earlier local data stays here; another admitted device can approve it again in Devices and access.' };
  if (status?.keyState === 'missing-keys') {
    return { phase: 'key-required', admissionPhase: 'waiting-keys', title: 'Waiting for page keys', detail: 'This browser is admitted and waiting for an online key holder to seal the latest encrypted page key.' };
  }
  const self = admission?.members?.find(member => member.self);
  if (phase === 'admitted' && ((self && self.writer === false) || status?.canAuthorData === false)) {
    return { phase: 'connected', admissionPhase: phase, readOnly: true, title: 'Read-only access', detail: 'This browser is admitted with read-only access. It can read and sync locally, but cannot save new edits.' };
  }
  if (status?.canAuthor === false && status?.keyState !== 'ready' && status?.keyState !== 'public') {
    return { phase: 'key-required', title: 'Device attached; waiting for admission', detail: 'An online admitted device or agent that holds the page keys admits this device automatically (or an administrator device approves it in strict mode). Other admitted devices can keep writing; account access alone cannot decrypt data.' };
  }
  return { phase: 'connected', ...(phase ? { admissionPhase: phase } : {}), title: 'Local session ready', detail: 'Save can store signed work with zero peers. Network and optional finality are separate.' };
}

export function createOwnerConnection({ configuration, connect, onState = () => {}, appName = 'this app' }) {
  if (typeof connect !== 'function') throw TypeError('Supply the real retained owner attachment function');
  const lifetime = new AbortController(); let opening, closed = false, stopStatus = () => {}, stopAdmission = () => {};
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
        let lastStatus = session?.status, admission = null;
        const render = () => emit(describeAdmissionStatus(lastStatus, admission));
        const observe = status => { lastStatus = status; render(); };
        stopStatus(); stopAdmission();
        stopStatus = session?.onStatus?.(observe) ?? (() => {});
        stopAdmission = session?.extensions?.subscribe?.(message => {
          if (message?.topic === 'admission' && message.state) { admission = message.state; render(); }
        }) ?? (() => {});
        if (closed) { stopStatus(); stopAdmission(); }
        else {
          observe(session?.status);
          if (typeof session?.extensions?.call === 'function') {
            void session.extensions.call('admission.state', []).then(next => {
              if (!closed && next) { admission = next; render(); }
            }).catch(() => {});
          }
        }
        return connected;
      } catch (error) {
        if (!closed) {
          const copy = describeConnectionError(error, { appName });
          emit({
            ...copy,
            phase: 'failed',
            ...(copy.retry ? { action: { label: 'Retry this local attachment', run: start } }
              : copy.action === 'reload' ? { action: { label: 'Reload and sign in', run: () => location.reload() } }
                : { action: undefined }),
          });
        }
        throw error;
      }
      finally { opening = undefined; }
    })(); return opening;
  }
  return Object.freeze({ start, retry: start, get state() { return state; }, close() { if (closed) return; closed = true; stopStatus(); stopAdmission(); lifetime.abort(Error('Local opening view closed')); } });
}
