import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticFinding, transportCauseSummary } from '../../session/diagnostics.mjs';

const network = code => Object.assign(Error('private URL https://secret.invalid/token?key=private'), {
  code, address: '192.0.2.12', path: '/private/profile', headers: { authorization: 'private-token' },
});

test('transport causes retain only known codes through nested aggregate and cause chains', () => {
  const cause = new AggregateError([network('ENETUNREACH'), network('ETIMEDOUT'),
    new AggregateError([network('ECONNRESET'), network('ENETUNREACH'), network('private-token')], 'private')], 'private');
  cause.cause = network('EAI_AGAIN');
  const error = Object.assign(Error('APPLICATION_PUBLICATION_OUTCOME_UNKNOWN', { cause: Error('fetch failed', { cause }) }), {
    code: 'APPLICATION_PUBLICATION_OUTCOME_UNKNOWN', phase: 'submission', outcome: 'unknown',
  });
  const expected = { codes: ['EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT'], truncated: false };
  assert.deepEqual(transportCauseSummary(error), expected);
  const finding = diagnosticFinding(error);
  assert.deepEqual(finding.transportCauses, expected);
  assert.equal(finding.code, error.code); assert.equal(finding.retrySafe, false);
  assert.equal(error.outcome, 'unknown'); assert.equal(error.phase, 'submission');
  assert.doesNotMatch(JSON.stringify(finding), /private|192\.0|https|authorization/);
  assert.deepEqual(transportCauseSummary({ transportCauses: expected }), expected, 'IPC summaries revalidate identically');
  assert.deepEqual(transportCauseSummary(Error('wrapped', { cause: { transportCauses: expected } })), expected);
});

test('cycles, primitives, unknown codes and malformed values cannot escape the bounded formatter', () => {
  const cycle = network('UND_ERR_SOCKET'); cycle.cause = cycle; cycle.errors = [cycle, cycle];
  assert.deepEqual(transportCauseSummary(cycle), { codes: ['UND_ERR_SOCKET'], truncated: false });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [null, undefined, 'ECONNRESET', 12, true, Symbol('private'), revoked.proxy,
    { code: 'arbitrary-private-code', errors: 'not an array' }, { cause: { code: {} } }]) {
    assert.equal(transportCauseSummary(value), undefined);
  }
  let getters = 0;
  const malicious = Object.defineProperties({}, Object.fromEntries(['code', 'cause', 'errors', 'transportCauses', 'message', 'stack']
    .map(key => [key, { get() { getters++; throw Error('must not read private getter'); } }])));
  assert.equal(transportCauseSummary(malicious), undefined);
  assert.equal(getters, 0);
  const errors = [network('ENOTFOUND')];
  Object.defineProperty(errors, Symbol.iterator, { value() { throw Error('must not iterate'); } });
  assert.deepEqual(transportCauseSummary({ errors }), { codes: ['ENOTFOUND'], truncated: false });
  const malformedArray = new Proxy([], { getOwnPropertyDescriptor(target, key) {
    return key === 'length' ? { value: { valueOf() { throw Error('must not coerce'); } },
      writable: true, enumerable: false, configurable: false } : Reflect.getOwnPropertyDescriptor(target, key);
  } });
  assert.equal(transportCauseSummary({ errors: malformedArray, transportCauses: { codes: malformedArray } }), undefined);
});

test('depth, aggregate members, visited nodes and retained-summary output are bounded', () => {
  const deep = network('ECONNRESET'); let tail = deep;
  for (let index = 0; index < 100; index++) tail = tail.cause = network('ENETUNREACH');
  assert.equal(transportCauseSummary(deep).truncated, true);
  const wide = new AggregateError(Array.from({ length: 1000 }, () => network('ETIMEDOUT')), 'private');
  assert.deepEqual(transportCauseSummary(wide), { codes: ['ETIMEDOUT'], truncated: true });
  let reads = 0;
  const branch = depth => depth ? new AggregateError(Array.from({ length: 8 }, () => branch(depth - 1))) :
    new Proxy(network('EAI_AGAIN'), { getOwnPropertyDescriptor(target, key) { reads++; return Reflect.getOwnPropertyDescriptor(target, key); } });
  const tree = network('ECONNRESET'); tree.cause = branch(3);
  assert.equal(transportCauseSummary(tree).truncated, true);
  assert.ok(reads <= 32 * 4, 'no unbounded traversal of aggregate members');
  const summary = transportCauseSummary({ transportCauses: { codes: [
    'EAI_AGAIN', 'EAI_FAIL', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
    'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EPIPE', 'UND_ERR_SOCKET',
    'private-token',
  ], truncated: false, private: 'not copied' } });
  assert.equal(summary.codes.length, 12); assert.equal(summary.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 512);
  assert.doesNotMatch(JSON.stringify(summary), /private/);
  assert.deepEqual(transportCauseSummary({ transportCauses: summary }), summary);
});
