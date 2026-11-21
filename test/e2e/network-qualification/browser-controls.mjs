import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function createBrowserNetworkControls(page) {
  const context = page.context();
  const initialUrl = page.url();
  const publication = () => page.evaluate(() => window.tendril?.identity?.publication ?? null).catch(() => null);
  const initialPublication = await publication();
  const binding = `__networkLabLifecycle_${randomUUID().replaceAll('-', '')}`;
  const external = [];
  let navigations = 0, dropped = 0, observing = true;
  function record(event, extra = {}) {
    if (!observing) return;
    if (external.length === 32) { external.shift(); dropped++; }
    external.push({ at: new Date().toISOString(), epoch: navigations, event, ...extra });
  }
  let bindingRegistration, scriptRegistration, cdp;
  const installObserver = key => {
    if (window !== window.top) return;
    const emit = event => { void window[key](event).catch(() => {}); };
    const freeze = () => emit('freeze'), resume = () => emit('resume');
    document.addEventListener('freeze', freeze); document.addEventListener('resume', resume);
    window[`${key}Cleanup`] = () => { document.removeEventListener('freeze', freeze); document.removeEventListener('resume', resume); };
    emit('document');
  };
  const navigated = frame => {
    if (frame !== page.mainFrame()) return;
    navigations++;
    const current = frame.url();
    record('main-frame-navigation', { sameUrl: current === initialUrl,
      sameOrigin: (() => { try { return new URL(current).origin === new URL(initialUrl).origin; } catch { return false; } })() });
  };
  const removeDocumentListeners = () => page.evaluate(key => {
    window[`${key}Cleanup`]?.(); delete window[`${key}Cleanup`];
  }, binding);
  try {
    bindingRegistration = await page.exposeBinding(binding, (source, event) => {
      if (source.frame === page.mainFrame() && ['document', 'freeze', 'resume'].includes(event)) record(event);
    });
    scriptRegistration = await page.addInitScript(installObserver, binding);
    await page.evaluate(installObserver, binding);
    page.on('framenavigated', navigated);
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    // Playwright normally forces focus/visibility, which can make freeze a no-op.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  } catch (error) {
    observing = false; page.off('framenavigated', navigated);
    const failures = [];
    for (const undo of [() => scriptRegistration?.dispose(), removeDocumentListeners,
      () => bindingRegistration?.dispose(), () => cdp?.detach()]) {
      try { await undo(); } catch (failure) { failures.push(failure); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'NETWORK_LAB_OBSERVER_SETUP_CLEANUP_FAILED');
    throw error;
  }
  let frozen = false;
  let changed = false;
  let alternate = false;
  let cover;
  const normal = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'ethernet' };
  return {
    async diagnostics() {
      const currentPublication = await publication();
      return { navigations, dropped, events: structuredClone(external),
        sameUrl: page.url() === initialUrl,
        samePublication: initialPublication === null || currentPublication === null ? null :
          JSON.stringify(initialPublication) === JSON.stringify(currentPublication) };
    },
    async networkChange({ signal }) {
      signal.throwIfAborted();
      // CDP produces an actual NetworkInformation change notification in the
      // browser; no dispatchEvent or direct participation API call is used.
      await page.evaluate(() => {
        if (!navigator.connection) throw Error('NETWORK_INFORMATION_UNSUPPORTED');
        window.__networkLabChangeObserved = false;
        window.__networkLabChangeListener?.();
        const listener = () => { window.__networkLabChangeObserved = true; };
        navigator.connection.addEventListener('change', listener, { once: true });
        window.__networkLabChangeListener = () => navigator.connection.removeEventListener('change', listener);
      });
      alternate = !alternate;
      changed = true;
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: alternate ? 20 : 40,
        downloadThroughput: 1_000_000, uploadThroughput: 1_000_000, connectionType: 'cellular3g' });
      await page.waitForFunction(() => window.__networkLabChangeObserved === true, null, { timeout: 5000 });
      signal.throwIfAborted();
      return { type: 'connection-change', observed: true, scope: 'cdp-emulation' };
    },
    async setOffline(value, { signal }) {
      signal.throwIfAborted();
      assert.equal(typeof value, 'boolean');
      await context.setOffline(value);
      // A separate CDP network emulation session can otherwise leave fetches
      // online while navigator.onLine already reports false. Set both scopes.
      changed = true;
      await cdp.send('Network.emulateNetworkConditions', { ...normal, offline: value });
      await page.waitForFunction(expected => navigator.onLine === !expected, value, { timeout: 5000 });
      signal.throwIfAborted();
    },
    async setFrozen(value, { signal }) {
      signal.throwIfAborted();
      assert.equal(typeof value, 'boolean');
      if (value) await page.evaluate(() => {
        window.__networkLabLifecycle = [];
        const capture = type => window.__networkLabLifecycle.push({ type, at: performance.now() });
        document.addEventListener('freeze', () => capture('freeze'), { once: true });
        document.addEventListener('resume', () => capture('resume'), { once: true });
      });
      if (value) {
        cover = await context.newPage();
        await cover.goto('about:blank'); await cover.bringToFront();
        assert.equal(await page.evaluate(() => document.hidden), true, 'Browser did not background the page before freeze');
      }
      await cdp.send('Page.setWebLifecycleState', { state: value ? 'frozen' : 'active' });
      frozen = value;
      signal.throwIfAborted();
      if (!value) {
        // A hidden page may have no rAF even after active. Restore the real tab
        // before observing queued resume work; this is not an application probe.
        await cover?.close(); cover = undefined; await page.bringToFront();
        await page.waitForFunction(() => window.__networkLabLifecycle?.some(event => event.type === 'resume'), null, { timeout: 5000, polling: 50 });
        const observed = await page.evaluate(() => window.__networkLabLifecycle.map(event => event.type));
        assert.deepEqual(observed, ['freeze', 'resume'], 'The browser did not actually freeze/resume');
        assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'Resume left the selected tab hidden');
      }
    },
    async background({ signal, pauseMs, onHidden }) {
      signal.throwIfAborted();
      const other = await context.newPage();
      try {
        await other.goto('about:blank'); await other.bringToFront();
        const hiddenObserved = await page.evaluate(() => document.visibilityState === 'hidden');
        let hiddenResult;
        if (hiddenObserved && onHidden) {
          hiddenResult = await onHidden({ signal });
          signal.throwIfAborted();
          assert.equal(await page.evaluate(() => document.hidden), true, 'Hidden work foregrounded the page');
        }
        // This is an observation interval, not a claim that headless tabs always
        // implement the browser's foreground/background scheduler policy.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(done, pauseMs);
          function done() { signal.removeEventListener('abort', cancel); resolve(); }
          function cancel() { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); }
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
        });
        await page.bringToFront();
        return { hiddenObserved, hiddenResult };
      } finally { await other.close(); }
    },
    async cleanup() {
      observing = false; page.off('framenavigated', navigated);
      const errors = [];
      for (const action of [
        () => frozen ? cdp.send('Page.setWebLifecycleState', { state: 'active' }) : undefined,
        () => cover?.close(),
        () => context.setOffline(false),
        () => changed ? cdp.send('Network.emulateNetworkConditions', normal) : undefined,
        () => page.evaluate(() => { window.__networkLabChangeListener?.(); delete window.__networkLabChangeListener; delete window.__networkLabChangeObserved; }),
        removeDocumentListeners,
        () => scriptRegistration.dispose(),
        () => bindingRegistration.dispose(),
        () => cdp.detach(),
      ]) { try { await action(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'NETWORK_LAB_BROWSER_CLEANUP_FAILED');
    },
  };
}
