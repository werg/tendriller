import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createFaults } from './faults.mjs';
import { createBrowserNetworkControls } from './browser-controls.mjs';
import { runNetworkScenario } from './scenarios.mjs';
import { activityTimeline, counterDelta, assertDirectWork } from './evidence.mjs';
import { progressWriter } from './idle-progress.mjs';
import { waitForDirectEvidence } from './wait-direct.mjs';

export function currentOperationApplied(priorOperation, operationId, status) {
  return typeof operationId === 'string' && operationId.length > 0 && operationId !== priorOperation &&
    typeof status === 'string' && status.includes(`Operation: ${operationId}\n`) &&
    status.includes('Materialized locally: accepted') && /Retained by peers: [a-f0-9]{64}/u.test(status);
}

export function assertHiddenDirectPath(before, after) {
  assert.equal(before.kind, 'direct');
  assert.equal(after.kind, 'direct', 'Hidden work lost authenticated direct transport');
  assert.equal(after.connectionRevision, before.connectionRevision, 'Hidden work replaced the authenticated connection');
  const delta = counterDelta(before, after);
  assert.equal(delta.relayBytes, 0, 'Hidden work used relay fallback payload');
  return delta;
}

export async function qualifyFirstAppNetwork({ page, context, peer, expect, transportCounters,
  evidencePng, browserDevice, sha256, profile, faults = createFaults() }) {
  const browser = await createBrowserNetworkControls(page);
  const timeline = activityTimeline();
  let cleaned = false;
  let retained;
  let reopenProof;
  let backgroundProof;
  let hiddenNote;
  let initialRouteEvidence;
  let hostTraffic;
  let setupReadiness;
  const routeWaits = [];
  const adapter = {
    faults, ...browser,
    async background(options) {
      const transportBefore = await adapter.snapshot(options);
      assert.equal(transportBefore.kind, 'direct');
      const result = await browser.background({ ...options, onHidden: async ({ signal }) => {
        const started = performance.now();
        const before = await browser.diagnostics();
        backgroundProof = { hiddenBefore: await page.evaluate(() => document.hidden),
          hiddenAfter: null, nativeApplied: false, publicAppliedReadWhileHidden: false, signalRows: null,
          navigationsBefore: before.navigations, completed: false,
          signalBoundMs: 5000, remoteReadBoundMs: 15000,
          readScope: 'coherent-public-local-event-view',
          beforeRevision: transportBefore.connectionRevision };
        assert.equal(backgroundProof.hiddenBefore, true);
        const operationId = randomUUID(), text = `Hidden native ${operationId}`;
        hiddenNote = { operationId, text };
        const signalWork = page.evaluate(async () => {
          if (!document.hidden) throw Error('NETWORK_LAB_NOT_HIDDEN');
          const value = await window.appRequests.request('rows', { count: 2, width: 100 }, { timeoutMs: 5000 });
          return { rows: value.rows.length, hidden: document.hidden };
        }).then(value => {
          backgroundProof.signalRows = value.rows; backgroundProof.signalReturnedWhileHidden = value.hidden;
          backgroundProof.signalElapsedMs = performance.now() - started;
          assert.equal(value.rows, 2); assert.equal(value.hidden, true);
          backgroundProof.signalSucceeded = true;
        }).catch(error => {
          backgroundProof.signalSucceeded = false; backgroundProof.signalElapsedMs = performance.now() - started;
          throw error;
        });
        const commandWork = (async () => {
          await peer.request('command', { text, operationId });
          backgroundProof.nativeApplied = true; backgroundProof.nativeAppliedMs = performance.now() - started;
          const reading = performance.now();
          try { await expect.poll(() => page.evaluate(async ({ text, operationId }) => {
            if (!document.hidden) throw Error('NETWORK_LAB_NOT_HIDDEN');
            const application = await window.tendril.application.ready();
            const view = await application.readView({ view: 'local' });
            try {
              const batch = await view.readEvents({ topics: ['note.put','note.deleted'], limit: 128 });
              if (!document.hidden) throw Error('NETWORK_LAB_NOT_HIDDEN');
              if (batch.hasMore) throw Error('NETWORK_LAB_EVENT_READ_LIMIT');
              return batch.events.some(event=>event.operationId===operationId&&event.topic==='note.put'&&event.payload?.text===text);
            } finally { await view.release(); }
          }, { text, operationId }), { timeout: 15_000 }).toBe(true);
          } finally { backgroundProof.publicReadElapsedMs = performance.now() - reading; }
          backgroundProof.publicAppliedReadWhileHidden = true;
        })();
        const results = await Promise.allSettled([signalWork, commandWork]);
        if (results[1].status === 'fulfilled') {
          await expect.poll(async () => (await peer.request('transport-snapshot')).receivedReliableBytes, { timeout: 5000 })
            .toBeGreaterThan(transportBefore.receivedReliableBytes);
        }
        backgroundProof.hiddenAfter = await page.evaluate(() => document.hidden);
        const after = await browser.diagnostics();
        const transportAfter = await adapter.snapshot({ signal });
        backgroundProof.navigationsAfter = after.navigations;
        backgroundProof.elapsedMs = performance.now() - started;
        backgroundProof.afterRevision = transportAfter.connectionRevision;
        backgroundProof.beforeKind = transportBefore.kind; backgroundProof.afterKind = transportAfter.kind;
        backgroundProof.relayPayloadDelta = transportAfter.relayBytes - transportBefore.relayBytes;
        backgroundProof.hostMetadataRequestDelta = transportAfter.hostRequests - transportBefore.hostRequests;
        signal.throwIfAborted();
        assert.equal(backgroundProof.hiddenAfter, true);
        assert.equal(after.navigations, before.navigations, 'Hidden application work replaced the document');
        backgroundProof.transportDelta = assertHiddenDirectPath(transportBefore, transportAfter);
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        assertDirectWork(transportBefore, transportAfter);
        backgroundProof.completed = true;
        return backgroundProof;
      } });
      if (result.hiddenObserved) {
        assert.equal(await page.evaluate(() => document.hidden), false);
        await expect(page.locator('#notes li').filter({ hasText: hiddenNote.text })).toHaveCount(1, { timeout: 15_000 });
        backgroundProof.foregroundDomVerified = true;
      }
      return result;
    },
    async setOffline(value, options) {
      if (value) await faults.blockApplicationNetwork();
      else await faults.restoreUdp();
      await browser.setOffline(value, options);
    },
    async waitForDisconnected({ signal }) {
      signal.throwIfAborted();
      // Generate real traffic to expose the partition; merely waiting on idle
      // RTC would qualify no failure detector at all.
      const probe = page.evaluate(() => window.appRequests.request('rows', { count: 2, width: 100 }).then(() => true, () => false));
      await Promise.all([peer.request('transport-wait', { kind: 'unknown' }, 60_000), probe]);
      signal.throwIfAborted();
    },
    async snapshot({ signal }) {
      signal.throwIfAborted();
      const [host, link] = await Promise.all([transportCounters(), peer.request('transport-snapshot')]);
      // Reuse the required counter read: never add traffic or idle probes.
      hostTraffic = { observedAt: Date.now(), httpRequests: host.httpRequests, requestActivity: host.requestActivity };
      return { instance: `${host.instance}:${link.connectionRevision}`, kind: link.kind,
        connectionRevision: link.connectionRevision, browserLinks: link.browserLinks, otherLinks: link.otherLinks,
        hostRequests: host.httpRequests, relayBytes: host.relayBinaryBytes,
        ...Object.fromEntries(['sentReliableBytes', 'receivedReliableBytes', 'sentLiveBytes', 'receivedLiveBytes'].map(key => [key, link[key]])) };
    },
    async waitForDirect({ signal }) {
      signal.throwIfAborted();
      const evidence = { expectedKind: 'direct' };
      if (routeWaits.length < 16) routeWaits.push(evidence);
      try {
        await waitForDirectEvidence({
          evidence,
          snapshot: () => peer.request('transport-snapshot'),
          wait: () => peer.request('transport-wait', { kind: 'direct' }, 60_000),
          counters: async () => {
            // Keep the bounded activity ring once per profile, rather than
            // duplicating it in every route-wait/progress counter observation.
            const { requestActivity, ...counters } = await transportCounters();
            hostTraffic = { observedAt: Date.now(), httpRequests: counters.httpRequests, requestActivity };
            return counters;
          },
          publish: process.env.NETWORK_LAB_PROGRESS ? routeEvidence =>
            progressWriter(process.env.NETWORK_LAB_PROGRESS)({
              state: routeEvidence.completed && !routeEvidence.diagnosticFailed ?
                'authenticated-direct-ready' : 'authenticated-direct-failed',
              profile, at: new Date().toISOString(), routeEvidence }) : undefined,
        });
      } catch (error) {
        initialRouteEvidence = evidence;
        throw error;
      }
      signal.throwIfAborted();
    },
    async exercise({ signal }) {
      signal.throwIfAborted();
      await page.bringToFront();
      const before = (await peer.request('query')).value;
      const nativeOperation = randomUUID();
      const nativeText = `Network native ${nativeOperation}`;
      await peer.request('command', { text: nativeText, operationId: nativeOperation });
      await expect(page.locator('#notes li').filter({ hasText: nativeText })).toHaveCount(1, { timeout: 15_000 });
      await expect(page.locator('#connection-status')).toContainText('Local signing and storage ready', { timeout: 30_000 });
      const text = `Network browser ${randomUUID()}`;
      const priorOperation = await page.locator('#operation-id').inputValue();
      await page.locator('#new').click(); await page.locator('#note').fill(text);
      await page.locator('#submit').click();
      await expect.poll(() => page.locator('#operation-id').inputValue(), { timeout: 30_000 }).not.toBe(priorOperation);
      const operationId = await page.locator('#operation-id').inputValue();
      assert.ok(operationId);
      await expect(page.locator('#operation-status')).toContainText('Materialized locally: accepted', { timeout: 30_000 });
      await expect.poll(async () => {
        const status = await page.locator('#operation-status').textContent();
        return currentOperationApplied(priorOperation, operationId, status);
      }, { timeout: 30_000 }).toBe(true);
      await expect.poll(async () => (await peer.request('query')).value.some(row =>
        row.operationId === operationId && row.text === text && row.author === browserDevice), { timeout: 15_000 }).toBe(true);
      const rows = (await peer.request('query')).value;
      assert.equal(rows.length, before.length + 2);
      assert.ok(rows.some(row => row.operationId === nativeOperation && row.text === nativeText));
      assert.ok(rows.some(row => row.operationId === operationId && row.text === text && row.author === browserDevice));

      const answer = await page.evaluate(() => window.appRequests.request('rows', { count: 2, width: 100 }).then(value => value.rows.length));
      assert.equal(answer, 2, 'Real signal request/reply did not survive');
      const inferenceBefore = await peer.request('inference-status');
      await page.locator('#media-file').setInputFiles({ name: 'network-evidence.png', mimeType: 'image/png', buffer: evidencePng });
      await page.locator('#media-share').check();
      await page.locator('#media-analyze').click();
      await expect.poll(async () => (await peer.request('inference-status')).calls, { timeout: 30_000 }).toBe(inferenceBefore.calls + 1);
      await expect(page.locator('#media-suggestion')).toContainText('Suggested fixture observation', { timeout: 30_000 });
      const inferenceAfter = await peer.request('inference-status');
      assert.equal(inferenceAfter.source.sha256, sha256(evidencePng), 'Encrypted sensor bytes changed');
      assert.deepEqual((await peer.request('query')).value, rows, 'Sensor analysis must not create a domain command');
      retained = { operationId, rows };
      signal.throwIfAborted();
      return { commandApplied: true, remoteRead: true, operationIdentityPreserved: true, signalDelivered: true, cameraDelivered: true };
    },
    async reloadAndVerify({ signal }) {
      signal.throwIfAborted();
      assert.ok(retained);
      const previous = await peer.request('transport-snapshot');
      assert.equal(previous.browserLinks, 1);
      assert.equal(previous.otherLinks, 0);
      const reopening = performance.now();
      reopenProof = { beforeRevision: previous.connectionRevision, beforeBrowserLinks: previous.browserLinks,
        otherLinks: previous.otherLinks, completed: false,
        scope: 'reload-to-fresh-direct-and-new-document-signal' };
      try {
      await page.reload();
      await expect(page.locator('#public-key')).toHaveValue(browserDevice, { timeout: 30_000 });
      await expect(page.locator('#notes li')).toHaveCount(retained.rows.length, { timeout: 30_000 });
      assert.equal(await page.locator('#operation-id').inputValue(), retained.operationId);
      assert.deepEqual((await peer.request('query')).value, retained.rows);
      // Stored notes and the device field can render before peer reattachment.
      // A cached old direct link is insufficient: wait for its replacement, then
      // prove the new document's end-to-end signal route before timing commands.
      const current = await peer.request('transport-wait', { kind: 'direct', afterRevision: previous.connectionRevision }, 60_000);
      assert.ok(current.connectionRevision > previous.connectionRevision);
      assert.equal(current.browserLinks, 1);
      assert.equal(current.otherLinks, 0);
      await expect(page.locator('#connection-status')).toContainText('Local signing and storage ready', { timeout: 30_000 });
      const rows = await page.evaluate(() => window.appRequests.request('rows', { count: 2, width: 100 }).then(value => value.rows.length));
      assert.equal(rows, 2);
      Object.assign(reopenProof, { afterRevision: current.connectionRevision, afterBrowserLinks: current.browserLinks,
        signalRows: rows, completed: true, elapsedMs: performance.now() - reopening });
      } catch (error) { reopenProof.elapsedMs = performance.now() - reopening; throw error; }
      signal.throwIfAborted();
      // Repeat signal and sensor work after reopen; this also proves that the
      // retained application session remains usable, rather than a DOM cache.
      return adapter.exercise({ signal });
    },
    async settle({ signal }) {
      signal.throwIfAborted();
      await expect(page.locator('#connection-status')).toContainText('Local signing and storage ready', { timeout: 30_000 });
      await peer.request('query');
      // The optional native participant must still hold its local storage and key
      // prerequisites. Peer routes and finality are reported separately, never required here.
      setupReadiness = await peer.request('setup-ready', {}, 60_000);
      assert.equal(setupReadiness.after.ready, true);
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      const results = await Promise.allSettled([browser.cleanup(), faults.close()]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'NETWORK_LAB_APPLICATION_CLEANUP_FAILED');
    },
  };
  try {
    await adapter.waitForDirect({ signal: AbortSignal.timeout(60_000) });
    if (profile === 'relay-upgrade') {
      const initial = await adapter.snapshot({ signal: AbortSignal.timeout(5000) });
      assert.equal(initial.kind, 'direct', 'Round trip must start on authenticated direct transport');
      timeline.record('startup', 'direct');
      await faults.blockUdp();
      timeline.record('blocked', 'fault-on');
      // Real application traffic exposes the packet black hole. No fake RTC
      // constructor, forced connection.close(), or controller call is allowed.
      // A disposable request may time out during this boundary; durable commands
      // are exercised and checked after the authenticated fallback is established.
      const request = page.evaluate(() => window.appRequests.request('rows', { count: 2, width: 100 })
        .then(() => true, () => false));
      await Promise.all([peer.request('transport-wait', { kind: 'relay' }, 60_000), request]);
      timeline.record('blocked', 'relay');
    }
    const report = await runNetworkScenario(adapter, { profile, phaseMs: 60_000,
      idleMs: Number(process.env.NETWORK_LAB_IDLE_MS ?? 15_000), timeline,
      onProgress: progressWriter(process.env.NETWORK_LAB_PROGRESS) });
    report.sensorScope = 'Immutable PNG fixture carried by real encrypted content/inference signals; deterministic native inference, no physical camera/provider billing qualification.';
    report.reopenProof = reopenProof;
    report.backgroundProof = backgroundProof;
    report.routeWaits = routeWaits;
    report.hostTraffic = hostTraffic;
    report.setupReadiness = setupReadiness;
    assert.equal(report.success, true, 'Requested network profile is unsupported in this browser');
    return report;
  } catch (error) {
    if (!error.networkReport) {
      timeline.record('blocked', 'failure');
      error.networkReport = { version: 1, profile, success: false,
        scope: 'sealed-first-app-browser-network-emulation', timeline: timeline.snapshot() };
    }
    if (reopenProof) error.networkReport.reopenProof = reopenProof;
    if (backgroundProof) error.networkReport.backgroundProof = backgroundProof;
    if (initialRouteEvidence) error.networkReport.routeEvidence = initialRouteEvidence;
    error.networkReport.routeWaits = routeWaits;
    error.networkReport.hostTraffic = hostTraffic;
    error.networkReport.setupReadiness = setupReadiness;
    throw error;
  } finally { await adapter.cleanup(); }
}
