import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [new URL('../src/utility.ts', import.meta.url).pathname],
  bundle: true, platform: 'browser', format: 'iife', globalName: 'Utility', write: false,
});
const context = {};
runInNewContext(compiled.outputFiles[0].text, context);
const summary = context.Utility.sensorSummary;

test('Page options preserves core labels and renders custom human-readable phases', () => {
  assert.equal(summary({ active: ['camera'], pending: ['microphone'] }).message, 'Camera active. Microphone request pending');
  const current = summary({
    active: ['camera', 'serial'],
    pending: ['bluetooth'],
    resources: [
      { id: '1', kind: 'serial', label: 'Bench meter', state: 'active' },
      { id: '2', kind: 'bluetooth', label: 'Scale', state: 'pending' },
    ],
  });
  assert.equal(current.message, 'Camera active. Bench meter active. Scale request pending');
  assert.deepEqual([...current.names], ['Camera', 'Bench meter', 'Scale']);
  assert.equal(current.canStop, true);
});

test('custom resources do not hide independently active or pending core sensors of the same kind', () => {
  const pendingCustom = summary({
    active: ['camera'],
    pending: ['camera'],
    resources: [{ id: '1', kind: 'camera', label: 'Document scan', state: 'pending' }],
  });
  assert.match(pendingCustom.message, /Camera active/);
  assert.match(pendingCustom.message, /Document scan request pending/);
  assert.equal(pendingCustom.canStop, true);

  const activeCustom = summary({
    active: ['microphone'],
    pending: ['microphone'],
    resources: [{ id: '1', kind: 'microphone', label: 'Clip recorder', state: 'active' }],
  });
  assert.match(activeCustom.message, /Microphone request pending/);
  assert.match(activeCustom.message, /Clip recorder active/);
});

test('asynchronous and failed cleanup stays visible with local labels without pretending shutdown completed', () => {
  for (const [state, phrase] of [['stopping', 'stopping'], ['failed', 'failed']]) {
    const current = summary({
      active: [],
      pending: [],
      resources: [{ id: '1', kind: 'usb', label: '<Bench meter>', state }],
    });
    assert.equal(current.message, '<Bench meter> ' + phrase);
    assert.equal(current.visible, true);
    assert.equal(current.canStop, true, 'an authored stopping/failed phase must still allow global cancellation');
  }
  const empty = summary({ active: [], pending: [] });
  assert.equal(empty.visible, false);
  assert.equal(empty.canStop, false);
});
