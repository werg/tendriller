import test from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetBridge } from '../../server/inbox/bridge.mjs';

function host({ reply = true, deny = false, messageCapability = true, protocol = '2026-01-26' } = {}) {
  const listeners = new Set(), sent = [];
  const win = { addEventListener(name, fn) { assert.equal(name, 'message'); listeners.add(fn); },
    removeEventListener(name, fn) { assert.equal(name, 'message'); listeners.delete(fn); } };
  const deliver = (data, source = win.parent, origin = 'https://host.example') => {
    for (const listener of listeners) listener({ data, source, origin });
  };
  win.parent = { postMessage(message, target) {
    sent.push({ message, target });
    if (reply && message.method === 'ui/initialize') queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id,
      result: { protocolVersion: protocol, hostCapabilities: messageCapability ? { message: { text: {} } } : {} } }));
    if (reply && message.method === 'ui/message') queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id,
      ...(deny ? { error: { code: -32000, message: 'Host denied this message' } } : { result: {} }) }));
  } };
  return { win, sent, listeners, deliver };
}

test('inbox handshake sends no conversation message and pins explicit messages to the initialized host', async t => {
  const h = host(), bridge = createWidgetBridge({ window: h.win }); t.after(() => bridge.close());
  assert.equal((await bridge.connect()).mode, 'mcp-apps');
  assert.deepEqual(h.sent.map(x => x.message.method), ['ui/initialize', 'ui/notifications/initialized']);
  assert.equal(h.sent[0].target, '*'); assert.equal(h.sent[1].target, 'https://host.example');
  await bridge.sendMessage('Check the inbox.');
  assert.deepEqual(h.sent.at(-1), { target: 'https://host.example', message: { jsonrpc: '2.0', id: 'tendriller-2',
    method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Check the inbox.' }] } } });
});

test('only the initialized parent can deliver results, and removing a subscription stops delivery', async t => {
  const h = host(), bridge = createWidgetBridge({ window: h.win }); t.after(() => bridge.close());
  const results = [], off = bridge.onResult(value => results.push(value)); await bridge.connect();
  const message = { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { applicationId: 'a'.repeat(64) } } };
  h.deliver(message, {}); h.deliver(message, h.win.parent, 'https://other.example'); assert.equal(results.length, 0);
  h.deliver(message); assert.equal(results.length, 1); off(); h.deliver(message); assert.equal(results.length, 1);
});

test('the standard bridge propagates host refusal once without retry or alternate APIs', async t => {
  const h = host({ deny: true }), bridge = createWidgetBridge({ window: h.win }); t.after(() => bridge.close());
  await bridge.connect(); await assert.rejects(bridge.sendMessage('Check the inbox.'), /Host denied/);
  assert.equal(h.sent.filter(x => x.message.method === 'ui/message').length, 1);
});

test('missing message capability never posts a conversation message', async t => {
  const h = host({ messageCapability: false }), bridge = createWidgetBridge({ window: h.win }); t.after(() => bridge.close());
  await bridge.connect(); assert.equal(bridge.canMessage, false);
  await assert.rejects(bridge.sendMessage('Check the inbox.'), /WIDGET_MESSAGE_UNAVAILABLE/);
  assert.deepEqual(h.sent.map(x => x.message.method), ['ui/initialize', 'ui/notifications/initialized']);
});

test('unsupported or missing handshakes fail within their bound without marking the bridge connected', async () => {
  for (const options of [{ reply: false }, { protocol: 'unsupported' }]) {
    const h = host(options), bridge = createWidgetBridge({ window: h.win, timeoutMs: 5 });
    try { await assert.rejects(bridge.connect(), /WIDGET_HOST_TIMEOUT|WIDGET_PROTOCOL_UNSUPPORTED/); assert.equal(bridge.mode, 'unavailable'); }
    finally { bridge.close(); }
    assert.equal(h.listeners.size, 0);
  }
});

test('host teardown acknowledges once, cancels pending messages and releases the parent listener', async () => {
  const h = host(), bridge = createWidgetBridge({ window: h.win }); let closes = 0;
  const watched = createWidgetBridge({ window: h.win, onClose: () => closes++ });
  // Use one bridge so request IDs cannot collide with another card in this fake window.
  bridge.close(); await watched.connect();
  h.win.parent.postMessage = (message, target) => h.sent.push({ message, target });
  const pending = assert.rejects(watched.sendMessage('Check the inbox.'), /WIDGET_CLOSED/);
  h.deliver({ jsonrpc: '2.0', id: 'teardown-1', method: 'ui/resource-teardown', params: {} });
  await pending; watched.close();
  assert.equal(closes, 1); assert.equal(h.listeners.size, 0); assert.equal(watched.canMessage, false);
  assert.deepEqual(h.sent.at(-1).message, { jsonrpc: '2.0', id: 'teardown-1', result: {} });
});
