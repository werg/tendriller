import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mountReviewedMedia } from '../../docs/tutorial/shared/media/panel.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'The media panel did not reach the expected state.');
    await setImmediate();
  }
}
function panel(t, { prepareCommit, commit, capabilities = async () => ({ capabilities: {
  camera: { available: true, permission: 'prompt' }, microphone: { available: true, permission: 'prompt' },
} }) }) {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = new EventTarget();
  const previousGlobals = new Map();
  for (const [name, value] of Object.entries({ document, window })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    previousGlobals.set(name, descriptor);
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  class Element extends EventTarget {
    value = ''; textContent = ''; checked = false; hidden = true; disabled = false; readOnly = false;
    files = []; srcObject = null;
    play() { return Promise.resolve(); }
    pause() {}
    removeAttribute(name) { delete this[name]; }
  }
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const callbacks = new Map();
  const runtime = { capabilities, on(name, callback) { callbacks.set(name, callback); return () => callbacks.delete(name); }, sensors: {
    status: () => ({ active: [], pending: [] }), on: () => () => {}, stopAll() {},
  } };
  const controls = mountReviewedMedia({ container: { querySelector: $ }, runtime, session: {},
    inferenceParticipantKey: 'a'.repeat(64), getContext: () => ({ revision: { sequence: 1 } }),
    prepareCommit, commit, onVoiceDraft() {},
  });
  t.after(() => {
    try { controls.close(); }
    finally {
      for (const [name, descriptor] of previousGlobals)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
    }
  });
  const click = id => $(id).dispatchEvent(new Event('click'));
  const edit = text => { $('#media-review').value = text; $('#media-review').dispatchEvent(new Event('input')); };
  return { $, controls, click, edit, emit: name => callbacks.get(name)?.(),
    async choose() {
      $('#media-file').files = [new Blob(['photo'], { type: 'image/png' })];
      $('#media-file').dispatchEvent(new Event('change'));
      await until(() => !$('#media-preview').hidden);
    },
  };
}

test('a failed preparation leaves reviewed input editable; a later preparation freezes the exact command input', async t => {
  const prepared = [], submitted = [], second = deferred();
  const ui = panel(t, {
    async prepareCommit(value) {
      prepared.push(value);
      if (prepared.length === 1) throw Error('Content staging failed before command dispatch.');
      await second.promise;
    },
    async commit(value) {
      submitted.push(value);
      return { stored: true, materialized: { outcome: 'accepted' }, operationId: value.operationId };
    },
  });
  await ui.choose(); ui.edit('First human review'); ui.click('#media-commit');
  await until(() => ui.$('#media-result').textContent.includes('Content staging failed'));
  assert.equal(submitted.length, 0);
  assert.equal(ui.$('#media-review').readOnly, false);
  assert.equal(ui.$('#media-commit').disabled, false);

  ui.edit('Revised human review'); ui.click('#media-commit');
  await until(() => prepared.length === 2);
  assert.equal(ui.$('#media-review').readOnly, true);
  assert.equal(ui.$('#media-commit').disabled, true);
  // Synthetic input bypasses the browser's readOnly behavior. The handler must
  // still preserve the reviewed values already sent to preparation.
  ui.edit('Late synthetic edit');
  second.resolve();
  await until(() => ui.$('#media-result').textContent.includes('Stored locally. Current materialization: accepted (revisable).'));
  assert.match(ui.$('#media-result').textContent, /Peer retention and finality are separate\./);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].reviewed.text, 'Revised human review');
  assert.equal(submitted[0].candidate.id, prepared[1].candidate.id);
  assert.equal(submitted[0].operationId, prepared[1].operationId);
  assert.equal(ui.$('#media-review').readOnly, true);
  assert.equal(ui.$('#media-new').disabled, false);
});

test('discarding while content preparation is pending prevents a late command', async t => {
  const preparation = deferred(), prepared = [], submitted = [];
  const ui = panel(t, {
    async prepareCommit(value) { prepared.push(value); await preparation.promise; },
    async commit(value) { submitted.push(value); return {}; },
  });
  await ui.choose(); ui.edit('Cancelled observation'); ui.click('#media-commit');
  await until(() => prepared.length === 1);
  ui.click('#media-cancel');
  assert.equal(prepared[0].signal.aborted, true);
  assert.equal(ui.$('#media-preview').hidden, true);
  preparation.resolve(); await setImmediate(); await setImmediate();
  assert.equal(submitted.length, 0);
  assert.equal(ui.$('#media-result').textContent, 'No evidence command submitted.');
  await ui.choose();
  assert.equal(ui.$('#media-review').readOnly, false);
  assert.equal(ui.$('#media-commit').disabled, false);
});

test('an uncertain review accepts only its original durable acknowledgment, not unrelated work', async t => {
  const submitted = [], ui = panel(t, { prepareCommit: async () => {}, commit: async value => { submitted.push(value); throw Error('uncertain reply'); } });
  await ui.choose(); ui.edit('reviewed'); ui.click('#media-commit'); await until(() => submitted.length === 1);
  assert.equal(ui.$('#media-new').disabled, true);
  ui.controls.resolved({ stored: true, operationId: 'unrelated' }); assert.equal(ui.$('#media-new').disabled, true);
  ui.controls.resolved({ stored: true, operationId: submitted[0].operationId, materialized: null }); assert.equal(ui.$('#media-new').disabled, false, 'Local durability permits another review without waiting for peers or materialization');
});

test('capability gating inspects only camera and microphone and preserves file and typed fallbacks', async t => {
  const filters = [];
  const ui = panel(t, { prepareCommit: async () => {}, commit: async () => ({}),
    capabilities: async filter => { filters.push(filter); return { capabilities: {
      camera: { available: false, permission: 'unknown' }, microphone: { available: true, permission: 'denied' },
    } }; },
  });
  await until(() => ui.$('#media-camera').hidden);
  assert.deepEqual(filters, [['camera', 'microphone']]);
  assert.equal(ui.$('#media-file').disabled, false);
  assert.equal(ui.$('#voice-start').disabled, true);
  assert.match(ui.$('#voice-status').textContent, /Type a note/);
  await ui.choose(); ui.edit('Manual review without sensors');
  assert.equal(ui.$('#media-review').readOnly, false);
  assert.equal(ui.$('#media-commit').disabled, false);
});

test('failed or late capability inspection cannot enable closed controls', async t => {
  const inspected = deferred();
  const ui = panel(t, { prepareCommit: async () => {}, commit: async () => ({}), capabilities: () => inspected.promise });
  assert.equal(ui.$('#media-camera').disabled, true); assert.equal(ui.$('#media-file').disabled, false);
  ui.controls.close();
  inspected.resolve({ capabilities: { camera: { available: true, permission: 'granted' }, microphone: { available: true, permission: 'granted' } } });
  await setImmediate(); assert.equal(ui.$('#media-camera').disabled, true);
});


test('permission refresh updates task-relevant routes and late capability responses cannot reopen closed controls', async t => {
  const late = deferred(); let call = 0;
  const ui = panel(t, { prepareCommit: async () => {}, commit: async () => {}, capabilities: async () => {
    if (++call === 1) return { capabilities: { camera: { available: true, permission: 'denied' }, microphone: { available: false } } };
    return late.promise;
  } });
  await until(() => ui.$('#voice-start').hidden);
  assert.equal(ui.$('#media-camera').disabled, true);
  ui.emit('capabilities'); ui.controls.close();
  late.resolve({ capabilities: { camera: { available: true, permission: 'granted' }, microphone: { available: true } } });
  await setImmediate();
  assert.equal(ui.$('#media-camera').disabled, true);
  assert.equal(ui.$('#voice-start').hidden, true);
});

test('voice status recovers from checking text once microphone capability is available', async t => {
  const pending = deferred();
  const ui = panel(t, { prepareCommit: async () => {}, commit: async () => ({}), capabilities: () => pending.promise });
  assert.match(ui.$('#voice-status').textContent, /Checking browser support/);
  pending.resolve({ capabilities: {
    camera: { available: true, permission: 'prompt' },
    microphone: { available: true, permission: 'prompt' },
  } });
  await until(() => !ui.$('#voice-start').disabled);
  assert.doesNotMatch(ui.$('#voice-status').textContent, /Checking browser support/);
});
