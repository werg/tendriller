import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { digest, json, seal, publishedTuple, qualifyContrib, validateTuple, GATES, REPOS } from '../companion-release/tuple.mjs';
import { planProposal } from '../companion-release/proposal.mjs';
import { select } from '../companion-release/select.mjs';
import { capabilities, openProposal, dispatchQualification, pushOwnerBootstrap } from '../companion-release/github.mjs';

const sha = letter => letter.repeat(40), hash = letter => letter.repeat(64);
function archive(provenance, pkg) {
  const root = mkdtempSync(join(tmpdir(), 'tuple-fixture-'));
  try {
    mkdirSync(join(root, 'package'));
    writeFileSync(join(root, 'package/provenance.json'), json(provenance));
    writeFileSync(join(root, 'package/package.json'), json(pkg));
    execFileSync('tar', ['-czf', join(root, 'session.tgz'), '-C', root, 'package']);
    return readFileSync(join(root, 'session.tgz'));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function fixture() {
  const core = { repository: REPOS.core, source: sha('a'), sourceTree: sha('b'), dirty: false };
  const kernel = { repository: REPOS.kernel, source: sha('d'), sourceTree: sha('e'), dirty: false };
  const bytes = new Map(), calls = [];
  const asset = (role, file, content = Buffer.from(role)) => {
    bytes.set(file, Buffer.isBuffer(content) ? content : Buffer.from(content));
    return { role, file, sha256: digest(bytes.get(file)), size: bytes.get(file).length,
      url: `https://github.com/werg/tendriller/releases/download/source-${core.source}/${file}` };
  };
  const pkg = { name: '@chronolog/peer-session', exports: { './webrtc-native': './webrtc-native.mjs' }, dependencies: { werift: '0.27.0' } };
  const provenance = { format: 'chronolog-peer-session-package/v1', ...kernel };
  const components = ['sdk', 'runtime', 'engine', 'tools', 'starter'].map(role => asset(role, `${role}.tgz`));
  components.push(asset('session', 'session.tgz', archive(provenance, pkg)));
  const composition = seal({ format: 'tendriller-release-composition-v1', version: '1.2.3', contract: 3,
    core, runtime: hash('c'), chronolog: { session: kernel }, components: components.map(({ url, ...rest }) => rest) });
  const manifest = { format: 'tendriller-core-release', version: '1.2.3', contract: 3, source_commit: core.source,
    source_tree: core.sourceTree, runtime: hash('c'), composition: { id: composition.id, file: 'composition.json' },
    first_app: { file: 'tendriller-first-app-1.2.3.tgz', profile: 'events' },
    artifacts: [...components, asset('composition', 'composition.json', json(composition)),
      asset('first-app', 'tendriller-first-app-1.2.3.tgz'), asset('core-provenance', 'provenance.json'),
      asset('tools-provenance', 'tools.json'), asset('plugin', 'plugin.zip')] };
  bytes.set('manifest.json', Buffer.from(json(manifest)));
  const overrides = new Map();
  const api = async (path, body) => {
    calls.push({ path, body });
    if (overrides.has(path)) return overrides.get(path);
    if (path.endsWith(`/releases/tags/source-${core.source}`)) return { draft: false, tag_name: `source-${core.source}`,
      assets: [{ name: 'manifest.json', digest: `sha256:${digest(bytes.get('manifest.json'))}` }] };
    if (path === `repos/${REPOS.core}/commits/source-${core.source}`) return { sha: core.source };
    for (const item of [core, kernel]) if (path === `repos/${item.repository}/commits/${item.source}`)
      return { sha: item.source, commit: { tree: { sha: item.sourceTree } } };
    throw Error(`Unmocked API: ${path}`);
  };
  const fetcher = async url => {
    const content = bytes.get(new URL(url).pathname.split('/').at(-1));
    return new Response(content || null, { status: content ? 200 : 404 });
  };
  return { core, kernel, bytes, calls, api, fetcher, overrides, manifest, composition,
    check: () => publishedTuple(core.source, { api, fetcher }) };
}

test('public tuple verifies full published graph, clean sources and standard native archive', async () => {
  const f = fixture(), tuple = await f.check();
  assert.equal(tuple.stage, 'published'); assert.equal(tuple.core.source, f.core.source);
  assert.equal(tuple.kernel.sourceTree, f.kernel.sourceTree); validateTuple(tuple);
  assert.deepEqual(select(tuple, 'contrib'), { HOST_REF: f.core.source, CORE_REF: f.core.source, CHRONOLOG_REF: f.kernel.source });
  assert(f.calls.every(call => !call.body));
});
test('missing public artifacts and changed bytes cannot become a proposal', async t => {
  for (const name of ['session.tgz', 'sdk.tgz', 'tendriller-first-app-1.2.3.tgz']) await t.test(name, async () => {
    const f = fixture(); f.bytes.delete(name); await assert.rejects(f.check(), { code: 'release_unavailable' });
  });
  const f = fixture(); f.bytes.set('session.tgz', Buffer.from('changed'));
  await assert.rejects(f.check(), { code: 'release_bytes_mismatch' });
});
test('release tag, publisher digest and source tree mismatches fail closed', async t => {
  const changes = [
    f => f.overrides.set(`repos/${REPOS.core}/commits/source-${f.core.source}`, { sha: sha('f') }),
    f => f.overrides.set(`repos/${REPOS.core}/commits/${f.core.source}`, { sha: f.core.source, commit: { tree: { sha: sha('f') } } }),
    f => f.overrides.set(`repos/${REPOS.kernel}/commits/${f.kernel.source}`, { sha: f.kernel.source, commit: { tree: { sha: sha('f') } } }),
  ];
  for (const [i, change] of changes.entries()) await t.test(String(i), async () => {
    const f = fixture(); change(f); await assert.rejects(f.check());
  });
  const f = fixture(); await assert.rejects(publishedTuple(f.core.source, { api: f.api, fetcher: f.fetcher, manifestSha256: hash('f') }));
});
test('tuple mutation, shortened override and wrong stage are rejected', async () => {
  const f = fixture(), tuple = await f.check();
  assert.throws(() => select(tuple, 'contrib', { TENDRILLER_REF: 'main' }));
  assert.throws(() => select(tuple, 'chronolog'));
  assert.throws(() => validateTuple({ ...tuple, stage: 'qualified' }));
});

function addQualification(f, tuple) {
  const source = sha('f'), root = `repos/${REPOS.contrib}`;
  f.overrides.set(root, { default_branch: 'main' });
  const identity = { sha: source, commit: { tree: { sha: sha('1') } } };
  f.overrides.set(`${root}/commits/main`, identity); f.overrides.set(`${root}/commits/${source}`, identity);
  f.overrides.set(`${root}/contents/distribution/companion-release.json?ref=${source}`, { content: Buffer.from(json(tuple)).toString('base64') });
  const runs = GATES.map((name, i) => ({ id: i + 1, run_attempt: 1, path: `.github/workflows/${name}`, head_sha: source,
    head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' }));
  f.overrides.set(`${root}/actions/runs?head_sha=${source}&per_page=100`, { workflow_runs: runs });
  for (const run of runs) {
    f.overrides.set(`${root}/actions/runs/${run.id}/jobs?per_page=100`, { total_count: 1, jobs: [{ conclusion: 'success' }] });
    f.overrides.set(`${root}/actions/runs/${run.id}/artifacts?per_page=100`, { total_count: 1,
      artifacts: [{ id: run.id, name: 'proof', digest: `sha256:${hash('a')}`, expired: false }] });
  }
  return { source, runs, root };
}
test('merged Contrib gate evidence is exact, complete, unexpired and binds the selected tuple', async () => {
  const f = fixture(), tuple = await f.check(), q = addQualification(f, tuple);
  const qualified = await qualifyContrib(tuple, q.source, { api: f.api });
  assert.equal(qualified.stage, 'qualified'); assert.equal(qualified.contrib.gates.length, 3);
  assert.equal(select(qualified, 'chronolog').CONTRIB_REF, q.source);
  q.runs[2].conclusion = 'failure'; await assert.rejects(qualifyContrib(tuple, q.source, { api: f.api }));
});
test('a green run for another tuple, non-main head, partial jobs or expired evidence is insufficient', async t => {
  for (const issue of ['tuple', 'main', 'skipped', 'expired', 'partial']) await t.test(issue, async () => {
    const f = fixture(), tuple = await f.check(), q = addQualification(f, tuple);
    if (issue === 'tuple') f.overrides.set(`${q.root}/contents/distribution/companion-release.json?ref=${q.source}`, { content: Buffer.from(json({ ...tuple, id: hash('f') })).toString('base64') });
    if (issue === 'main') q.runs[0].event = 'pull_request';
    if (issue === 'skipped') f.overrides.get(`${q.root}/actions/runs/1/jobs?per_page=100`).jobs[0].conclusion = 'skipped';
    if (issue === 'partial') f.overrides.get(`${q.root}/actions/runs/1/jobs?per_page=100`).total_count = 2;
    if (issue === 'expired') f.overrides.get(`${q.root}/actions/runs/1/artifacts?per_page=100`).artifacts[0].expired = true;
    await assert.rejects(qualifyContrib(tuple, q.source, { api: f.api }));
  });
});
test('capability probe never claims write permission from readable/public or push metadata', async () => {
  const calls = [];
  const result = await capabilities(async (path, body) => { calls.push(body); return { permissions: { push: true } }; });
  assert(result.repositories.every(item => item.proposalWrite === 'unverified'));
  assert(calls.every(body => body === undefined));
  await assert.rejects(openProposal({}, { authKind: 'repository' }));
});

function planningApi(f, mode, existing = {}) {
  const repository = mode === 'contrib' ? REPOS.contrib : REPOS.kernel;
  const root = `repos/${repository}`, base = sha('2'), tree = sha('3');
  const workflows = mode === 'contrib' ? {
    '.github/workflows/peer-generation.yml': readFileSync(new URL('./fixtures/companion-release/contrib-peer.yml', import.meta.url), 'utf8'),
    '.github/workflows/collaboration.yml': readFileSync(new URL('./fixtures/companion-release/contrib-collaboration.yml', import.meta.url), 'utf8'),
  } : { '.github/workflows/webrtc.yml': readFileSync(new URL('./fixtures/companion-release/chronolog-webrtc.yml', import.meta.url), 'utf8') };
  Object.assign(workflows, existing);
  const calls = [], api = async (path, body) => {
    calls.push({ path, body });
    if (path === root) return { default_branch: 'main' };
    if (path === `${root}/commits/main`) return { sha: base, commit: { tree: { sha: tree } } };
    if (path === `${root}/git/trees/${tree}?recursive=1`) return { truncated: false, tree: Object.keys(workflows).map(path => ({ path })) };
    const prefix = `${root}/contents/`;
    if (path.startsWith(prefix)) {
      const file = path.slice(prefix.length).split('?')[0], content = workflows[file];
      assert.equal(typeof content, 'string', `Unknown fixture path ${file}`);
      return { encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
    }
    throw Error(`Unexpected planning API: ${path}`);
  };
  return { api, calls, workflows, root };
}

test('end-to-end dry run migrates both actual workflow shapes, runs generated guards and selects exact sources', async t => {
  const f = fixture(), published = await f.check(), q = addQualification(f, published);
  const qualified = await qualifyContrib(published, q.source, { api: f.api });
  for (const [mode, tuple] of [['contrib', published], ['chronolog', qualified]]) await t.test(mode, async () => {
    const p = planningApi(f, mode), plan = await planProposal(tuple, { api: p.api });
    assert(p.calls.every(call => !call.body));
    assert(plan.files['.github/workflows/companion-release-receiver.yml'].includes('--auth-kind repository'));
    if (mode === 'contrib') for (const name of ['peer-generation', 'collaboration'])
      assert(plan.files[`.github/workflows/${name}.yml`].includes("github.event_name == 'workflow_dispatch' && 'explicit' || 'ordinary'"));
    const root = mkdtempSync(join(tmpdir(), 'tuple-dry-run-'));
    try {
      for (const [name, value] of Object.entries(plan.files)) {
        const file = join(root, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, value);
      }
      const env = { ...process.env, TENDRILLER_REF: '', CHRONOLOG_REF_INPUT: '', CONTRIB_REF_INPUT: '' };
      delete env.NODE_TEST_CONTEXT;
      const output = execFileSync(process.execPath, ['distribution/select-companion-release.mjs', mode], { cwd: root, env, encoding: 'utf8' });
      assert(output.includes(`HOST_REF=${tuple.core.source}`));
      const guardResult = execFileSync(process.execPath, ['--test', '--test-reporter=tap', mode === 'contrib' ? 'test/companion-workflow-pins.test.mjs' : 'tools/test-companion-workflow-pins.mjs'], { cwd: root, env, encoding: 'utf8' });
      assert.match(guardResult, /# pass [12]/);
      execFileSync(process.execPath, ['distribution/release-automation/companion-release/cli.mjs', '--help'], { cwd: root, env });
    } finally { rmSync(root, { recursive: true, force: true }); }
    // Once bootstrapped, only tuple data changes. No workflow-write permission
    // or recurring executable update is needed by the repository token.
    const same = planningApi(f, mode, plan.files);
    const unchanged = await planProposal(tuple, { api: same.api });
    assert.deepEqual(unchanged.files, {});
    const updated = seal({ ...Object.fromEntries(Object.entries(tuple).filter(([key]) => key !== 'id')),
      release: { ...tuple.release, manifestSha256: hash('9') } });
    const next = await planProposal(updated, { api: same.api });
    assert.deepEqual(Object.keys(next.files), ['distribution/companion-release.json']);
  });
});

test('unknown workflow shape stops a proposal rather than silently changing qualification', async () => {
  const f = fixture(), tuple = await f.check(), p = planningApi(f, 'contrib', { '.github/workflows/peer-generation.yml': 'custom workflow' });
  await assert.rejects(planProposal(tuple, { api: p.api }));
});

test('repository token writes only its own tuple; PR generation never merges or force-updates; dispatch is explicit', async () => {
  const f = fixture(), tuple = await f.check(), p = planningApi(f, 'contrib');
  const bootstrap = await planProposal(tuple, { api: p.api });
  await assert.rejects(openProposal(bootstrap, { api: p.api, authKind: 'repository', repository: REPOS.contrib }));
  const plan = { ...bootstrap, files: { 'distribution/companion-release.json': json(tuple) } }, calls = [], dispatchedWorkflows = new Set();
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith('/commits/main')) return { sha: plan.base };
    if (path.includes('/pulls?')) return [];
    if (path.includes('/git/matching-refs/')) return [];
    if (path.endsWith('/git/trees')) return { sha: sha('4') };
    if (path.endsWith('/git/commits')) return { sha: sha('5') };
    if (path.endsWith('/git/refs')) return {};
    if (path.endsWith('/pulls')) return { html_url: 'https://github.com/werg/tendriller-contrib/pull/123' };
    if (path.endsWith(`/commits/${plan.branch}`)) return { sha: sha('5') };
    if (path.includes('/runs?')) return { workflow_runs: dispatchedWorkflows.has(path.split('/workflows/')[1].split('/')[0]) ?
      [{ id: 111, head_sha: sha('5'), head_branch: plan.branch, event: 'workflow_dispatch', status: 'queued', conclusion: null }] : [] };
    if (path.endsWith('/dispatches')) { dispatchedWorkflows.add(path.split('/workflows/')[1].split('/')[0]); return null; }
    throw Error(`Unexpected write path ${path}`);
  };
  await assert.rejects(openProposal(plan, { api, authKind: 'repository', repository: REPOS.core })); assert.equal(calls.length, 0);
  const result = await openProposal(plan, { api, authKind: 'repository', repository: REPOS.contrib });
  const dispatched = await dispatchQualification(plan, result.head, { api });
  assert.deepEqual(dispatched.dispatched, GATES);
  assert(calls.every(call => !/\/merge|\/git\/refs\//.test(call.path)));
  assert(calls.filter(call => call.path.endsWith('/dispatches')).every(call => call.body.ref === plan.branch));
  await dispatchQualification(plan, result.head, { api });
  assert.equal(calls.filter(call => call.path.endsWith('/dispatches')).length, 3, 'Do not duplicate existing exact-head CI on a scheduled retry');
});

test('moved base or changed dispatch head stops before further writes', async () => {
  const f = fixture(), tuple = await f.check(), p = planningApi(f, 'contrib');
  const plan = await planProposal(tuple, { api: p.api }), calls = [];
  const api = async (path, body) => { calls.push(body); return { sha: sha('f') }; };
  await assert.rejects(openProposal(plan, { api, authKind: 'user' }));
  await assert.rejects(dispatchQualification(plan, sha('1'), { api }));
  assert(calls.every(body => !body));
});

test('owner bootstrap uses real isolated Git, exact base/tree, no force and rejects symlink writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'tuple-git-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--quiet', '--bare', 'remote.git'); git('init', '--quiet', 'source');
    writeFileSync(join(root, 'source/readme'), 'baseline');
    symlinkSync('../outside', join(root, 'source/external'));
    git('-C', 'source', 'add', 'readme', 'external');
    git('-C', 'source', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--no-gpg-sign', '-m', 'base');
    const base = git('-C', 'source', 'rev-parse', 'HEAD'), baseTree = git('-C', 'source', 'rev-parse', 'HEAD^{tree}');
    git('-C', 'source', 'push', '--quiet', join(root, 'remote.git'), 'HEAD:refs/heads/main');
    const plan = { repository: REPOS.contrib, base, baseTree, branch: 'release/test', title: 'Install receiver',
      files: { '.github/workflows/receiver.yml': 'name: test\n' } };
    const head = pushOwnerBootstrap(plan, { remote: join(root, 'remote.git') });
    assert.equal(git('--git-dir=remote.git', 'rev-parse', 'refs/heads/release/test'), head);
    assert.equal(git('--git-dir=remote.git', 'show', `${head}:.github/workflows/receiver.yml`), 'name: test');
    assert.equal(git('--git-dir=remote.git', 'rev-parse', 'refs/heads/main'), base);
    assert.throws(() => pushOwnerBootstrap({ ...plan, baseTree: sha('f') }, { remote: join(root, 'remote.git') }));
    assert.throws(() => pushOwnerBootstrap({ ...plan, files: { '../escape': 'bad' } }, { remote: join(root, 'remote.git') }));
    assert.throws(() => pushOwnerBootstrap({ ...plan, files: { 'external/escape': 'bad' } }, { remote: join(root, 'remote.git') }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recover a verified branch after lost PR creation; changed bytes/ancestry/scope fail closed', async t => {
  const f = fixture(), tuple = await f.check(), p = planningApi(f, 'contrib');
  const bootstrap = await planProposal(tuple, { api: p.api });
  const path = 'distribution/companion-release.json';
  const plan = { ...bootstrap, files: { [path]: json(tuple) } }, head = sha('7');
  for (const variant of ['valid', 'bytes', 'ancestry', 'scope']) await t.test(variant, async () => {
    const calls = [];
    const api = async (endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint.endsWith('/commits/main')) return { sha: plan.base };
      if (endpoint.includes('/pulls?')) return [];
      if (endpoint.includes('/git/matching-refs/')) return [{ ref: `refs/heads/${plan.branch}`, object: { sha: head } }];
      if (endpoint.includes('/compare/')) return { status: 'ahead', total_commits: 1, files: [{ filename: variant === 'scope' ? 'unexpected' : path }] };
      if (endpoint.includes('/git/commits/')) return { parents: [{ sha: variant === 'ancestry' ? sha('f') : plan.base }] };
      if (endpoint.includes('/contents/')) return { encoding: 'base64', content: Buffer.from(variant === 'bytes' ? 'changed' : json(tuple)).toString('base64') };
      if (endpoint.endsWith('/pulls') && body) return { html_url: 'https://github.com/werg/tendriller-contrib/pull/123' };
      throw Error(`Unexpected branch recovery request ${endpoint}`);
    };
    const operation = openProposal(plan, { api, authKind: 'repository', repository: REPOS.contrib });
    if (variant === 'valid') {
      const result = await operation; assert.equal(result.head, head);
      assert.equal(calls.filter(call => call.body).length, 1, 'Only finish PR creation; never recreate/move the branch');
    } else { await assert.rejects(operation); assert(calls.every(call => !call.body)); }
  });
});
