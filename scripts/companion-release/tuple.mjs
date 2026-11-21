import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPublishedManifest, verifyPublishedRelease } from '../check-published-release.mjs';

export const REPOS = Object.freeze({ core: 'werg/tendriller', kernel: 'werg/chronolog-db', contrib: 'werg/tendriller-contrib' });
export const GATES = Object.freeze(['ci.yml', 'peer-generation.yml', 'collaboration.yml']);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, null, 2) + '\n';
export function commit(value) { assert.match(value ?? '', /^[a-f0-9]{40}$/, 'Require a full lowercase source SHA'); return value; }
export function checksum(value) { assert.match(value ?? '', /^[a-f0-9]{64}$/, 'Require a SHA-256'); return value; }
export function seal(body) { return { ...body, id: digest(JSON.stringify(body)) }; }
export function validateTuple(tuple) {
  const { id, ...body } = tuple;
  assert.equal(id, digest(JSON.stringify(body)), 'Tuple content digest mismatch');
  assert.equal(tuple.format, 'tendriller-companion-release/v1');
  assert(['published', 'qualified'].includes(tuple.stage));
  for (const key of ['core', 'kernel']) {
    assert.equal(tuple[key].repository, REPOS[key]);
    commit(tuple[key].source); commit(tuple[key].sourceTree);
    assert.equal(tuple[key].dirty, false);
  }
  assert.equal(tuple.release.sourceCommit, tuple.core.source);
  for (const key of ['runtimeId', 'compositionId', 'manifestSha256']) checksum(tuple.release[key]);
  checksum(tuple.kernel.archive.sha256);
  assert(Number.isSafeInteger(tuple.kernel.archive.size) && tuple.kernel.archive.size > 0);
  if (tuple.stage === 'qualified') {
    assert.equal(tuple.contrib.repository, REPOS.contrib);
    commit(tuple.contrib.source); commit(tuple.contrib.sourceTree);
    assert.equal(tuple.contrib.dirty, false);
    assert.deepEqual(tuple.contrib.gates.map(gate => gate.workflow), GATES);
    for (const gate of tuple.contrib.gates) {
      assert(Number.isSafeInteger(gate.run) && gate.run > 0);
      assert(Number.isSafeInteger(gate.attempt) && gate.attempt > 0);
      assert(gate.artifacts.length > 0);
      for (const artifact of gate.artifacts) {
        assert(Number.isSafeInteger(artifact.id) && artifact.id > 0);
        checksum(artifact.sha256);
      }
    }
  } else assert.equal(tuple.contrib, undefined);
  return tuple;
}

// No archive extraction or code execution. Only two fixed metadata members are
// read, after the public downloader has authenticated the complete archive.
function sessionMetadata(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'tendriller-tuple-'));
  try {
    const archive = join(dir, 'session.tgz'); writeFileSync(archive, bytes, { mode: 0o600 });
    const read = name => JSON.parse(execFileSync('tar', ['-xOf', archive, `package/${name}`],
      { timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    return { provenance: read('provenance.json'), pkg: read('package.json') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function identity(api, repository, source) {
  commit(source);
  const result = await api(`repos/${repository}/commits/${source}`);
  assert.equal(result.sha, source, 'Source API returned another commit');
  return { repository, source, sourceTree: commit(result.commit.tree.sha), dirty: false };
}

export async function publishedTuple(source, { api, fetcher, manifestSha256, signal } = {}) {
  commit(source);
  const release = await api(`repos/${REPOS.core}/releases/tags/source-${source}`);
  assert.equal(release.draft, false, 'Require a published release');
  assert.equal(release.tag_name, `source-${source}`);
  const assets = release.assets.filter(asset => asset.name === 'manifest.json');
  assert.equal(assets.length, 1, 'Require one public manifest');
  const apiDigest = assets[0].digest?.replace(/^sha256:/, ''); checksum(apiDigest);
  if (manifestSha256) assert.equal(apiDigest, checksum(manifestSha256), 'Publisher manifest digest differs');
  // Resolve the tag independently. A same-named release cannot point at another commit.
  const tagCommit = await api(`repos/${REPOS.core}/commits/source-${source}`);
  assert.equal(tagCommit.sha, source, 'Source tag does not resolve to the selected commit');
  const bytes = await readPublishedManifest(source, { fetcher, signal });
  assert.equal(digest(bytes), apiDigest, 'Public manifest differs from GitHub release asset digest');
  const manifest = JSON.parse(bytes);
  const expected = { sourceCommit: source, coreRelease: manifest.version, runtimeId: manifest.runtime,
    compositionId: manifest.composition?.id, manifestSha256: apiDigest };
  let composition, session;
  const sessionName = manifest.artifacts?.find(item => item.role === 'session')?.file;
  await verifyPublishedRelease(expected, { fetcher, signal, onVerified(file, content) {
    if (file === 'composition.json') composition = JSON.parse(content);
    if (file === sessionName) session = sessionMetadata(content);
  } });
  const core = await identity(api, REPOS.core, source);
  assert.deepEqual(composition.core, core, 'Core composition/tree mismatch');
  const kernel = await identity(api, REPOS.kernel, composition.chronolog?.session?.source);
  assert.deepEqual(composition.chronolog.session, kernel, 'Kernel composition/tree mismatch');
  const p = session.provenance;
  assert.equal(p.format, 'chronolog-peer-session-package/v1');
  for (const key of ['repository', 'source', 'sourceTree', 'dirty']) assert.equal(p[key], kernel[key], `Session ${key} mismatch`);
  assert.equal(session.pkg.name, '@chronolog/peer-session');
  assert(session.pkg.exports?.['./webrtc-native'], 'Standard native RTC export missing');
  assert.equal(session.pkg.dependencies?.werift, '0.27.0', 'Standard native dependency must be exact');
  const archive = composition.components.find(item => item.role === 'session');
  return validateTuple(seal({ format: 'tendriller-companion-release/v1', stage: 'published',
    core, release: expected, kernel: { ...kernel, archive } }));
}

export async function qualifyContrib(tuple, source, { api } = {}) {
  validateTuple(tuple); assert.equal(tuple.stage, 'published');
  const contrib = await identity(api, REPOS.contrib, source);
  const repo = await api(`repos/${REPOS.contrib}`);
  const main = await api(`repos/${REPOS.contrib}/commits/${repo.default_branch}`);
  assert.equal(main.sha, source, 'Qualify the selected merged Contrib main, not an unmerged candidate');
  const selected = await api(`repos/${REPOS.contrib}/contents/distribution/companion-release.json?ref=${source}`);
  const recorded = validateTuple(JSON.parse(Buffer.from(selected.content, 'base64')));
  assert.equal(recorded.id, tuple.id, 'Contrib qualified a different release tuple');
  const runs = await api(`repos/${REPOS.contrib}/actions/runs?head_sha=${source}&per_page=100`);
  const gates = [];
  for (const workflow of GATES) {
    const run = runs.workflow_runs.filter(run => run.path === `.github/workflows/${workflow}` && run.head_sha === source &&
      run.event === 'push' && run.head_branch === repo.default_branch).sort((a, b) => b.id - a.id)[0];
    assert(run?.status === 'completed' && run.conclusion === 'success', `Merged Contrib ${workflow} gate is not green`);
    const jobs = await api(`repos/${REPOS.contrib}/actions/runs/${run.id}/jobs?per_page=100`);
    assert(jobs.jobs.length > 0 && jobs.total_count === jobs.jobs.length && jobs.jobs.every(job => job.conclusion === 'success'),
      `Incomplete/skipped/failed ${workflow} jobs`);
    const artifacts = await api(`repos/${REPOS.contrib}/actions/runs/${run.id}/artifacts?per_page=100`);
    assert(artifacts.artifacts.length > 0 && artifacts.total_count === artifacts.artifacts.length, `Missing ${workflow} artifacts`);
    gates.push({ workflow, run: run.id, attempt: run.run_attempt, artifacts: artifacts.artifacts.map(item => {
      assert.equal(item.expired, false, 'Expired qualification evidence');
      return { id: item.id, name: item.name, sha256: checksum(item.digest?.replace(/^sha256:/, '')) };
    }) });
  }
  const { id, ...body } = tuple;
  return validateTuple(seal({ ...body, stage: 'qualified', contrib: { ...contrib, gates } }));
}
