// Chromium profiles and page-load instrumentation for the benchmark.
//
// Every context gets an init script that records milestones with
// performance.now() (relative to the document's timeOrigin):
//   runtimeDefined   the host-injected runtime defined window.tendril
//   applicationReady window.tendril 'application_ready' (page installed its session backend)
//   sessionStatus    #connection-status first shows a session status
//   canAuthor        #submit enabled (session attached, this device admitted and authoring)
//   tendrilReady     the page called window.tendril.ready() (after its live view's first snapshot)
//   firstItem        first #notes li rendered
//   dataRendered     #notes li count >= the expected number of existing notes
// Every request of the context (page and workers) is recorded through Playwright.
import { chromium } from '@playwright/test';
import { fixtureBrowserOptions, FIXTURE_OWNER } from '../first-app-fixture.mjs';

export const MILESTONES = ['runtimeDefined', 'applicationReady', 'sessionStatus', 'canAuthor', 'tendrilReady', 'firstItem', 'dataRendered'];

function instrument({ expected }) {
  const bench = window.__bench = { marks: {}, expected, waiters: [] };
  const mark = name => { if (!(name in bench.marks)) bench.marks[name] = performance.now(); };
  try { performance.setResourceTimingBufferSize(10000); } catch {}
  const define = Object.defineProperty;
  Object.defineProperty = function (target, key, descriptor) {
    const result = define.call(Object, target, key, descriptor);
    if (target === window && key === 'tendril' && descriptor && descriptor.value) {
      Object.defineProperty = define;
      mark('runtimeDefined');
      try {
        descriptor.value.on('application_ready', () => mark('applicationReady'));
        descriptor.value.on('ready', () => mark('tendrilReady'));
      } catch {}
    }
    return result;
  };
  const check = () => {
    const status = document.getElementById('connection-status');
    if (status && /peers|admitted|signing/i.test(status.textContent ?? '')) mark('sessionStatus');
    const submit = document.getElementById('submit');
    if (submit && !submit.disabled && 'applicationReady' in bench.marks) mark('canAuthor');
    const items = document.querySelectorAll('#notes li');
    if (items.length >= 1) mark('firstItem');
    if (items.length >= Math.max(1, bench.expected)) mark('dataRendered');
    if (bench.waiters.length) {
      const texts = [...document.querySelectorAll('#notes a')].map(node => node.textContent);
      bench.waiters = bench.waiters.filter(waiter => {
        if (!texts.includes(waiter.text)) return true;
        waiter.resolve(Date.now()); return false;
      });
    }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  /** Resolve with the wall-clock time at which a note with exactly `text` is rendered. */
  bench.waitForText = text => new Promise(resolve => { bench.waiters.push({ text, resolve }); check(); });
}

export async function launchBrowser({ certificatePin, port, headless = true }) {
  return chromium.launch({ ...fixtureBrowserOptions({ certificatePin, port }), headless });
}

/** A fresh browser profile (new device) signed in as the synthetic owner account. */
export async function newProfile(browser, { expected = 0, viewport = { width: 1280, height: 900 }, label = 'profile' } = {}) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: false });
  await context.addCookies([{ name: '__Host-tendriller', value: FIXTURE_OWNER.token, domain: 'service.localhost', path: '/',
    secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(instrument, { expected });
  const requests = [], errors = [];
  const finish = async (request, failure) => {
    const timing = request.timing();
    const response = failure ? null : await request.response().catch(() => null);
    const sizes = failure ? null : await request.sizes().catch(() => null);
    let frame = true; try { request.frame(); } catch { frame = false; }
    requests.push({ url: request.url(), method: request.method(), type: request.resourceType(), frame,
      startWall: timing.startTime, ttfb: timing.responseStart, end: timing.responseEnd,
      status: response?.status() ?? null, failure: failure ?? null,
      serverTiming: response ? (await response.headerValue('server-timing').catch(() => null)) : null,
      bytes: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : null });
  };
  context.on('requestfinished', request => { void finish(request); });
  context.on('requestfailed', request => { void finish(request, request.failure()?.errorText ?? 'failed'); });
  context.on('weberror', error => { if (errors.length < 20) errors.push(String(error.error()?.message ?? error.error()).slice(0, 300)); });
  return { context, requests, errors, label };
}

/** Apply optional CDP CPU throttling to a page (network latency is injected at the host). */
export async function throttlePage(page, { cpu }) {
  if (!cpu || cpu <= 1) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
}

async function waitForMark(page, name, timeoutMs) {
  await page.waitForFunction(mark => window.__bench && mark in window.__bench.marks, name, { timeout: timeoutMs, polling: 50 });
}

/**
 * Navigate (or reload) and collect milestones, navigation/resource timing and
 * the context's requests up to dataRendered. `hostLog` attributes host requests to the load.
 */
export async function measureLoad({ profile, page, url, reload = false, until = 'dataRendered', timeoutMs = 120_000, hostLog, settleMs = 750 }) {
  const fromRequest = profile.requests.length;
  const hostSeq = hostLog ? await hostLog.seq() : 0;
  const wallStart = Date.now();
  if (reload) await page.reload({ waitUntil: 'commit', timeout: timeoutMs });
  else await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
  let timedOut = null;
  try { await waitForMark(page, until, timeoutMs); }
  catch (error) { timedOut = String(error.message).split('\n')[0]; }
  // A persisted (stale-while-revalidate) first paint can render the data before the
  // session opens; still record when the page's current data is ready.
  if (!timedOut && until !== 'tendrilReady') await waitForMark(page, 'tendrilReady', timeoutMs).catch(() => {});
  await page.waitForTimeout(settleMs);
  const snapshot = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0]?.toJSON() ?? null;
    const resources = performance.getEntriesByType('resource').map(entry => ({ name: entry.name, initiatorType: entry.initiatorType,
      startTime: entry.startTime, responseStart: entry.responseStart, responseEnd: entry.responseEnd, duration: entry.duration,
      transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize,
      nextHopProtocol: entry.nextHopProtocol, serverTiming: entry.serverTiming?.map(item => ({ name: item.name, duration: item.duration })) ?? [] }));
    let perf = null; try { perf = window.tendril?.perf?.() ?? null; } catch {}
    return { timeOrigin: performance.timeOrigin, marks: { ...window.__bench?.marks }, navigation, resources,
      perf: perf ? JSON.parse(JSON.stringify(perf)) : null, notes: document.querySelectorAll('#notes li').length };
  });
  const { timeOrigin, marks, navigation, resources } = snapshot;
  const doneAt = marks[until] ?? null;
  const metrics = {
    ttfb: navigation?.responseStart ?? null,
    htmlDone: navigation?.responseEnd ?? null,
    domContentLoaded: navigation?.domContentLoadedEventEnd || null,
    load: navigation?.loadEventEnd || null,
    ...Object.fromEntries(Object.entries(marks).map(([name, value]) => [name, Math.round(value * 10) / 10])),
  };
  // Requests of the whole context (page + workers) started before the milestone (or the timeout).
  const cutoffWall = timeOrigin + (doneAt ?? (Date.now() - timeOrigin));
  const contextRequests = profile.requests.slice(fromRequest)
    .filter(request => request.startWall >= wallStart - 5 && request.startWall <= cutoffWall)
    .map(request => ({ ...request, start: request.startWall - timeOrigin }));
  const pageResources = resources.filter(entry => entry.startTime <= (doneAt ?? Infinity));
  metrics.requests = contextRequests.length;
  metrics.pageResourceEntries = pageResources.length + 1;
  metrics.transferBytes = Math.round(pageResources.reduce((sum, entry) => sum + (entry.transferSize || 0), navigation?.transferSize || 0));
  metrics.requestBytes = contextRequests.reduce((sum, request) => sum + (request.bytes || 0), 0);
  const hostItems = hostLog ? (await hostLog.since(hostSeq)).filter(item => item.t <= cutoffWall + 5) : [];
  if (hostLog) { metrics.hostRequests = hostItems.length; metrics.hostWebSockets = hostItems.filter(item => item.ws).length; }
  const waterfall = buildWaterfall({ navigation, contextRequests, resources: pageResources, timeOrigin, doneAt });
  metrics.idleGapMs = waterfall.idleGapMs;
  return { metrics, marks, timedOut, notes: snapshot.notes, perf: snapshot.perf, waterfall, hostItems, timeOrigin };
}

const shortUrl = url => {
  try {
    const parsed = new URL(url);
    const where = /\.pages\.localhost$/.test(parsed.hostname) ? 'page' : parsed.hostname.split('.')[0];
    const path = parsed.pathname.replace(/[a-f0-9]{64}/g, m => m.slice(0, 8) + '…').replace(/\/s\/[a-z2-7]{20,}\//, '/s/:token/');
    return `${where} ${path}${parsed.search ? '?' + parsed.search.slice(1, 40) : ''}`;
  } catch { return url.slice(0, 120); }
};

/** Requests ordered by start (ms since timeOrigin), with in-flight gaps. */
export function buildWaterfall({ navigation, contextRequests, resources, timeOrigin, doneAt = null }) {
  // Match each request to the page Resource Timing entry for the same URL that started closest to it
  // (worker requests have no page entry).
  const byName = new Map();
  for (const entry of resources) { let list = byName.get(entry.name); if (!list) byName.set(entry.name, list = []); list.push(entry); }
  const rows = contextRequests.map(request => {
    const candidates = request.frame ? byName.get(request.url) ?? [] : [];
    let entry = candidates.reduce((best, entry) => !best || Math.abs(entry.startTime - request.start) < Math.abs(best.startTime - request.start) ? entry : best, null);
    if (entry && Math.abs(entry.startTime - request.start) > 50) entry = null;
    const duration = request.end >= 0 ? request.end : null;
    return { start: round(request.start), duration: duration === null ? null : round(duration),
      ttfb: request.ttfb >= 0 ? round(request.ttfb) : null, type: request.type, worker: !request.frame,
      status: request.status, bytes: request.bytes, cached: entry ? entry.transferSize === 0 && entry.decodedBodySize > 0 : null,
      serverTiming: request.serverTiming, url: shortUrl(request.url), failure: request.failure };
  }).sort((a, b) => a.start - b.start);
  if (navigation && !rows.some(row => row.type === 'document'))
    rows.unshift({ start: round(navigation.startTime), duration: round(navigation.responseEnd - navigation.startTime), ttfb: round(navigation.responseStart),
      type: 'document', status: navigation.responseStatus ?? null, bytes: navigation.transferSize, url: shortUrl(navigation.name) });
  // Gaps where no recorded request was in flight (main-thread/worker CPU or timers).
  let busyUntil = 0, idleGapMs = 0; const gaps = [];
  for (const row of rows) {
    if (row.start > busyUntil + 1) { const gap = row.start - busyUntil; idleGapMs += gap; if (gap >= 20) gaps.push({ from: round(busyUntil), to: row.start, ms: round(gap) }); }
    busyUntil = Math.max(busyUntil, row.start + (row.duration ?? 0));
  }
  // Tail: nothing in flight between the last response and the milestone.
  if (doneAt !== null && doneAt > busyUntil + 1) {
    const gap = doneAt - busyUntil; idleGapMs += gap; if (gap >= 20) gaps.push({ from: round(busyUntil), to: round(doneAt), ms: round(gap), tail: true });
  }
  return { rows, gaps, idleGapMs: round(idleGapMs), timeOrigin };
}
const round = value => Math.round(value * 10) / 10;
