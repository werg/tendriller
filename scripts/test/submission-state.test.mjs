import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubmissionState } from '../../docs/tutorial/shared/helpers/submission-state.mjs';
const status = { phase: 'ready', database: 'ready', generation: 'g' };
const read = { revision: { generation: 'g' }, value: [] };
function ready(ui) {
  ui.update({ attached: true }); ui.application(status);
  ui.participation({ phase: 'following' }); ui.read(read);
}
test('a coherent local read gates saving; the connection gates only retry and reapply', () => {
  const ui = createSubmissionState();
  assert.throws(() => ui.begin());
  ui.update({ attached: true }); ui.application(status);
  assert.equal(ui.snapshot.canSubmit, false, 'No current read yet.');
  ui.read(read); assert.equal(ui.snapshot.canSubmit, true, 'Local saving needs no peer connection.');
  assert.equal(ui.snapshot.available, false); assert.match(ui.snapshot.message, /Saving on this device/);
  for (const phase of ['connecting', 'recovering', 'approval-required', 'unavailable', 'closed']) {
    ui.participation({ phase }); assert.equal(ui.snapshot.canSubmit, true, phase);
    assert.equal(ui.snapshot.connected, false);
    ui.participation({ phase: 'following' }); assert.equal(ui.snapshot.available, true);
  }
  const pending = { id: 'original' };
  ui.update({ pending, selected: pending.id });
  assert.equal(ui.snapshot.canRetry, true);
  ui.participation({ phase: 'connecting' }); assert.equal(ui.snapshot.canRetry, false, 'Retry reconciles with a peer.');
  ui.update({ pending: null, selected: '' }); ui.participation({ phase: 'following' });
  ui.application({ ...status, generation: 'next' });
  ui.read(read); assert.equal(ui.snapshot.canSubmit, false, 'A read from another generation is not coherent.');
  ui.read({ revision: { generation: 'next' } }); assert.equal(ui.snapshot.canSubmit, true);
  ui.application({ ...status, generation: 'next', phase: 'waiting' }); ui.read({ revision: { generation: 'next' } });
  assert.equal(ui.snapshot.canSubmit, true, 'A ready local replica waiting for its coordinator still saves.');
  ui.application({ ...status, generation: 'next', phase: 'recovering' }); assert.equal(ui.snapshot.canSubmit, false);
});
test('only an uncertain attempt blocks the next submission; a saved one does not', () => {
  const ui = createSubmissionState(); ready(ui);
  ui.participation({ phase: 'connecting' });
  ui.update({ pending: { id: 'offline' }, selected: 'offline', observed: null });
  assert.equal(ui.snapshot.canSubmit, false, 'No saved state observed yet.');
  ui.update({ observed: { operationId: 'other', status: 'saved' } });
  assert.equal(ui.snapshot.canSubmit, false, 'Another operation’s state proves nothing.');
  ui.update({ observed: { operationId: 'offline', status: 'saved' } });
  assert.equal(ui.snapshot.canSubmit, true); assert.equal(ui.snapshot.pendingSaved, true);
  ui.participation({ phase: 'following' });
  assert.match(ui.snapshot.message, /saved on this device and waiting to be applied/);
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
