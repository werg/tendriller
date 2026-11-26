import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubmissionState } from '../../docs/tutorial/shared/helpers/submission-state.mjs';
function ready(ui) {
  ui.update({ attached: true });
  ui.application({ phase: 'ready', canAuthor: true });
}
test('only local signing and storage prerequisites gate submission, not connectivity or a successful view', () => {
  const ui = createSubmissionState();
  assert.throws(() => ui.begin());
  ui.update({ attached: true });
  assert.equal(ui.snapshot.canSubmit, false);
  ui.application({ phase: 'ready', canAuthor: false });
  assert.equal(ui.snapshot.canSubmit, false);
  ui.application({ phase: 'ready', canAuthor: true });
  assert.equal(ui.snapshot.canSubmit, true);
  assert.match(ui.snapshot.message, /including offline/);
  ui.update({ storageReady: false });
  assert.equal(ui.snapshot.canSubmit, false);
  ui.update({ storageReady: true });
  assert.equal(ui.snapshot.canSubmit, true);
  ui.application({ phase: 'closed', canAuthor: true });
  assert.equal(ui.snapshot.canSubmit, false);
});
test('uncertain submissions preserve draft advice and retry uses only the selected original intent', () => {
  const ui = createSubmissionState(); ready(ui);
  const release = ui.begin(); assert.throws(() => ui.begin()); release();
  assert.match(ui.failure(Error('Lost reply')), /No durable acknowledgment was received; keep your draft and inspect/);
  const pending = { operationId: 'original', input: { text: 'human draft' } };
  ui.update({ pending, selected: pending.operationId });
  assert.equal(ui.snapshot.canSubmit, true);
  assert.equal(ui.snapshot.canRetry, true);
  assert.match(ui.failure(Error('Lost reply'), pending), /retained operation original with its original input and ID/);
  ui.update({ selected: 'another' });
  assert.equal(ui.snapshot.canRetry, false);
  ui.update({ selected: pending.operationId, observed: { stored: true, materialized: { outcome: 'rejected' } } });
  assert.equal(ui.snapshot.canRetry, true);
  const endRetry = ui.begin('retry');
  assert.equal(ui.snapshot.canRetry, false);
  endRetry();
  ui.update({ observed: { stored: true, excluded: true } });
  assert.equal(ui.snapshot.canRetry, false);
  assert.equal(ui.snapshot.canInspect, true);
  assert.equal(ui.snapshot.canSubmit, true);
});
test('submission state distinguishes waiting-keys, waiting-approval, removed and read-only access', () => {
  const ui = createSubmissionState();
  ui.update({ attached: true });
  ui.application({ phase: 'ready', canAuthor: false });
  assert.match(ui.snapshot.message, /waiting to be admitted/);

  ui.admission({ phase: 'waiting-keys', members: [{ self: true, writer: true }] });
  assert.match(ui.snapshot.message, /waiting for the latest page key/);

  ui.admission({ phase: 'waiting-approval', members: [] });
  assert.match(ui.snapshot.message, /waiting for approval/);

  ui.admission({ phase: 'removed', members: [] });
  assert.match(ui.snapshot.message, /removed from the page/);

  ui.admission({ phase: 'admitted', members: [{ self: true, reader: true, writer: false }] });
  assert.equal(ui.snapshot.readOnly, true);
  assert.match(ui.snapshot.message, /read-only/);
});
