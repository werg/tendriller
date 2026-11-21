import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { handleStdioMcpMessage, serveStdioMcp } from '../lib/mcp-stdio.mjs';

const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
test('invalid complete batches submit no commands, including malformed later entries', async () => {
  let calls = 0;
  const owned = { session: { command: async () => { calls++; } } };
  for (const commands of [null, {}, [null], [{ command: 'add', input: {}, operationId: 'first' }, null]]) {
    const result = await handleStdioMcpMessage(owned, call('command_submit_batch', { commands }));
    assert.equal(result.result.isError, true);
  }
  assert.equal(calls, 0);
});
test('inspection preserves unknown and review-needed lifecycle states', async () => {
  for (const status of ['abandoned', 'needsReapply', 'unrecognized']) {
    const result = await handleStdioMcpMessage({ session: { operations: { get: async () => ({ status }) } } },
      call('operation_inspect', { operationId: 'original' }));
    assert.equal(result.result.structuredContent.lifecycle, status === 'unrecognized' ? 'unknown' : 'needs-review');
  }
});
test('batch wait failures preserve saved work and never assert rejection', async () => {
  const saved = { status: 'saved', operationId: 'original' };
  const owned = { session: {
    command: async () => ({ applied: async () => { throw Error('response lost'); } }),
    operations: { get: async () => saved },
  } };
  const response = await handleStdioMcpMessage(owned, call('command_submit_batch', {
    commands: [{ command: 'add', input: {}, operationId: 'original' }],
  }));
  assert.equal(response.result.structuredContent.results[0].lifecycle, 'unknown');
  assert.deepEqual(response.result.structuredContent.results[0].state, saved);
});
test('a lost command admission response remains inspectable under its original long identity', async () => {
  const operationId = 'scope#' + 'x'.repeat(506), saved = { status: 'saved', operationId };
  const response = await handleStdioMcpMessage({ session: {
    command: async () => { throw Error('admission reply lost'); },
    operations: { get: async id => { assert.equal(id, operationId); return saved; } },
  } }, call('command_submit', { command: 'add', input: {}, operationId }));
  assert.equal(response.result.structuredContent.lifecycle, 'unknown');
  assert.deepEqual(response.result.structuredContent.state, saved);
});
test('stdio accepts cancellation while a tool is awaiting its applied response', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = '', submitted;
  const started = new Promise(resolve => { submitted = resolve; });
  output.on('data', chunk => { text += chunk; });
  const owned = { session: {
    command: async () => ({ applied: async ({ signal }) => {
      submitted();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }), operations: { get: async () => ({ status: 'saved' }) },
  } };
  const serving = serveStdioMcp(owned, { input, output });
  input.write(JSON.stringify(call('command_submit', { command: 'add', input: {}, operationId: 'original' })) + '\n');
  await started;
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) + '\n');
  await new Promise(resolve => output.once('data', resolve));
  input.end();
  await serving;
  const reply = JSON.parse(text.trim());
  assert.equal(reply.id, 1);
  assert.equal(reply.result.structuredContent.lifecycle, 'unknown');
});
test('stdio bounds individual input frames', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const serving = serveStdioMcp({ session: {} }, { input, output });
  input.end('x'.repeat(1024 * 1024 + 1));
  await assert.rejects(serving, /exceeds 1 MiB/);
});
