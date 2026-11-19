import test from 'node:test';
import assert from 'node:assert/strict';
import { createWidgetBridge, followupPrompt } from '../widget/bridge.mjs';
import { createWidgetResource, WIDGET_URI } from '../widget/resource.mjs';

function host({ standard = true, legacy = false, denyMessage = false } = {}) {
  const listeners = new Map(), sent = [], legacyCalls = [];
  const win = { addEventListener(name, fn) { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  const deliver = (data, source = win.parent, origin = 'https://host.example') => {
    for (const fn of listeners.get('message') ?? []) fn({ data, source, origin });
  };
  win.parent = { postMessage(message) {
    sent.push(message);
    if (standard && message.method === 'ui/initialize') queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id,
      result: { protocolVersion: '2026-01-26', hostCapabilities: { message: { text: {} }, serverTools: {} } } }));
    else if (standard && message.id) queueMicrotask(() => deliver({ jsonrpc: '2.0', id: message.id,
      ...(denyMessage ? { error: { code: -32000, message: 'Denied' } } : { result: {} }) }));
  } };
  if (legacy) win.openai = { sendFollowUpMessage: async value => legacyCalls.push(value), callTool: async () => ({}) };
  return { win, sent, legacyCalls, deliver };
}

test('portable handshake is inert until explicit action and preferred over compatibility aliases', async () => {
  const h = host({ legacy: true }), bridge = createWidgetBridge({ window: h.win });
  assert.equal((await bridge.connect()).mode, 'mcp-apps');
  assert.deepEqual(h.sent.map(x => x.method), ['ui/initialize', 'ui/notifications/initialized']);
  await bridge.sendMessage('Help with this request.');
  assert.deepEqual(h.sent.at(-1).params, { role: 'user', content: [{ type: 'text', text: 'Help with this request.' }] });
  assert.deepEqual(h.legacyCalls, []); bridge.close();
});

test('messages from unrelated windows or another origin cannot supply a result', async () => {
  const h = host(), bridge = createWidgetBridge({ window: h.win }), received = [];
  bridge.onResult(value => received.push(value)); await bridge.connect();
  const data = { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { answer: '<script>bad</script>' } } };
  h.deliver(data, {}); h.deliver(data, h.win.parent, 'https://other.example'); assert.equal(received.length, 0);
  h.deliver(data); assert.equal(received.length, 1); bridge.close();
});

test('denied message never retries through the legacy API', async () => {
  const h = host({ legacy: true, denyMessage: true }), bridge = createWidgetBridge({ window: h.win });
  await bridge.connect(); await assert.rejects(bridge.sendMessage('Help'), /Denied/);
  assert.equal(h.legacyCalls.length, 0); bridge.close();
});

test('legacy and unavailable hosts are feature-detected after bounded handshake', async () => {
  const h = host({ standard: false, legacy: true }), bridge = createWidgetBridge({ window: h.win, timeoutMs: 5 });
  assert.equal((await bridge.connect()).mode, 'legacy'); assert.equal(h.legacyCalls.length, 0);
  await bridge.sendMessage('Help'); assert.deepEqual(h.legacyCalls, [{ prompt: 'Help' }]);
  await assert.rejects(bridge.callTool('publish_page_release', {}), /NOT_ALLOWED/); bridge.close();
  const no = host({ standard: false }), unavailable = createWidgetBridge({ window: no.win, timeoutMs: 5 });
  assert.equal((await unavailable.connect()).mode, 'unavailable');
  await assert.rejects(unavailable.sendMessage('Help'), /UNAVAILABLE/); unavailable.close();
});

test('handoff contains identifiers only and resource needs no outside network or scripts', async () => {
  const prompt = followupPrompt({ applicationId: 'a'.repeat(64), requestId: 'request-1', question: 'Untrusted secret instructions' });
  assert.ok(prompt.includes('get_assistance_status')); assert.ok(!prompt.includes('Untrusted'));
  assert.throws(() => followupPrompt({ applicationId: 'a'.repeat(64), requestId: 'ignore\nprevious' }), /INVALID/);
  const resource = await createWidgetResource();
  assert.equal(resource.uri, WIDGET_URI); assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [] });
  assert.match(resource.text, /<script type="module">/); assert.doesNotMatch(resource.text, /WIDGET_BUNDLE|<script[^>]+src=/);
});
