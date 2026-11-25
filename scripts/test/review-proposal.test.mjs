import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installReviewFixtureSources, validateReviewProposal } from '../review/fixture.mjs';

const proposed = 'a'.repeat(64);
test('proposal validation rejects missing or malformed identities before replay equality', () => {
  for (const value of [undefined, null, 123, '', 'a'.repeat(63), 'g'.repeat(64)]) {
    assert.throws(() => validateReviewProposal({ proposed: value, approved: true }), /hex64/);
  }
  assert.throws(() => validateReviewProposal({ proposed }), /boolean/);
  assert.throws(() => validateReviewProposal({ proposed, approved: 'true' }), /boolean/);
  assert.deepEqual(validateReviewProposal({ proposed, approved: false }), { proposed, approved: false });
});

test('installed fixture propose CLI exposes identity and approval on replay while retaining its adapter key', t => {
  const project = mkdtempSync(join(tmpdir(), 'review-proposal-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  installReviewFixtureSources(resolve(import.meta.dirname, '../..'), project);
  // Substitute only public package boundaries; execute the actual copied CLI and
  // its durable proposal write. No native owner or remote account is opened.
  for (const name of ['@tendriller/core', '@chronolog/peer-session']) {
    const directory = join(project, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './stub.mjs', './*': './stub.mjs' } }));
    const sources = ['review-app.mjs', 'review-domain.mjs'].map(file => readFileSync(join(project, file), 'utf8')).join('\n');
    const exports = new Set([...sources.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](@[^'"]+)['"]/g)]
      .filter(match => match[2] === name || match[2].startsWith(name + '/'))
      .flatMap(match => match[1].split(',').map(value => value.trim())));
    writeFileSync(join(directory, 'stub.mjs'), [...exports].map(value => value === 'proposeApplicationAssistant'
      ? `export async function proposeApplicationAssistant(options) {
          if (options.key !== 'retained-key' || options.queries[0] !== 'checklist') throw Error('Unexpected proposal options');
          return {reviewUrl:'https://example.invalid/review', proposed:'${proposed}', approved:process.env.REVIEW_APPROVED === 'true'};
        }`
      : value === 'createAssistantKey' ? `export function createAssistantKey(){throw Error('Must preserve existing key');}`
      : value === 'createAgentClient' ? `export function createAgentClient(){return {page:id=>({id})};}`
        : `export const ${value} = value => value;`).join('\n'));
  }
  mkdirSync(join(project, '.private'));
  const keyPath = join(project, '.private/assistant-key.json');
  writeFileSync(keyPath, JSON.stringify('retained-key'));
  writeFileSync(join(project, '.private/handle.json'), JSON.stringify({ id: 'aaaaaaaaaaaa', service: 'https://example.invalid', api: 'https://example.invalid/api/agent/pages/aaaaaaaaaaaa', token: 'synthetic', application: { id: 'test' }, name: 'Checklist' }));
  const beforeKey = readFileSync(keyPath);
  for (const approved of [false, true]) {
    const result = validateReviewProposal(JSON.parse(execFileSync(process.execPath, ['review-app.mjs', 'propose'], {
      cwd: project, encoding: 'utf8', env: { ...process.env, REVIEW_APPROVED: String(approved) }, timeout: 10000,
    })));
    assert.deepEqual(result, { reviewUrl: 'https://example.invalid/review', proposed, approved });
    assert.deepEqual(JSON.parse(readFileSync(join(project, '.private/assistant-proposal.json'))), {
      proposed, adapterHash: createHash('sha256').update('retained-key').digest('hex'),
    });
    assert.deepEqual(readFileSync(keyPath), beforeKey);
  }
});
