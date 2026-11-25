import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile), cli = fileURLToPath(new URL('../bin/tendril.mjs', import.meta.url));
// Resolve the public export here so a bootstrap in an isolated temp directory
// uses the same installed public SDK as the CLI, without source-private imports.
const diagnostics = import.meta.resolve('@tendriller/core/diagnostics');
const operationId = 'diagnostic-release-1', publicationId = 'signed-diagnostic-publication';
const expectedCodes = ['EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'];

async function fixture(t, stage, shape = 'aggregate') {
  const root = await mkdtemp(join(tmpdir(), 'tendril-transport-causes-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const page = join(root, 'page'), bootstrap = join(root, 'session.mjs'), log = join(root, 'calls.json');
  await mkdir(page); await writeFile(join(page, 'index.html'), '<main>Exact original publication bytes</main>');
  await writeFile(bootstrap, `
import { writeFile } from 'node:fs/promises';
import { transportCauseSummary } from ${JSON.stringify(diagnostics)};
const stage = ${JSON.stringify(stage)}, shape = ${JSON.stringify(shape)};
const signed = { id:${JSON.stringify(publicationId)}, payload:{ operationId:${JSON.stringify(operationId)} } };
function failure(attached) {
  const secret = 'private-transport-fixture';
  const leaf = code => Object.assign(new Error(secret + ' message'), {
    code, address:'2001:db8::123', hostname:secret + '.example.invalid',
    path:'/private/' + secret, url:'https://example.invalid/' + secret + '?token=hidden-query-token',
    headers:{ authorization:'Bearer hidden-header-token' }, stack:secret + ' stack',
  });
  const members = [leaf('ENOTFOUND'), new AggregateError([
    leaf('EAI_AGAIN'), leaf('UND_ERR_CONNECT_TIMEOUT'), leaf('ENETUNREACH'),
    new Error(secret + ' nested wrapper', { cause:leaf('ECONNRESET') }), leaf('ETIMEDOUT'),
  ], secret + ' nested aggregate')];
  if (shape === 'bounded') for (let index = 0; index < 80; index++) members.push(leaf('ECONNRESET'));
  const cause = shape === 'unknown' ? leaf(secret + '_unknown_code') : new AggregateError(members, secret + ' aggregate');
  cause.cause = cause; // Cycles must not prevent bounded JSON output.
  const code = stage === 'preparation' ? 'APPLICATION_CONTROL_TIMEOUT'
    : stage === 'submission' ? 'APPLICATION_PUBLICATION_OUTCOME_UNKNOWN' : 'APPLICATION_PUBLICATION_SELECTION_UNAVAILABLE';
  const error = Object.assign(new Error(code + ': fetch failed', { cause }), {
    code, phase:stage, operationId:signed.payload.operationId,
    publicationId:stage === 'preparation' ? null : signed.id,
    outcome:stage === 'selection' ? 'committed' : stage === 'submission' ? 'unknown' : 'not_submitted',
    receipt:stage === 'selection' ? { publication:signed, version:7 } : null,
  });
  if (!attached) return error;
  // Model the serialized native-owner boundary here. The native integration
  // suite separately exercises the actual authenticated IPC transport.
  const wire = JSON.parse(JSON.stringify({ message:error.message, code:error.code,
    phase:error.phase, outcome:error.outcome, receipt:error.receipt,
    operationId:error.operationId, publicationId:error.publicationId,
    transportCauses:transportCauseSummary(error) }));
  return Object.assign(new Error(wire.message), wire);
}
function open(attached) {
  const calls = [];
  const close = async () => { calls.push(attached ? 'detach' : 'close'); await writeFile(${JSON.stringify(log)}, JSON.stringify(calls)); };
  const control = {
    async publication() { calls.push('head'); return null; },
    async preparePublication(input) {
      calls.push({ prepare:input.operationId });
      if (stage === 'preparation') throw failure(attached);
      return signed;
    },
    async publish(publication, assets) {
      calls.push({ publish:publication.id, operation:publication.payload.operationId, assets:assets.length });
      throw failure(attached);
    },
  };
  return { session:{}, control, ...(attached ? { detach:close } : { close }) };
}
export const openSession = () => open(false);
export const attachSession = () => open(true);
`);
  return { bootstrap, page, log };
}

async function invoke(fixture, mode) {
  let failure;
  try {
    await run(process.execPath, [cli, '--session', fixture.bootstrap, '--mode', mode,
      'publish', fixture.page, '--operation', operationId]);
  } catch (error) { failure = error; }
  assert.ok(failure, 'The failed publication must exit nonzero.');
  assert.equal(failure.code, 1); assert.equal(failure.stdout, '');
  assert.doesNotMatch(failure.stderr, /private-transport-fixture|2001:db8|hidden-query-token|hidden-header-token/);
  const result = JSON.parse(failure.stderr);
  assert.equal(result.diagnostic.retrySafe, false);
  return { result, calls:JSON.parse(await readFile(fixture.log, 'utf8')) };
}

test('CLI preserves transport causes and distinct publication evidence in own and serialized attached failures', async t => {
  for (const stage of ['preparation', 'submission', 'selection']) await t.test(stage, async () => {
    const f = await fixture(t, stage), own = await invoke(f, 'own'), attached = await invoke(f, 'attach');
    assert.deepEqual(attached.result, own.result, 'The same sanitized evidence must survive the owner boundary.');
    const { error, diagnostic, publication } = own.result;
    const code = stage === 'preparation' ? 'APPLICATION_CONTROL_TIMEOUT'
      : stage === 'submission' ? 'APPLICATION_PUBLICATION_OUTCOME_UNKNOWN' : 'APPLICATION_PUBLICATION_SELECTION_UNAVAILABLE';
    assert.deepEqual(error, { code, message:code + ': fetch failed' });
    assert.equal(diagnostic.code, code);
    assert.deepEqual(diagnostic.transportCauses, { codes:expectedCodes, truncated:false });
    assert.equal(publication.operationId, operationId);
    assert.equal(publication.publicationId, stage === 'preparation' ? null : publicationId);
    assert.equal(publication.phase, stage);
    assert.equal(publication.outcome, stage === 'preparation' ? 'not_submitted' : stage === 'submission' ? 'unknown' : 'committed');
    assert.deepEqual(publication.receipt, stage === 'selection' ? { publicationId, version:7 } : null);
    const calls = ['head', { prepare:operationId }, ...(stage === 'preparation' ? [] : [{ publish:publicationId, operation:operationId, assets:1 }])];
    assert.deepEqual(own.calls, [...calls, 'close']);
    assert.deepEqual(attached.calls, [...calls, 'detach']);
  });
});

test('CLI marks bounded aggregate summaries without changing uncertain publication or retry safety', async t => {
  const f = await fixture(t, 'submission', 'bounded');
  for (const mode of ['own', 'attach']) {
    const { result } = await invoke(f, mode);
    assert.deepEqual(result.diagnostic.transportCauses, { codes:expectedCodes, truncated:true });
    assert.ok(Buffer.byteLength(JSON.stringify(result.diagnostic.transportCauses)) < 512);
    assert.equal(result.publication.outcome, 'unknown'); assert.equal(result.publication.receipt, null);
  }
});

test('unrecognized transport details remain absent from CLI diagnostics', async t => {
  const f = await fixture(t, 'preparation', 'unknown');
  for (const mode of ['own', 'attach']) {
    const { result } = await invoke(f, mode);
    assert.equal(Object.hasOwn(result.diagnostic, 'transportCauses'), false);
    assert.equal(result.error.code, 'APPLICATION_CONTROL_TIMEOUT');
    assert.equal(result.publication.outcome, 'not_submitted');
  }
});
