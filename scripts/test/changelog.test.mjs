import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  loadReleaseEntries,
  releaseBroadcastId,
  renderChangelogMarkdown,
} from '../release-changelog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('repository releases/entries/*.json validate cleanly and match generated docs/CHANGELOG.md', () => {
  const entries = loadReleaseEntries(root);
  assert(entries.length >= 1, 'Expected at least one release changelog entry');
  for (const entry of entries) {
    if (entry.broadcast) {
      assert.match(entry.broadcast.id, /^bc_[a-z2-7]{26}$/);
      assert.equal(entry.broadcast.id, releaseBroadcastId(entry.slug));
      for (const audience of entry.broadcast.audiences) {
        assert(['agents', 'mcp'].includes(audience), `Deploy broadcast ${entry.slug} must not target human audience ${audience}`);
      }
    }
  }
  const actualMd = readFileSync(join(root, 'docs/CHANGELOG.md'), 'utf8');
  assert.equal(actualMd, renderChangelogMarkdown(entries), 'docs/CHANGELOG.md is stale; run npm run build or node scripts/release-changelog.mjs');
});

test('release changelog validator rejects human UI audiences and deprecations without sunset_at', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-changelog-'));
  try {
    mkdirSync(join(dir, 'releases/entries'), { recursive: true });

    // Human UI audience in deploy entry must be rejected
    writeFileSync(join(dir, 'releases/entries/2026-12-01-bad-audience.json'), JSON.stringify({
      slug: '2026-12-01-bad-audience',
      date: '2026-12-01',
      category: 'feature',
      core_version: '0.3.0-rc.18',
      title: 'Bad audience',
      summary: 'Tries to show a dashboard banner from deploy.',
      broadcast: true,
      audiences: ['agents', 'dashboard'],
    }));
    assert.throws(() => loadReleaseEntries(dir), /deploy-triggered broadcasts may only target agents, mcp/);
    rmSync(join(dir, 'releases/entries/2026-12-01-bad-audience.json'));

    // Deprecation without sunset_at must be rejected
    writeFileSync(join(dir, 'releases/entries/2026-12-01-missing-sunset.json'), JSON.stringify({
      slug: '2026-12-01-missing-sunset',
      date: '2026-12-01',
      category: 'deprecation',
      core_version: '0.3.0-rc.18',
      title: 'Legacy helper deprecated',
      summary: 'Use the replacement helper instead.',
      broadcast: true,
    }));
    assert.throws(() => loadReleaseEntries(dir), /sunset_at/);
    rmSync(join(dir, 'releases/entries/2026-12-01-missing-sunset.json'));

    // Valid deprecation + breaking supersedes chain validates and computes deterministic IDs
    writeFileSync(join(dir, 'releases/entries/2026-12-01-old-api-sunset.json'), JSON.stringify({
      slug: '2026-12-01-old-api-sunset',
      date: '2026-12-01',
      category: 'deprecation',
      core_version: '0.3.0-rc.18',
      title: 'Old helper enters 30-day sunset',
      summary: 'Migrate to newHelper before 2026-12-31.',
      sunset_at: '2026-12-31',
      broadcast: true,
    }));
    writeFileSync(join(dir, 'releases/entries/2026-12-31-old-api-removed.json'), JSON.stringify({
      slug: '2026-12-31-old-api-removed',
      date: '2026-12-31',
      category: 'breaking',
      core_version: '0.3.0-rc.19',
      title: 'Old helper removed',
      summary: 'Upgrade to 0.3.0-rc.19 and use newHelper.',
      supersedes: '2026-12-01-old-api-sunset',
      broadcast: true,
    }));
    const valid = loadReleaseEntries(dir);
    assert.equal(valid.length, 2);
    assert.equal(valid[0].slug, '2026-12-31-old-api-removed');
    assert.equal(valid[0].broadcast.supersedes_id, valid[1].broadcast.id);
    assert.equal(valid[1].broadcast.kind, 'deprecation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
