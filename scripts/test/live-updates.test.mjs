import assert from 'node:assert/strict';
import test from 'node:test';
import { createDraftGuard, holdWhilePendingOperations } from '../../docs/tutorial/shared/helpers/live-updates.mjs';

function mockPublication() {
  const holds = new Map();
  const beforeReload = new Set();
  const listeners = new Set();
  let reloads = 0;

  return {
    get holdCount() { return holds.size; },
    get holdReasons() { return [...holds.values()]; },
    get reloads() { return reloads; },
    hold(reason) {
      const token = {};
      holds.set(token, reason);
      return () => { holds.delete(token); };
    },
    onBeforeReload(fn) {
      beforeReload.add(fn);
      return () => { beforeReload.delete(fn); };
    },
    onUpdate(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    update() { reloads += 1; },
    async simulateAutoReload(version = 2) {
      if (holds.size > 0) return false;
      for (const fn of [...beforeReload]) {
        const res = await fn({ version, kind: 'reload' });
        if (res === false) return false;
      }
      if (holds.size > 0) return false;
      reloads += 1;
      return true;
    },
  };
}

test('createDraftGuard holds while dirty, holds across holdWhile async saves, and flushes onBeforeReload', async () => {
  const pub = mockPublication();
  let dirty = false;
  let flushed = 0;

  const guard = createDraftGuard({
    publication: pub,
    isDirty: () => dirty,
    flush: async () => {
      flushed += 1;
      dirty = false;
    },
    reason: 'Editing document',
  });

  try {
    assert.equal(pub.holdCount, 0);
    dirty = true;
    guard.sync();
    assert.equal(pub.holdCount, 1);
    assert.deepEqual(pub.holdReasons, ['Editing document']);
    assert.equal(await pub.simulateAutoReload(2), false);

    // Clearing dirty releases hold; onBeforeReload flushes before reload.
    dirty = false;
    guard.sync();
    assert.equal(pub.holdCount, 0);

    // Even if dirty flips true right before reload without sync(), flush clears it and allows reload.
    dirty = true;
    assert.equal(await pub.simulateAutoReload(2), true);
    assert.equal(flushed, 1);
    assert.equal(pub.reloads, 1);

    // holdWhile keeps reload deferred while an async save is running.
    let resolveSave;
    const saveDone = guard.holdWhile(() => new Promise((r) => { resolveSave = r; }));
    assert.equal(pub.holdCount, 1);
    assert.equal(await pub.simulateAutoReload(3), false);
    resolveSave('ok');
    assert.equal(await saveDone, 'ok');
    assert.equal(pub.holdCount, 0);
    assert.equal(await pub.simulateAutoReload(3), true);
    assert.equal(pub.reloads, 2);
  } finally {
    guard.close();
  }
  assert.equal(pub.holdCount, 0);
});

test('createDraftGuard vetoes automatic reload if work stays dirty after flush', async () => {
  const pub = mockPublication();
  let dirty = true;
  const guard = createDraftGuard({
    publication: pub,
    isDirty: () => dirty,
    flush: async () => { /* Still unsaved (e.g. user still actively editing) */ },
  });

  try {
    // Simulate a case where hold wasn't synced yet — onBeforeReload still vetoes and re-syncs hold!
    dirty = false;
    guard.sync();
    dirty = true;
    assert.equal(await pub.simulateAutoReload(2), false);
    assert.equal(pub.reloads, 0);
    assert.equal(pub.holdCount, 1);
  } finally {
    guard.close();
  }
});

test('holdWhilePendingOperations holds live reloads until Chronolog commands materialize', async () => {
  const pub = mockPublication();
  let finishMat;
  const session = {
    async command(name, input) {
      return {
        name,
        input,
        materialized: () => new Promise((r) => { finishMat = r; }),
      };
    },
  };

  const tracker = holdWhilePendingOperations(session, { publication: pub });
  try {
    const p = tracker.runCommand('putEdit', { key: 'a', after: 'b' });
    // Let command() resolve and pause on materialized().
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(tracker.pendingCount, 1);
    assert.equal(pub.holdCount, 1);
    assert.equal(await pub.simulateAutoReload(2), false);

    finishMat({ outcome: 'accepted' });
    await p;
    assert.equal(tracker.pendingCount, 0);
    assert.equal(pub.holdCount, 0);
    assert.equal(await pub.simulateAutoReload(2), true);
  } finally {
    tracker.close();
  }
});
