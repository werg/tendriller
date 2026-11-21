import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyFirstAppNetwork } from './first-app.mjs';

for (const finalCounterFails of [false, true]) {
  test(`initial route failure retains host receipts without snapshot or extra reads (final counters fail=${finalCounterFails})`, async () => {
    const failure = Error('direct route timeout');
    const frame = {};
    let counterReads = 0, faultCleanup = 0, peerReads = 0;
    const registration = { dispose: async () => {} };
    const page = {
      url: () => 'https://example.invalid/', mainFrame: () => frame,
      evaluate: async () => null, on() {}, off() {},
      exposeBinding: async () => registration, addInitScript: async () => registration,
      context: () => ({ setOffline: async () => {}, newCDPSession: async () => ({ send: async () => {}, detach: async () => {} }) }),
    };
    const receipt = { sequence: 1, receivedAt: 1234, method: 'GET', category: 'discovery-watch' };
    const extraReceipt = { sequence: 2, receivedAt: 1235, method: 'GET', category: 'invitations' };
    const started = Date.now();
    await assert.rejects(qualifyFirstAppNetwork({
      page, profile: 'offline', faults: { close: async () => { faultCleanup++; } },
      // Any call beyond the initial route wait would require the real app/UI.
      expect: () => assert.fail('must not reach scenario or application snapshots'),
      peer: { request: async action => {
        if (action === 'transport-wait') throw failure;
        assert.equal(action, 'transport-snapshot'); peerReads++;
        return { kind: 'unknown', connectionRevision: 0, browserLinks: 0, otherLinks: 0 };
      } },
      transportCounters: async () => {
        counterReads++;
        if (finalCounterFails && counterReads === 2) throw Error('counter read failed');
        return { instance: 'private-epoch', httpRequests: counterReads,
          requestActivity: { items: counterReads === 1 ? [receipt] : [receipt, extraReceipt], dropped: 0 } };
      },
    }), error => {
      assert.equal(error, failure);
      const report = error.networkReport;
      assert.equal(report.success, false);
      assert.ok(report.hostTraffic.observedAt >= started);
      assert.equal(report.hostTraffic.httpRequests, finalCounterFails ? 1 : 2);
      assert.deepEqual(report.hostTraffic.requestActivity.items, finalCounterFails ? [receipt] : [receipt, extraReceipt]);
      assert.equal(report.routeEvidence.completed, false);
      assert.equal(report.routeEvidence.hostBefore.requestActivity, undefined);
      assert.equal(report.routeEvidence.hostAfter?.requestActivity, undefined);
      assert.equal(report.routeEvidence.diagnosticFailures.hostAfter, finalCounterFails ? true : undefined);
      assert.ok(!JSON.stringify(report).includes('private-epoch'));
      return true;
    });
    assert.equal(counterReads, 2, 'receipt retention must not add host calls');
    assert.equal(peerReads, 2, 'only initial/failure route snapshots');
    assert.equal(faultCleanup, 1);
  });
}
