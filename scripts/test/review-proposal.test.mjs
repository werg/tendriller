import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installReviewFixtureSources, validateReviewProposal, REVIEW_FIXTURE_FILES } from '../review/fixture.mjs';

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
  for (const name of ['@tendriller/core', '@chronolog/peer-session', '@chronolog/authority', '@tendriller/tools']) {
    const directory = join(project, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './stub.mjs', './*': './stub.mjs' } }));
    const sources = REVIEW_FIXTURE_FILES.filter(([file]) => file.endsWith('.mjs')).map(([file]) => readFileSync(join(project, file), 'utf8')).join('\n');
    const exports = new Set([...sources.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](@[^'"]+)['"]/g)]
      .filter(match => match[2] === name || match[2].startsWith(name + '/'))
      .flatMap(match => match[1].split(',').map(value => value.trim())));
    writeFileSync(join(directory, 'stub.mjs'), [...exports].map(value => value === 'proposeApplicationAssistant'
      ? `export async function proposeApplicationAssistant(options) {
          if (options.key !== 'retained-key' || options.queries[0] !== 'checklist') throw Error('Unexpected proposal options');
          return {reviewUrl:'https://example.invalid/review', proposed:'${proposed}', approved:process.env.REVIEW_APPROVED === 'true'};
        }`
      : value === 'createAssistantKey' ? `export function createAssistantKey(){throw Error('Must preserve existing key');}`
      : value === 'openWorkspace' ? `import { readFile, writeFile } from 'node:fs/promises';
        // The installed tools package supplies the page context; only its write-once private records are exercised here.
        export function openWorkspace({ root }) { return { async pageContext() {
          const path = name => new URL('.private/' + name, 'file://' + root);
          return { page: { id: 'aaaaaaaaaaaa', name: 'Checklist', applicationId: 'test' }, host: { id: 'aaaaaaaaaaaa' },
            async readPrivate(name, optional) { try { return JSON.parse(await readFile(path(name), 'utf8')); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; } },
            async savePrivate(name, value) { const text = JSON.stringify(value, null, 2) + '\\n';
              try { await writeFile(path(name), text, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST' || await readFile(path(name), 'utf8') !== text) throw error; } return value; } };
        } }; }`
        : `export const ${value} = value => value;`).join('\n'));
  }
  mkdirSync(join(project, '.private'));
  const keyPath = join(project, '.private/assistant-key.json');
  writeFileSync(keyPath, JSON.stringify('retained-key', null, 2) + '\n');
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

test('fixture sources contain no removed ordering bootstrap, native-required claim, fake owner or host-owned data', () => {
  const root = resolve(import.meta.dirname, '../..');
  const removed = /schemaAdministrator|participantGrant|signTransitionRequest|selectGeneration|connectControlParticipant|configureApplication|openNativeApplication|createGenerationRegistry|orderingPause|processPairings|pending-publication|example\.invalid|(?<![.\w])createPage\(|\.deviceId\b|owner_account_id/;
  for (const [file, source] of REVIEW_FIXTURE_FILES) {
    const text = readFileSync(resolve(root, source), 'utf8');
    assert.doesNotMatch(text, removed, file);
  }
  const app = readFileSync(resolve(root, 'plugin/review-app.mjs'), 'utf8');
  // Browser-first: the page is signed and published before any browser key exists, and native participation is explicitly optional.
  assert.match(app, /OPTIONAL/); assert.match(app, /no native process is a prerequisite/);
  assert.match(app, /@tendriller\/tools\/workspace/, 'The fixture is a workspace with one account credential and one shared signer');
  assert.doesNotMatch(app, /createClient|prepareTendrilSetup|publisher\.json|--session/, 'No per-page client, separate page publisher or session-file compatibility');
  assert.doesNotMatch(app, /must remain running for reviewer reads, writes/);
});
