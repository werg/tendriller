import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeHost } from '../review/codex-host.mjs';
import { readReviewAccess } from '../review/access.mjs';

function hostFixture({ exitEarly = false, toolError = false } = {}) {
  const calls = [], child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
  child.stdin.on('data', bytes => {
    const input = JSON.parse(String(bytes)); calls.push(input);
    if (!input.id) return;
    if (exitEarly) { child.kill(); return; }
    const result = input.method === 'thread/start' ? { thread: { id: 'qualification-context' } }
      : input.method === 'mcpServerStatus/list' ? { data: [{ name: 'tendriller_review', tools: {} }] }
        : input.method === 'mcpServer/tool/call' ? { content: [{ type: 'text', text: 'real host result shape' }] } : {};
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: input.id,
      ...(toolError && input.method === 'mcpServer/tool/call' ? { error: { message: 'PRIVATE_DIAGNOSTIC' } } : { result }) }) + '\n'));
  });
  return { calls, child, spawnHost: () => child };
}

test('native qualification uses the actual MCP host interface without model turns, persisted threads or token arguments', async () => {
  const fixture = hostFixture(); let invocation;
  const client = await nativeHost({ origin: 'https://staging.example', token: 'PRIVATE_TEST_BEARER', cwd: tmpdir(),
    spawnHost: (command, args, options) => { invocation = { command, args, options }; return fixture.child; } });
  assert.equal(invocation.command, 'codex');
  assert(!invocation.args.join(' ').includes('PRIVATE_TEST_BEARER'));
  assert.equal(invocation.options.env.TENDRILLER_REVIEW_TOKEN, 'PRIVATE_TEST_BEARER');
  assert((await client.call('list_tendrils')).content.length);
  assert.deepEqual(fixture.calls.filter(call => call.method === 'mcpServer/tool/call')[0].params,
    { threadId: 'qualification-context', server: 'tendriller_review', tool: 'list_tendrils', arguments: {} });
  assert.equal(fixture.calls.find(call => call.method === 'thread/start').params.ephemeral, true);
  assert(!fixture.calls.some(call => call.method === 'turn/start' || call.method.startsWith('config/')));
  await client.close(); assert.equal(fixture.child.exitCode, 0);
});

test('native host failures reject promptly and suppress private child diagnostics', async () => {
  const exited = hostFixture({ exitEarly: true });
  await assert.rejects(nativeHost({ origin: 'https://example.com', token: 'test', cwd: tmpdir(), spawnHost: exited.spawnHost }), /exited/);
  const failed = hostFixture({ toolError: true });
  const client = await nativeHost({ origin: 'https://example.com', token: 'test', cwd: tmpdir(), spawnHost: failed.spawnHost });
  await assert.rejects(client.call('query_application'), error => !error.message.includes('PRIVATE_DIAGNOSTIC') && error.message.includes('mcpServer/tool/call'));
  await client.close();
});

test('reviewer automation uses a static login URL and separately supplied reusable code, with origin and hash checks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-access-'));
  const code = 'a'.repeat(43), path = join(directory, 'access.json');
  const record = { origin: 'https://example.com', accountId: 'test_' + 'b'.repeat(32),
    url: 'https://example.com/auth/test#token=' + code, tokenSha256: createHash('sha256').update(code).digest('hex') };
  try {
    writeFileSync(path, JSON.stringify(record));
    const access = readReviewAccess(path);
    assert.equal(access.loginUrl, 'https://example.com/auth/test'); assert.equal(access.code, code);
    writeFileSync(path, JSON.stringify({ ...record, url: 'https://untrusted.example/auth/test#token=' + code }));
    assert.throws(() => readReviewAccess(path), /inconsistent/);
    writeFileSync(path, JSON.stringify({ ...record, tokenSha256: '0'.repeat(64) }));
    assert.throws(() => readReviewAccess(path), /inconsistent/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('native host deadlines stop an unresponsive client without starting a model turn', async () => {
  const fixture = hostFixture();
  fixture.child.stdin.removeAllListeners('data');
  await assert.rejects(nativeHost({ origin: 'https://example.com', token: 'test', cwd: tmpdir(), spawnHost: fixture.spawnHost, deadlineMs: 10 }), /deadline: initialize/);
  assert.equal(fixture.child.exitCode, 0);
});

test('observational backpressure retries are bounded and never hide other failures', async () => {
  const { readWithAdmissionRetry } = await import('../review/read.mjs');
  let calls = 0;
  assert.equal(await readWithAdmissionRetry(() => { if (++calls < 3) throw Object.assign(Error('busy'), { status: 429 }); return 'ready'; }, { pauseMs: 1 }), 'ready');
  assert.equal(calls, 3);
  await assert.rejects(readWithAdmissionRetry(() => { throw Object.assign(Error('busy'), { status: 429 }); }, { deadlineMs: 0 }), /busy/);
  await assert.rejects(readWithAdmissionRetry(() => { throw Object.assign(Error('denied'), { status: 403 }); }), /denied/);
});
