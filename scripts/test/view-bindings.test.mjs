import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as p from '@chronolog/peer-session';
import { genesisForDevices } from '../../collaboration/test/physical-fixture.mjs';
import { openNativeDevice } from '@chronolog/peer-session/native';
import {
  createViewBindingSource,
  resolveViewBinding,
  viewBindingCommands,
  viewBindingQueries,
} from '../../docs/tutorial/shared/helpers/view-bindings.mjs';

const VIEW_BINDING_REDUCER = `
export default {
  reduce(state, tx) {
    return { ok: true, state: { count: ((state && state.count) || 0) + 1 }, events: [{ topic: 'ui/view-binding', payload: tx.payload }] };
  },
};
`;

const definition = p.defineApplication({
  id: 'view-bindings-test',
  version: '1',
  commands: viewBindingCommands,
  queries: viewBindingQueries,
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'view-bindings-'));
  const path = join(directory, 'device.sqlite');
  let device = await openNativeDevice({ path, create: true }), session;
  t.after(async () => {
    try { if (session) await session.close(); else await device.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  const { genesisBytes, casNodes, key: epoch0Key } = await genesisForDevices([device], {
    imports: { 'app/view-binding': VIEW_BINDING_REDUCER },
    topics: { 'ui/view-binding': { module: 'app/view-binding' } },
  });
  const open = async () => p.createApplicationSession({ device, definition, genesis: genesisBytes, casNodes, epochKeys: new Map([[0, epoch0Key]]) });
  session = await open();
  return {
    get session() { return session; },
    async reopen() {
      await session.close();
      session = undefined;
      device = await openNativeDevice({ path });
      session = await open();
    },
  };
}

test('view bindings enforce validation, resolve device > participant > role precedence, notify live, and persist across reopen', { timeout: 20_000 }, async t => {
  const f = await fixture(t);

  await assert.rejects(
    async () => f.session.command('setViewBinding', { targetKind: 'device', targetId: 'bad id!', facetId: 'kiosk' }),
    /VIEW_BINDING_TARGET_INVALID/,
  );
  await assert.rejects(
    async () => f.session.command('setViewBinding', { targetKind: 'role', targetId: 'guest', facetId: 'INVALID' }),
    /VIEW_BINDING_FACET_INVALID/,
  );

  const source = createViewBindingSource(f.session, {
    deviceId: 'dev_kitchen',
    participantId: 'acc_alex',
    role: 'guest',
  });
  t.after(() => source.close());
  await source.ready;
  assert.equal(source.resolve(), null);

  let changes = 0;
  source.onChange(() => { changes++; });

  // 1. Role binding takes effect
  await source.setBinding({ targetKind: 'role', targetId: 'guest', facetId: 'guest-home' }, 'vb-1');
  assert.equal(source.resolve(), 'guest-home');
  assert.equal(changes, 1);

  // 2. Participant binding overrides role
  await source.setBinding({ targetKind: 'participant', targetId: 'acc_alex', facetId: 'alex-view', label: 'Alex' }, 'vb-2');
  assert.equal(source.resolve(), 'alex-view');
  assert.equal(changes, 2);

  // 3. Device binding overrides participant
  await source.setBinding({ targetKind: 'device', targetId: 'dev_kitchen', facetId: 'kiosk', label: 'Kitchen wall' }, 'vb-3');
  assert.equal(source.resolve(), 'kiosk');
  assert.equal(changes, 3);

  // 4. Clearing device binding falls back cleanly to participant binding
  await source.setBinding({ targetKind: 'device', targetId: 'dev_kitchen', facetId: null }, 'vb-4');
  assert.equal(source.resolve(), 'alex-view');
  assert.equal(changes, 4);

  source.close();

  // 5. Reopen device and verify query + pure resolver match persisted state
  await f.reopen();
  const { value } = await f.session.query('viewBindings', null);
  assert.equal(value.bindings.length, 2);
  assert.equal(resolveViewBinding(value, { deviceId: 'dev_kitchen', participantId: 'acc_alex', role: 'guest' }), 'alex-view');
  assert.equal(resolveViewBinding(value, { deviceId: 'other', participantId: 'other', role: 'guest' }), 'guest-home');
  assert.equal(resolveViewBinding(value, { role: 'owner' }), null);
});
