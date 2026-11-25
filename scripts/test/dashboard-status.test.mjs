import assert from 'node:assert/strict';
import test from 'node:test';

/** The smallest DOM the dashboard shell needs; the connection pill is the element under test. */
function installDom() {
  class Node_ {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.style = {}; this.className = ''; this.textContent = ''; this.hidden = false;
      this.classList = { toggle() {}, add() {} }; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener() {}
    remove() {}
    querySelector() { return null; }
  }
  globalThis.document = { createElement: tag => new Node_(tag), createElementNS: (_ns, tag) => new Node_(tag), getElementById: () => null,
    head: new Node_('head'), body: new Node_('body') };
  return { Node_ };
}
const flatten = node => [node, ...node.children.flatMap(flatten)];

test('the dashboard connection pill follows the public session count and status stream, with an optional separate participation controller', async t => {
  const { Node_ } = installDom(); t.after(() => { delete globalThis.document; });
  const { mountDashboardShell } = await import('../../docs/tutorial/shared/ui/dashboard.mjs');
  const listeners = new Set(), linkListeners = new Set();
  const session = { status: { connectedPeers: 0, phase: 'ready' }, onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // A nested participation object is not part of the public session and must not be read.
    participation: { status: { connectedPeers: ['x', 'y'] }, onStatus() { throw Error('must not subscribe'); } } };
  const link = { status: { phase: 'connecting' }, onStatus(fn) { linkListeners.add(fn); return () => linkListeners.delete(fn); } };
  const container = new Node_('main');
  const shell = mountDashboardShell(container, { session, participation: link });
  const pill = () => flatten(shell.element).find(node => node.className === 'td-pill' && node.dataset.tone !== undefined);
  assert.equal(pill().dataset.tone, 'warn'); assert.equal(pill().children[1].textContent, 'Reconnecting…');
  for (const fn of linkListeners) fn({ phase: 'failed', error: 'NETWORK_UNAVAILABLE' });
  assert.equal(pill().dataset.tone, 'alert'); assert.equal(pill().children[1].textContent, 'Offline (NETWORK_UNAVAILABLE)');
  for (const fn of listeners) fn({ connectedPeers: 1, phase: 'ready', connectionRevision: 2 });
  assert.equal(pill().dataset.tone, 'ok'); assert.equal(pill().children[1].textContent, 'Live · 1 peer');
  for (const fn of listeners) fn({ connectedPeers: 3, phase: 'ready', connectionRevision: 3 });
  assert.equal(pill().children[1].textContent, 'Live · 3 peers');
  shell.close();
  assert.equal(listeners.size, 0); assert.equal(linkListeners.size, 0);
});

test('without a participation controller the dashboard reports only Offline or the connected count', async t => {
  const { Node_ } = installDom(); t.after(() => { delete globalThis.document; });
  const { mountDashboardShell } = await import('../../docs/tutorial/shared/ui/dashboard.mjs');
  const listeners = new Set();
  const session = { status: { connectedPeers: 0 }, onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const shell = mountDashboardShell(new Node_('main'), { session });
  const pill = () => flatten(shell.element).find(node => node.className === 'td-pill' && node.dataset.tone !== undefined);
  assert.equal(pill().children[1].textContent, 'Offline');
  for (const fn of listeners) fn({ connectedPeers: 2 });
  assert.equal(pill().children[1].textContent, 'Live · 2 peers');
  shell.close(); assert.equal(listeners.size, 0);
});
