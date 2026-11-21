import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFaults } from './faults.mjs';
import { createBrowserNetworkControls } from './browser-controls.mjs';
import { runNetworkScenario } from './scenarios.mjs';
import { activityTimeline } from './evidence.mjs';

export async function qualifyFirstAppNetwork({ page, context, peer, expect, transportCounters,
  evidencePng, browserDevice, sha256, profile }) {
  const faults = createFaults();
  const browser = await createBrowserNetworkControls(page);
  const timeline = activityTimeline();
  let cleaned = false;
  let retained;
  const adapter = {
    faults, ...browser,
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
      return { instance: `${host.instance}:${link.connectionRevision}`, kind: link.kind,
        hostRequests: host.httpRequests, relayBytes: host.relayBinaryBytes,
        ...Object.fromEntries(['sentReliableBytes', 'receivedReliableBytes', 'sentLiveBytes', 'receivedLiveBytes'].map(key => [key, link[key]])) };
    },
    async waitForDirect({ signal }) {
      signal.throwIfAborted();
      await peer.request('transport-wait', { kind: 'direct' }, 60_000);
      signal.throwIfAborted();
    },
    async exercise({ signal }) {
      signal.throwIfAborted();
      const before = (await peer.request('query')).value;
      const nativeOperation = randomUUID();
      const nativeText = `Network native ${nativeOperation}`;
      await peer.request('command', { text: nativeText, operationId: nativeOperation });
      await expect(page.locator('#notes li').filter({ hasText: nativeText })).toHaveCount(1, { timeout: 15_000 });
      await expect(page.locator('#data-status')).toContainText('Data: ready; application: ready', { timeout: 30_000 });
      const text = `Network browser ${randomUUID()}`;
      await page.locator('#note').fill(text);
      await page.locator('#submit').click();
      await expect(page.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
      await expect(page.locator('#operation-status')).toContainText('peer retention receipt(s) observed', { timeout: 30_000 });
      const operationId = await page.locator('#operation-id').inputValue();
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
      await page.reload();
      await expect(page.locator('#device-key')).toHaveValue(browserDevice, { timeout: 30_000 });
      await expect(page.locator('#notes li')).toHaveCount(retained.rows.length, { timeout: 30_000 });
      assert.equal(await page.locator('#operation-id').inputValue(), retained.operationId);
      assert.deepEqual((await peer.request('query')).value, retained.rows);
      // Repeat signal and sensor work after reopen; this also proves that the
      // retained application session remains usable, rather than a DOM cache.
      return adapter.exercise({ signal });
    },
    async settle({ signal }) {
      signal.throwIfAborted();
      await expect(page.locator('#data-status')).toContainText('Data: ready; application: ready', { timeout: 30_000 });
      await peer.request('query');
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
      idleMs: Number(process.env.NETWORK_LAB_IDLE_MS ?? 15_000), timeline });
    report.sensorScope = 'Immutable PNG fixture carried by real encrypted content/inference signals; deterministic native inference, no physical camera/provider billing qualification.';
    assert.equal(report.success, true, 'Requested network profile is unsupported in this browser');
    return report;
  } catch (error) {
    if (!error.networkReport) {
      timeline.record('blocked', 'failure');
      error.networkReport = { version: 1, profile, success: false,
        scope: 'sealed-first-app-browser-network-emulation', timeline: timeline.snapshot() };
    }
    throw error;
  } finally { await adapter.cleanup(); }
}
