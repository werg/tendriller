import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubmissionState } from '../../docs/tutorial/helpers/submission-state.mjs';
const status = { phase: 'ready', database: 'ready', generation: 'g' };
const read = { revision: { generation: 'g' }, value: [] };
function ready(ui) {
  ui.update({ attached: true }); ui.application(status);
  ui.participation({ phase: 'following' }); ui.read(read);
}
test('connection, current coherent read and recovery jointly gate submission', () => {
  const ui = createSubmissionState();
  assert.throws(() => ui.begin());
  ui.update({ attached: true }); ui.application(status);
  ui.read(read); ui.participation({ phase: 'following' });
  assert.equal(ui.snapshot.canSubmit, false);
  ui.read(read); assert.equal(ui.snapshot.canSubmit, true);
  for (const phase of ['connecting', 'recovering', 'approval-required', 'unavailable', 'closed']) {
    ui.participation({ phase }); assert.equal(ui.snapshot.canSubmit, false);
    ui.participation({ phase: 'following' }); assert.equal(ui.snapshot.canSubmit, false);
    ui.read(read); assert.equal(ui.snapshot.canSubmit, true);
  }
  ui.application({ ...status, generation: 'next' });
  ui.read(read); assert.equal(ui.snapshot.canSubmit, false);
  ui.read({ revision: { generation: 'next' } }); assert.equal(ui.snapshot.canSubmit, true);
});
test('pre-intent failure has draft advice; only retained operations have retry advice', () => {
  const ui = createSubmissionState(); ready(ui);
  const release = ui.begin(); assert.throws(() => ui.begin()); release();
  assert.match(ui.failure(Error('Read failed')), /No new operation was submitted/);
  assert.doesNotMatch(ui.failure(Error('Read failed')), /retry|displayed/);
  const pending = { id: 'original', input: { text: 'human draft' } };
  ui.update({ pending, selected: pending.id });
  assert.equal(ui.snapshot.canSubmit, false); assert.equal(ui.snapshot.canRetry, true);
  assert.match(ui.failure(Error('Lost reply'), pending), /retry this original operation/);
  ui.update({ observed: { status: 'applied', outcome: 'rejected' } });
  assert.equal(ui.snapshot.canRetry, false);
  ui.update({ observed: { status: 'needsReapply' } });
  assert.equal(ui.snapshot.canRetry, false); assert.equal(ui.snapshot.canReapply, true);
  ui.update({ selected: 'another' }); assert.equal(ui.snapshot.canReapply, false);
});
