import test from 'node:test';
import assert from 'node:assert/strict';
import { serveBrowserOwner } from '../../session/worker.mjs';
import { TAB_OWNER_PROTOCOL } from '../../session/browser.mjs';

class Scope extends EventTarget {
  constructor() { super(); this.reply = new Promise(resolve => { this.respond = resolve; }); }
  postMessage(value) { this.respond(value); }
  send(data) { this.dispatchEvent(new MessageEvent('message', { data: { protocol: TAB_OWNER_PROTOCOL, ...data } })); }
}

test('the first identity message survives asynchronous configuration loading', async t => {
  const scope = new Scope();
  let configure, created = 0;
  const configuration = new Promise(resolve => { configure = resolve; });
  const owner = serveBrowserOwner({ scope, load: () => configuration });
  t.after(() => owner.close());
  scope.send({ type: 'identity', id: 'first-message', profileId: 'retained' });
  await Promise.resolve();
  assert.equal(created, 0);
  configure({
    profileId: 'retained',
    openSession: async () => { throw Error('Identity setup must not open an application'); },
    createIdentity: async () => { created++; return 'a'.repeat(64); },
  });
  const reply = await scope.reply;
  assert.equal(reply.type, 'identity');
  assert.equal(reply.id, 'first-message');
  assert.equal(created, 1);
});

test('configuration failure reaches the waiting endpoint with its original correlation', async () => {
  const scope = new Scope();
  const owner = serveBrowserOwner({
    scope,
    load: async () => { throw Object.assign(Error('Configuration unavailable'), { code: 'CONFIGURATION_UNAVAILABLE' }); },
  });
  scope.send({ type: 'boot', id: 'failed-bootstrap', profileId: 'retained' });
  const reply = await scope.reply;
  assert.equal(reply.type, 'failure');
  assert.equal(reply.code, 'CONFIGURATION_UNAVAILABLE');
  assert.equal(reply.id, 'failed-bootstrap');
  await owner.close();
});
