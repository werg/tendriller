// The owner-facing connection flow. Ship this, not a set of buttons.
//
// Opening the page is the whole flow:
//   1. attach to this browser's device owner (shared by every tab) and open the app;
//   2. if this browser has no device grant yet, create its key and a pairing request,
//      then open the service-origin approval once, with a return to this page;
//   3. after approval, wait for the native participant to commit, then connect;
//   4. any other failure is said in plain words and retried with backoff.
// Later visits only do step 1. The browser key never leaves its Worker; approval
// stays on the service origin; the native owner stages the exact proposal first.

const NOT_ENROLLED = new Set(['APPLICATION_DEVICE_NOT_FOUND', 'DEVICE_NOT_ENROLLED', 'APPLICATION_PEER_NOT_AUTHORIZED']);
const TRANSIENT = new Set(['OWNER_BUSY', 'OWNER_UNREACHABLE', 'ENDPOINT_STALE', 'OWNER_HANDSHAKE_TIMEOUT', 'OWNER_REPLACED',
  'PAIRING_TIMEOUT', 'PAIRING_WORKER_UNAVAILABLE', 'pairing_busy', 'pairing_response_unavailable', 'pairing_storage_unavailable',
  'TimeoutError', 'AbortError', 'NetworkError', 'TypeError']);
const codeOf = error => String(error?.code || error?.name || 'ERROR');

/** User-facing copy for connection and pairing errors. Developer details stay in `technical`. */
import { requestPersistentStorage } from '@tendriller/core/browser-owner';

export function describeConnectionError(error, { appName = 'this app' } = {}) {
  const code = codeOf(error), technical = `${code}${error?.message && error.message !== code ? `: ${error.message}` : ''}`;
  const copy = (title, detail, retry = true, extra = {}) => ({ code, title, detail, retry, technical, ...extra });
  if (NOT_ENROLLED.has(code)) return copy('Setting up this browser…', `This browser is new to ${appName}. It gets its own key; you approve it once.`, true, { enroll: true });
  if (TRANSIENT.has(code) || /timed? ?out|network|failed to fetch/i.test(error?.message ?? ''))
    return copy('Connecting…', code.startsWith('OWNER') || code === 'ENDPOINT_STALE' ? `Another tab of ${appName} is starting the connection.` : 'The connection is slow. Retrying…');
  if (['pairing_account_required', 'pairing_account_revoked', 'pairing_owner_required', 'unauthorized'].includes(code) || error?.status === 401)
    return copy('Sign in to continue', `Your sign-in for ${appName} has ended. Reload the page to sign in again.`, false, { action: 'reload' });
  if (['PAIRING_STORAGE_REQUIRED', 'PAIRING_LOCK_REQUIRED', 'OWNER_CAPABILITY_UNAVAILABLE', 'QuotaExceededError', 'PAIRING_STORAGE_CORRUPT'].includes(code))
    return copy('This browser can’t keep the app’s key', 'Private browsing or blocked site storage prevents it. Open the page in a normal tab.', false);
  if (['pairing_rate_limited', 'pairing_ledger_full', 'rate_limited'].includes(code))
    return copy('Too many attempts', 'Wait a minute; the page tries again by itself.');
  if (code === 'PAIRING_HISTORY_FULL') return copy('This browser needs setup help', 'Ask your agent to inspect the retained requests and enroll this browser’s existing device key using the manual enrollment route. Keep this browser’s storage and saved requests.', false, { action: 'help' });
  if (code === 'denied') return copy('The request was declined', `This browser was not added to ${appName}.`, false, { action: 'renew' });
  if (code === 'revoked') return copy('This browser’s access was removed', `Ask the owner of ${appName} to admit your account again.`, false);
  if (code === 'reconciliation_required') return copy('Setup needs attention', `${appName}’s participant has to reconcile this request. Keep it running; this page retries.`);
  if (code === 'OWNER_STORAGE_UNSUPPORTED' || code === 'OWNER_ORIGIN_MISMATCH') return copy('This page can’t open the app here', 'Open the app from its published address.', false);
  return copy('Couldn’t connect yet', 'Retrying. If this persists, reload the page.');
}

const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});

/**
 * @param options.connect   async () => anything: attach with openBrowserOwner, mount, return when the app is usable.
 *                          Throw the attach error unchanged (its `code` drives the flow).
 * @param options.pairing   createBrowserPairing(...) from pairing-browser.mjs.
 * @param options.onState   receives { phase, title, detail, action?, technical?, reviewUrl? } on every change.
 * @param options.appName   used in user-facing copy.
 * Phases: connecting · enrolling · approve · finishing · connected · failed · preview.
 */
export function createOwnerConnection({ configuration, pairing, connect, onState = () => {}, appName = 'this app',
  storage = sessionStorage, navigate = url => location.assign(url), here = () => location.href, maxDelayMs = 15_000 }) {
  const reviewedKey = id => `tendriller:reviewed:${configuration.applicationId}:${id}`;
  const lifetime = new AbortController();
  let state = { phase: 'connecting', title: 'Connecting…', detail: '' }, running, wake = () => {};
  const set = value => { if (lifetime.signal.aborted) return; state = Object.freeze(value); try { onState(state); } catch { /* A view cannot stop the flow. */ } };
  const reviewUrl = status => {
    const target = new URL(here());
    // Preserve the complete return address when possible; the review endpoint has
    // a fixed URL bound. Even an unusually long document path can return home.
    if (target.href.length > 2048) { target.search = ''; target.hash = ''; }
    if (target.href.length > 2048) target.pathname = '/';
    const url = new URL(status.reviewUrl); url.searchParams.set('return_to', target.href); return url.href;
  };
  let renewRequested = false, automaticRenewals = 0, started = false;
  const visibility = () => { if (document.visibilityState === 'visible') nudge(); };
  const deadline = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(35_000)]);
  const nudge = () => wake();

  async function enroll() {
    // The new device key is this browser's only signer: keep its storage out of best-effort eviction.
    void requestPersistentStorage();
    const retained = pairing.read();
    let status = retained?.pairingId ? await pairing.refresh({ signal: deadline() }) : await pairing.request({ signal: deadline() });
    lifetime.signal.throwIfAborted();
    if (status.state === 'challenge') status = await pairing.request({ signal: deadline() });
    if (['expired', 'stale'].includes(status.state) || renewRequested && status.state === 'denied') {
      // One automatic recovery per visit. An unattended tab must never consume
      // the complete retained review ledger while its native participant is away.
      if (!renewRequested && automaticRenewals >= 1) {
        set({ phase: 'failed', title: 'Setup request expired', detail: `Keep ${appName}’s participant running, then request another review for this same browser.`,
          action: { label: 'Request another review', run: () => (renewRequested = true, restart()) } });
        return 'stop';
      }
      automaticRenewals++;
      status = await pairing.request({ newReview: true, signal: deadline() });
    }
    renewRequested = false;
    lifetime.signal.throwIfAborted();
    if (status.state === 'committed') return 'connect';
    if (status.state === 'denied') { set({ phase: 'failed', ...describeConnectionError({ code: 'denied' }, { appName }), action: { label: 'Ask again', run: () => (renewRequested = true, restart()) } }); return 'stop'; }
    if (['revoked', 'reconciliation_required'].includes(status.state)) throw Object.assign(Error(status.nextAction), { code: status.state });
    if (status.state === 'pending' && !storage.getItem(reviewedKey(status.pairingId)) && status.preparedDigest) {
      // One trip to the service origin; it returns here by itself after Approve.
      storage.setItem(reviewedKey(status.pairingId), String(Date.now()));
      set({ phase: 'approve', title: 'Opening approval…', detail: `You approve this browser once, on ${new URL(status.reviewUrl).host}.`, reviewUrl: reviewUrl(status) });
      navigate(reviewUrl(status));
      return 'stop';
    }
    if (status.state === 'pending' && status.preparedDigest) {
      // Back without approving (or approval in another tab): offer the one action.
      set({ phase: 'approve', title: 'Approve this browser', detail: `Confirm on ${new URL(status.reviewUrl).host} that this browser may open ${appName}.`,
        reviewUrl: reviewUrl(status), action: { label: 'Approve this browser', run: () => navigate(reviewUrl(status)) } });
      return 'wait';
    }
    set({ phase: status.state === 'pending' ? 'enrolling' : 'finishing',
      title: status.state === 'pending' ? 'Setting up this browser…' : 'Finishing setup…',
      detail: status.state === 'pending' ? `${appName} is preparing the request. This takes a few seconds.` : `Approved. ${appName} is adding this browser.` });
    return 'wait';
  }

  async function run() {
    let delay = 1000, waitingSince = 0, needsEnrollment = false, enrollmentDelay = 1500;
    while (!lifetime.signal.aborted) {
      try {
        set({ ...state, phase: state.phase === 'connected' ? 'connecting' : state.phase,
          ...(['failed', 'connected'].includes(state.phase) ? { title: 'Connecting…', detail: '', action: undefined } : {}) });
        // While one enrollment is outstanding, inspect that retained request
        // instead of reopening a missing device owner on every status read.
        if (needsEnrollment) throw Object.assign(Error('Browser enrollment pending'), { code: 'DEVICE_NOT_ENROLLED' });
        await connect({ signal: lifetime.signal });
        lifetime.signal.throwIfAborted();
        set({ phase: 'connected', title: 'Connected', detail: '' });
        return;
      } catch (error) {
        if (lifetime.signal.aborted) return;
        const described = describeConnectionError(error, { appName });
        if (described.enroll) {
          needsEnrollment = true;
          let next;
          try { next = await enroll(); }
          catch (failure) {
            if (lifetime.signal.aborted) return;
            const copy = describeConnectionError(failure, { appName });
            set({ phase: copy.retry ? 'connecting' : 'failed', ...copy, ...(copy.action === 'reload' ? { action: { label: 'Reload', run: () => location.reload() } } : copy.action === 'help' ? { action: { label: 'Setup recovery guide', run: () => navigate(new URL('/docs/TROUBLESHOOTING.md', configuration.serviceOrigin).href) } } : {}) });
            if (!copy.retry) return;
            next = 'wait';
          }
          if (next === 'stop') return;
          if (next === 'connect') { needsEnrollment = false; delay = 1000; enrollmentDelay = 1500; continue; }
          waitingSince ||= Date.now();
          if (Date.now() - waitingSince > 45_000 && state.phase === 'finishing')
            set({ ...state, detail: `Waiting for ${appName}’s participant. Setup finishes as soon as it is running.` });
          await new Promise(resolve => { wake = resolve; void sleep(enrollmentDelay, lifetime.signal).then(resolve); });
          enrollmentDelay = Math.min(enrollmentDelay * 2, maxDelayMs);
          continue;
        }
        set({ phase: described.retry ? 'connecting' : 'failed', title: described.title, detail: described.detail, technical: described.technical,
          ...(described.action === 'reload' ? { action: { label: 'Reload', run: () => location.reload() } } : {}),
          ...(!described.retry && !described.action ? { action: { label: 'Try again', run: () => restart() } } : {}) });
        if (!described.retry) return;
        await sleep(delay, lifetime.signal); delay = Math.min(delay * 2, maxDelayMs);
      }
    }
  }
  function restart() {
    if (lifetime.signal.aborted) return Promise.resolve();
    if (running) { nudge(); return running; }
    running = run().finally(() => { running = undefined; });
    return running;
  }
  function start() {
    if (location.origin !== new URL(configuration.page_url).origin) {
      set({ phase: 'preview', title: 'Layout preview', detail: 'Open the published page to connect to the app.' }); return Promise.resolve();
    }
    // Returning from the review tab or app switcher checks at once.
    if (!started) {
      started = true; addEventListener('focus', nudge); addEventListener('pageshow', nudge);
      document.addEventListener('visibilitychange', visibility);
    }
    return restart();
  }
  return Object.freeze({ start, get state() { return state; }, retry: () => restart(),
    close() { lifetime.abort(); removeEventListener('focus', nudge); removeEventListener('pageshow', nudge); document.removeEventListener('visibilitychange', visibility); } });
}

/** When another tab or a page update replaced this tab's owner route, reconnect by
 * reloading (the runtime backend binds once per page); never more than once a minute. */
export function reloadOnOwnerReplaced({ key = 'tendriller:owner-replaced', storage = sessionStorage, onSkipped = () => {} } = {}) {
  return () => {
    const last = Number(storage.getItem(key) || 0);
    if (Date.now() - last < 60_000) { onSkipped(); return; }
    storage.setItem(key, String(Date.now())); location.reload();
  };
}
