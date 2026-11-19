import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mountReviewedMedia } from '../../docs/tutorial/media/panel.mjs';

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
function panel(t, { prepareCommit, commit }) {
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
  const runtime = { on: () => () => {}, sensors: {
    status: () => ({ active: [], pending: [] }), on: () => () => {}, stopAll() {},
  } };
  const controls = mountReviewedMedia({ container: { querySelector: $ }, runtime, session: {},
    nativeDeviceId: 'a'.repeat(64), getContext: () => ({ revision: { sequence: 1 } }),
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
  return { $, controls, click, edit,
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
      return { status: 'applied', outcome: 'accepted', operationId: value.operationId };
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
  await until(() => ui.$('#media-result').textContent.includes('Applied: accepted'));
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

test('an uncertain review stays locked until its original operation or explicit reapplication lineage is applied', async t => {
  const submitted = [];
  const ui = panel(t, {
    async prepareCommit() {},
    async commit(value) { submitted.push(value); throw Error('The response wait ended.'); },
  });
  await ui.choose(); ui.edit('Uncertain observation'); ui.click('#media-commit');
  await until(() => submitted.length === 1 && ui.$('#media-result').textContent.includes('response wait ended'));
  assert.equal(ui.$('#media-review').readOnly, true);
  assert.equal(ui.$('#media-new').disabled, true);
  const applied = { status: 'applied', outcome: 'accepted', operationId: 'explicit-reapplication' };
  ui.controls.resolved(applied);
  assert.equal(ui.$('#media-new').disabled, true, 'An unrelated applied operation cannot resolve this review.');
  ui.controls.resolved({ ...applied, status: 'saved' }, submitted[0].operationId);
  assert.equal(ui.$('#media-new').disabled, true, 'Saved does not establish applied execution.');
  ui.controls.resolved(applied, submitted[0].operationId);
  assert.equal(ui.$('#media-new').disabled, false);
  ui.click('#media-new');
  assert.equal(ui.$('#media-preview').hidden, true);
  assert.equal(ui.$('#media-review').readOnly, false);
  assert.equal(submitted.length, 1, 'Resolving the UI never retries or reapplies a command itself.');
});
