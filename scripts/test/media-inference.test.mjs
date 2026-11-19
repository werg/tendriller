import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeerInferenceClient } from '../../docs/tutorial/media/inference-client.mjs';
import { servePeerInference } from '../../docs/tutorial/media/inference-service.mjs';
import { createInferenceProvider } from '../../docs/tutorial/media/provider-openai.mjs';
import { INFERENCE_TOPICS as topics, sha256 } from '../../docs/tutorial/media/inference-protocol.mjs';

const applicationId = 'a'.repeat(64), browser = 'b'.repeat(64), native = 'c'.repeat(64), stranger = 'd'.repeat(64);
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Expected observable result did not arrive.');
    // Web Crypto runs off-thread. Yield by elapsed time rather than counting
    // immediate callbacks, which can all finish before a digest is scheduled.
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

// Transport/content fixtures preserve public API shapes. Cryptographic peer
// verification is tested by the separate actual-session integration gate.
function network() {
  const listeners = new Set(), content = new Map(), sent = [], reads = [], commands = [];
  let counter = 0;
  const deliver = envelope => {
    const captured = structuredClone(envelope); sent.push(captured);
    for (const listener of listeners) if (listener.topics.includes(captured.topic)) { listener.queue.push(captured); listener.wake?.(); }
  };
  const endpoint = deviceId => ({ applicationId, historyId: 'fixture-history', deviceId,
    command(...args) { commands.push(args); throw Error('Inference must never submit an application command.'); },
    signals: {
      async send(topic, payload, options = {}) {
        options.signal?.throwIfAborted();
        deliver({ scope: applicationId, authorId: deviceId, topic, payload, sessionId: 'session', sequence: ++counter,
          issuedAtMs: Date.now(), expiresAtMs: Date.now() + (options.ttlMs ?? 30_000) });
      },
      subscribe({ topics, signal }) {
        return { async *[Symbol.asyncIterator]() {
          const item = { topics, queue: [], wake: null }; listeners.add(item);
          const wake = () => item.wake?.(); signal?.addEventListener('abort', wake);
          try {
            while (!signal?.aborted) {
              if (item.queue.length) yield structuredClone(item.queue.shift());
              else await new Promise(resolve => { item.wake = resolve; if (signal?.aborted || item.queue.length) resolve(); });
            }
          } finally { listeners.delete(item); signal?.removeEventListener('abort', wake); }
        } };
      },
    },
    content: {
      async stage({ bytes, mediaType }) {
        const chunks = [], id = (++counter).toString(16).padStart(64, '0');
        return { id, async write(index, chunk) { chunks[index] = chunk.slice(); }, async commit() {
          const value = new Uint8Array(bytes); let offset = 0;
          for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.length; }
          assert.equal(offset, bytes); content.set(id, value);
          return { profile: 'peer-content-v1', applicationId, historyId: 'fixture-history', id, epoch: 0, bytes, mediaType };
        } };
      },
      async *read(reference, { signal }) {
        reads.push(reference); signal.throwIfAborted();
        const bytes = content.get(reference.id); if (!bytes) throw Error('CONTENT_UNAVAILABLE');
        for (let offset = 0; offset < bytes.length; offset += 65_536) { signal.throwIfAborted(); yield bytes.slice(offset, offset + 65_536); }
      },
    },
  });
  return { endpoint, sent, reads, commands, content, deliver };
}
async function candidate(text = 'reviewed image') {
  const blob = new Blob([text], { type: 'image/png' });
  return { id: crypto.randomUUID(), blob, sha256: await sha256(await blob.arrayBuffer()), context: { task: 'original', revision: { sequence: 3 } } };
}
async function request(net, id = crypto.randomUUID()) {
  const evidence = await candidate(), session = net.endpoint(browser), bytes = new Uint8Array(await evidence.blob.arrayBuffer());
  const upload = await session.content.stage({ bytes: bytes.length, mediaType: evidence.blob.type }); await upload.write(0, bytes);
  return { workerDeviceId: native, requestId: id, candidateId: evidence.id, sha256: evidence.sha256, reference: await upload.commit(), context: evidence.context, prompt: 'Suggest a short editable description.' };
}
const replyFor = (net, id, kind) => net.sent.filter(item => item.topic === topics.reply && item.payload.requestId === id && (!kind || item.payload.kind === kind));

test('inference uses immutable session content, returns a suggestion, and deduplicates within the budget', async t => {
  const net = network(), calls = [];
  const service = servePeerInference({ session: net.endpoint(native), allowedDevices: [browser], maxRequests: 1,
    infer: async value => { calls.push(value); return { text: 'Review this proposed description.' }; } });
  t.after(() => service.close());
  const client = createPeerInferenceClient({ session: net.endpoint(browser), workerDeviceId: native, prompt: 'Describe the image.' });
  t.after(() => client.close());
  const evidence = await candidate();
  const analysis = await client.analyze({ candidate: evidence });
  assert.deepEqual(analysis.suggestion, { text: 'Review this proposed description.' });
  assert.equal(analysis.source.candidateId, evidence.id); assert.equal(analysis.source.sha256, evidence.sha256);
  assert.equal(analysis.source.reference.id, calls[0].source.contentId);
  assert.equal(calls.length, 1); assert.equal(new TextDecoder().decode(calls[0].bytes), 'reviewed image');
  assert.deepEqual(calls[0].context, evidence.context); assert.equal(calls[0].source.sha256, evidence.sha256);
  assert.equal('session' in calls[0], false); assert.equal('command' in calls[0], false); assert.deepEqual(net.commands, []);
  const original = net.sent.find(item => item.topic === topics.request).payload;
  await net.endpoint(browser).signals.send(topics.request, original);
  await until(() => replyFor(net, original.requestId).length === 2); assert.equal(calls.length, 1);
  await net.endpoint(browser).signals.send(topics.request, { ...original, prompt: 'Changed intent with the same identity.' });
  await until(() => replyFor(net, original.requestId).some(item => item.payload.code === 'conflict'));
  const another = { ...original, requestId: crypto.randomUUID() };
  await net.endpoint(browser).signals.send(topics.request, another);
  await until(() => replyFor(net, another.requestId).some(item => item.payload.code === 'budget'));
  assert.equal(calls.length, 1); assert.equal(service.snapshot().admitted, 1);
});

test('inference trusts authenticated envelope identity, not payload roles or a claimed device', async t => {
  const net = network(), calls = [];
  const service = servePeerInference({ session: net.endpoint(native), allowedDevices: [browser], infer: async value => { calls.push(value); return { text: 'allowed' }; } });
  t.after(() => service.close());
  const input = await request(net);
  await net.endpoint(stranger).signals.send(topics.request, { ...input, authorId: browser, role: 'owner' });
  await net.endpoint(stranger).signals.send(topics.request, input);
  net.deliver({ scope: 'e'.repeat(64), authorId: browser, topic: topics.request, payload: input });
  await net.endpoint(browser).signals.send(topics.request, { ...input, workerDeviceId: stranger });
  await flush(); await flush(); assert.equal(net.reads.length, 0); assert.equal(calls.length, 0);
  await net.endpoint(browser).signals.send(topics.request, input);
  await until(() => replyFor(net, input.requestId, 'suggestion').length === 1); assert.equal(calls.length, 1);
});

test('invalid sizes/scopes are refused before reads and mismatched evidence never reaches a provider', async t => {
  const net = network(), calls = [];
  const service = servePeerInference({ session: net.endpoint(native), allowedDevices: [browser], maxRequests: 3,
    infer: async value => { calls.push(value); return { text: 'unexpected' }; } });
  t.after(() => service.close());
  const input = await request(net);
  await net.endpoint(browser).signals.send(topics.request, { ...input, reference: { ...input.reference, bytes: 9 * 1024 * 1024 } });
  await net.endpoint(browser).signals.send(topics.request, { ...input, reference: { ...input.reference, applicationId: stranger } });
  await net.endpoint(browser).signals.send(topics.request, { ...input, context: { oversized: 'x'.repeat(5000) } });
  await flush(); await flush(); assert.equal(net.reads.length, 0); assert.equal(service.snapshot().admitted, 0);
  const corrupt = { ...input, sha256: 'f'.repeat(64) };
  await net.endpoint(browser).signals.send(topics.request, corrupt);
  await until(() => replyFor(net, input.requestId).some(item => item.payload.code === 'source'));
  assert.equal(calls.length, 0); assert.deepEqual(net.commands, []);
});

test('cancel is caller-bound, covers reordered requests, and never frees an unsettled provider slot', async t => {
  const net = network(), result = deferred(), calls = [];
  const service = servePeerInference({ session: net.endpoint(native), allowedDevices: [browser, stranger], maxRequests: 3,
    infer: async value => { calls.push(value); return result.promise; } });
  t.after(async () => { result.resolve({ text: 'settled' }); await service.close(); });
  const cancelled = await request(net);
  await net.endpoint(browser).signals.send(topics.cancel, { workerDeviceId: native, requestId: cancelled.requestId });
  await net.endpoint(browser).signals.send(topics.request, cancelled);
  await until(() => replyFor(net, cancelled.requestId).some(item => item.payload.code === 'cancelled'));
  assert.equal(calls.length, 0);
  const input = await request(net); await net.endpoint(browser).signals.send(topics.request, input);
  await until(() => calls.length === 1);
  await net.endpoint(stranger).signals.send(topics.cancel, { workerDeviceId: native, requestId: input.requestId }); await flush();
  assert.equal(calls[0].signal.aborted, false, 'Another authorized caller cannot cancel this caller.');
  await net.endpoint(browser).signals.send(topics.cancel, { workerDeviceId: native, requestId: input.requestId });
  await until(() => calls[0].signal.aborted); assert.equal(service.snapshot().active, 1);
  const next = await request(net); await net.endpoint(browser).signals.send(topics.request, next);
  await until(() => replyFor(net, next.requestId).some(item => item.payload.code === 'busy'));
  result.resolve({ text: 'late suggestion must not survive Cancel' });
  await until(() => replyFor(net, input.requestId).some(item => item.payload.code === 'cancelled'));
  assert.equal(replyFor(net, input.requestId, 'suggestion').length, 0); assert.equal(calls.length, 1);
});

test('client ignores wrong signers and stale sources, and cancellation discards late replies', async () => {
  const net = network(), client = createPeerInferenceClient({ session: net.endpoint(browser), workerDeviceId: native, prompt: 'Describe.' });
  const cancel = new AbortController(), evidence = await candidate();
  const analyzing = client.analyze({ candidate: evidence, signal: cancel.signal });
  const rejected = assert.rejects(analyzing, { name: 'AbortError' });
  await until(() => net.sent.some(item => item.topic === topics.request));
  const input = net.sent.find(item => item.topic === topics.request).payload;
  const response = { recipient: browser, requestId: input.requestId, candidateId: input.candidateId, sha256: input.sha256,
    contentId: input.reference.id, kind: 'suggestion', suggestion: { text: 'unaccepted result' } };
  await net.endpoint(stranger).signals.send(topics.reply, response);
  await net.endpoint(native).signals.send(topics.reply, { ...response, sha256: 'f'.repeat(64) });
  await net.endpoint(native).signals.send(topics.reply, { ...response, candidateId: 'another-candidate' });
  await flush(); cancel.abort(); await rejected;
  assert(net.sent.some(item => item.topic === topics.cancel && item.payload.requestId === input.requestId));
  await net.endpoint(native).signals.send(topics.reply, response); await flush();
  assert.deepEqual(net.commands, []); client.close();
});

test('OpenAI adapter uses the selected model, native credential and bounded suggestion-only HTTP contract', async () => {
  const captured = [], secret = 'native-secret-sentinel';
  assert.throws(() => createInferenceProvider({ model: 'selected-model', apiKey: '' }), /OPENAI_API_KEY/);
  assert.throws(() => createInferenceProvider({ apiKey: secret }), /--model/);
  const infer = createInferenceProvider({ apiKey: secret, model: 'explicit-model', fetch: async (url, options) => {
    captured.push({ url, options });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Editable result' }] }] }));
  } });
  const signal = new AbortController().signal;
  assert.deepEqual(await infer({ bytes: new Uint8Array([1, 2]), mediaType: 'image/png', prompt: 'Describe.', signal }), { text: 'Editable result' });
  const { url, options } = captured[0], body = JSON.parse(options.body);
  assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(options.signal, signal); assert.equal(options.redirect, 'error'); assert.equal(body.model, 'explicit-model');
  assert.equal(body.store, false); assert.equal(body.max_output_tokens, 600); assert.equal(body.tools, undefined);
  assert.equal(body.input[0].content[1].image_url, 'data:image/png;base64,AQI='); assert(!options.body.includes(secret));
  const failing = createInferenceProvider({ apiKey: secret, model: 'explicit-model', fetch: async () => new Response('private provider diagnostic', { status: 401 }) });
  await assert.rejects(failing({ bytes: new Uint8Array([1]), mediaType: 'image/png', prompt: 'Describe.', signal }), error => /HTTP 401/.test(error.message) && !error.message.includes('private provider diagnostic'));
});
