import test from 'node:test';
import assert from 'node:assert/strict';
import { networkLabResources } from './resources.mjs';

test('local defaults cap the entire lab at one CPU and one GiB without additional swap', () => {
  const caps = networkLabResources();
  assert.equal(caps.cpus, 1); assert.equal(caps.memoryBytes, 1024 ** 3);
  assert.equal(caps.memorySwapBytes, caps.memoryBytes);
  assert.deepEqual(caps.dockerArgs, ['--cpus=1', '--memory=1073741824', '--memory-swap=1073741824']);
});

test('CI resources are an explicit bounded choice, not an ambient CI-variable escalation', () => {
  const caps = networkLabResources({ memoryMiB: '2048', cpus: '2' });
  assert.equal(caps.memoryBytes, 2 * 1024 ** 3); assert.equal(caps.cpus, 2);
  assert.equal(caps.memorySwapBytes, caps.memoryBytes);
});

test('invalid and excessive resource requests fail before Docker starts', () => {
  for (const memoryMiB of ['0', '511', '4097', '1.5', 'Infinity', 'NaN', ''])
    assert.throws(() => networkLabResources({ memoryMiB }));
  for (const cpus of ['0', '0.1', '3', 'Infinity', 'NaN', ''])
    assert.throws(() => networkLabResources({ cpus }));
});
