import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionNative } from '../review/provision.mjs';

const nativeKey = 'ab'.repeat(32);
// A scripted page and native CLI: public records only cross between them, in the exact required order.
function fixture({ importResult = { imported: true }, keyResult = { publicKey: nativeKey } } = {}) {
  const log = [], values = { '#transfer-out': '' };
  const click = name => async () => { log.push('click:' + name); };
  const page = {
    locator(selector) {
      if (selector === '[data-provisioning="status"]') return { filter: ({ hasText }) => ({ waitFor: async () => { log.push('status:' + hasText.source.slice(0, 24)); } }) };
      return { click: click(selector), fill: async value => { log.push('fill:' + selector); values[selector] = value; }, inputValue: async () => values[selector] ?? '' };
    },
    getByLabel: label => ({ fill: async value => { log.push('label:' + label + '=' + value.slice(0, 4)); } }),
    getByRole: (_role, { name }) => ({ click: async () => {
      log.push('button:' + name);
      if (name === 'Create account-bound challenge for this key') values['#transfer-out'] = JSON.stringify({ applicationId: 'a'.repeat(64), publicKey: nativeKey, challenge: 'cd'.repeat(16) });
      if (name === 'Grant reviewed rights and wrap keys') values['#transfer-out'] = JSON.stringify({ record: 'package' });
    } }),
  };
  const calls = [];
  const run = args => {
    calls.push(args[0]); log.push('native:' + args[0]);
    if (args[0] === 'signer-key') return JSON.stringify(keyResult);
    if (args[0] === 'sign-enrollment') return JSON.stringify({ record: 'proof' }) + '\n';
    if (args[0] === 'provisioning-request') return JSON.stringify({ record: 'request' }) + '\n';
    return JSON.stringify(importResult);
  };
  return { page, run, log, calls, values };
}

test('native provisioning proves the native key, then transfers keys only through the reviewed recipient package', async t => {
  const project = mkdtempSync(join(tmpdir(), 'review-provision-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  const f = fixture();
  await provisionNative({ page: f.page, run: f.run, project });
  assert.deepEqual(f.calls, ['signer-key', 'sign-enrollment', 'provisioning-request', 'import-provisioning']);
  const steps = f.log.filter(entry => entry.startsWith('button:') || entry.startsWith('native:'));
  assert.deepEqual(steps, ['native:signer-key', 'button:Create account-bound challenge for this key', 'native:sign-enrollment',
    'button:Record external signed enrollment proof from incoming field', 'native:provisioning-request', 'button:Review recipient fingerprint',
    'button:Grant reviewed rights and wrap keys', 'native:import-provisioning']);
  assert.equal(JSON.parse(readFileSync(join(project, 'native-challenge.json'))).publicKey, nativeKey);
  assert.deepEqual(JSON.parse(readFileSync(join(project, 'native-provisioning.json'))), { record: 'package' });
  assert.equal(f.values['#transfer-in'], '{"record":"request"}', 'the browser reviews the exact public request');
  // No private material or replacement key is requested from the page, and no root/key creation command exists in the sequence.
  assert(!f.calls.some(name => /root|epoch|bootstrap|create-key/.test(name)));
});

test('an invalid native key or a failed import stops explicitly without a success result', async t => {
  const project = mkdtempSync(join(tmpdir(), 'review-provision-')); t.after(() => rmSync(project, { recursive: true, force: true }));
  const bad = fixture({ keyResult: { publicKey: 'not-a-key' } });
  await assert.rejects(provisionNative({ page: bad.page, run: bad.run, project }), /NATIVE_DEVICE_KEY_INVALID/);
  assert.deepEqual(bad.log, ['native:signer-key'], 'no browser action precedes a valid native key');
  const failed = fixture({ importResult: { imported: false } });
  await assert.rejects(provisionNative({ page: failed.page, run: failed.run, project }), /NATIVE_PROVISIONING_NOT_IMPORTED/);
});
