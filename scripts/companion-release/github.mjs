import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { REPOS, checksum, commit } from './tuple.mjs';

// Use gh's credential provider. Tokens are never argv, URLs, reports or errors.
export function githubApi(path, body) {
  assert(/^repos\/werg\/(tendriller|tendriller-contrib|chronolog-db)(\/|$)/.test(path));
  assert(!path.includes('..') && !/[\r\n#]/.test(path));
  return new Promise((resolve, reject) => {
    const args = ['api', '--hostname', 'github.com', path, '--method', body ? 'POST' : 'GET'];
    if (body) args.push('--input', '-');
    const child = execFile('gh', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const status = stderr.match(/HTTP (\d{3})/)?.[1] || 'unknown';
        return reject(Object.assign(Error(`GitHub ${body ? 'POST' : 'GET'} ${path.split('?')[0]} failed (HTTP ${status}); verify access, permissions and API availability.`),
          { code: 'github_request_failed', status: status === 'unknown' ? null : Number(status), endpoint: path.split('?')[0] }));
      }
      try { resolve(stdout ? JSON.parse(stdout) : null); }
      catch { reject(Error('GitHub returned invalid JSON')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function capabilities(api = githubApi) {
  const repositories = [];
  for (const repository of Object.values(REPOS)) {
    try {
      const result = await api(`repos/${repository}`);
      repositories.push({ repository, readable: true, reportedPush: result.permissions?.push ?? null,
        // Repository push rights do not prove this token has PR/workflow write.
        proposalWrite: 'unverified', requiredForProposal: ['contents:write', 'pull_requests:write', 'workflows:write'] });
    } catch { repositories.push({ repository, readable: false, reportedPush: null, proposalWrite: 'unverified' }); }
  }
  return { mode: 'read-only-probe', repositories,
    nextAction: 'Bootstrap target-owned receivers once with existing owner authorization. Their own GITHUB_TOKEN updates tuple data and explicitly dispatches normal qualification; no new cross-repository secret is required. No write permission is inferred from this probe.' };
}

// Existing owner SSH identity can bootstrap workflow changes even when their gh
// OAuth token has repo but not workflow scope. No token escalation/new secret.
// Normal receivers never enter this path: they may change only tuple JSON.
export function pushOwnerBootstrap(plan, { remote = `git@github.com:${plan.repository}.git` } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tendriller-companion-bootstrap-'));
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10' } });
  try {
    git(['init', '--template=', '--quiet']); git(['remote', 'add', 'origin', remote]);
    git(['fetch', '--quiet', '--depth=1', 'origin', plan.base]); git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    assert.equal(git(['rev-parse', 'HEAD']).trim(), plan.base);
    assert.equal(git(['rev-parse', 'HEAD^{tree}']).trim(), plan.baseTree);
    for (const [path, content] of Object.entries(plan.files)) {
      assert(!path.startsWith('/') && !path.split('/').includes('..'));
      const target = join(root, path);
      for (let candidate = target; relative(root, candidate); candidate = dirname(candidate)) {
        try { assert.equal(lstatSync(candidate).isSymbolicLink(), false, 'Bootstrap target must not follow symlinks'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
    }
    git(['add', '--', ...Object.keys(plan.files)]);
    git(['-c', 'user.name=Tendriller release proposal', '-c', 'user.email=release-proposal@users.noreply.github.com',
      'commit', '--quiet', '--no-gpg-sign', '-m', plan.title]);
    const head = commit(git(['rev-parse', 'HEAD']).trim());
    git(['push', '--quiet', 'origin', `HEAD:refs/heads/${plan.branch}`]);
    return head;
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    throw Error('Owner SSH bootstrap failed; existing repository write authorization and known GitHub host identity are required. No credential or unsafe host-key fallback is attempted.');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// Only a generated in-memory plan reaches this adapter; CLI never applies a plan
// file from disk. Reverification and planning happen again in the applying run.
export async function openProposal(plan, { api = githubApi, authKind, repository = process.env.GITHUB_REPOSITORY,
  ownerBootstrap = pushOwnerBootstrap } = {}) {
  assert(['app', 'user', 'repository'].includes(authKind), 'Explicit authentication kind required');
  if (authKind === 'repository') {
    assert.equal(repository, plan.repository, 'Repository token may only propose its own repository');
    assert(Object.keys(plan.files).every(path => path === 'distribution/companion-release.json'),
      'Bootstrap workflow/code changes require the existing authorized owner/App credential once; the receiver only updates tuple data');
  }
  assert([REPOS.contrib, REPOS.kernel].includes(plan.repository));
  commit(plan.base); commit(plan.baseTree); checksum(plan.tupleId); commit(plan.automationSource);
  assert.equal(plan.branch, `release/tuple-${plan.tupleId.slice(0, 16)}-${plan.automationSource.slice(0, 12)}`);
  const root = `repos/${plan.repository}`;
  const current = await api(`${root}/commits/${plan.baseBranch}`);
  assert.equal(current.sha, plan.base, 'Default branch moved; replan against its new exact source');
  const existing = await api(`${root}/pulls?state=all&head=werg:${plan.branch}&per_page=100`);
  assert(existing.length < 100, 'Incomplete existing proposal listing');
  if (existing.length) {
    assert.equal(existing.length, 1);
    const pr = existing[0];
    assert.equal(pr.base.ref, plan.baseBranch);
    // Never reopen, merge, force-push or silently repair a closed/edited proposal.
    assert.equal(pr.state, 'open', 'Proposal already closed; review its disposition before replanning');
    assert.equal(pr.body, plan.body, 'Existing proposal was edited');
    const files = await api(`${root}/pulls/${pr.number}/files?per_page=100`);
    assert.deepEqual(files.map(item => item.filename).sort(), Object.keys(plan.files).sort(), 'Existing proposal file scope changed');
    for (const [path, content] of Object.entries(plan.files)) {
      const file = await api(`${root}/contents/${path}?ref=${commit(pr.head.sha)}`);
      assert.equal(Buffer.from(file.content, 'base64').toString('utf8'), content, 'Existing proposal bytes changed');
    }
    return { state: 'existing', repository: plan.repository, url: pr.html_url, head: pr.head.sha };
  }
  const paths = Object.keys(plan.files);
  assert(paths.length >= 1 && paths.length <= 6);
  for (const path of paths) assert(/^(distribution\/(companion-release\.json|select-companion-release\.mjs)|(?:test|tools)\/companion-workflow-pins\.test\.mjs|tools\/test-companion-workflow-pins\.mjs|\.github\/workflows\/(peer-generation|collaboration|webrtc|companion-release-receiver)\.yml)$/.test(path));
  let head;
  const refs = await api(`${root}/git/matching-refs/heads/${plan.branch}`);
  assert(refs.length < 100, 'Incomplete branch listing');
  const branch = refs.filter(ref => ref.ref === `refs/heads/${plan.branch}`);
  assert(branch.length <= 1);
  if (branch.length) {
    head = commit(branch[0].object.sha);
    const comparison = await api(`${root}/compare/${plan.base}...${head}`);
    assert.equal(comparison.status, 'ahead'); assert.equal(comparison.total_commits, 1);
    assert.deepEqual(comparison.files.map(file => file.filename).sort(), paths.sort(), 'Existing orphan branch scope changed');
    const candidate = await api(`${root}/git/commits/${head}`);
    assert.deepEqual(candidate.parents.map(parent => parent.sha), [plan.base], 'Existing orphan branch ancestry changed');
    for (const [path, content] of Object.entries(plan.files)) {
      const file = await api(`${root}/contents/${path}?ref=${head}`);
      assert.equal(file.encoding, 'base64');
      assert.equal(Buffer.from(file.content, 'base64').toString('utf8'), content, 'Existing orphan branch bytes changed');
    }
  }
  else if (authKind === 'user' && paths.some(path => path.startsWith('.github/workflows/'))) head = ownerBootstrap(plan);
  else {
    const tree = await api(`${root}/git/trees`, { base_tree: plan.baseTree,
      tree: paths.map(path => ({ path, mode: '100644', type: 'blob', content: plan.files[path] })) });
    const created = await api(`${root}/git/commits`, { message: plan.title, tree: commit(tree.sha), parents: [plan.base] });
    head = commit(created.sha);
    await api(`${root}/git/refs`, { ref: `refs/heads/${plan.branch}`, sha: head });
  }
  const pr = await api(`${root}/pulls`, { title: plan.title, body: plan.body, base: plan.baseBranch, head: plan.branch });
  return { state: 'opened', repository: plan.repository, url: pr.html_url, head,
    nextAction: 'Normal CI and review are required. Approve workflow execution if GitHub requires it. No merge/deployment is attempted.' };
}

export async function dispatchQualification(plan, head, { api = githubApi } = {}) {
  const workflows = plan.mode === 'contrib' ? ['ci.yml', 'peer-generation.yml', 'collaboration.yml'] : ['ci.yml', 'browser-peer.yml', 'webrtc.yml'];
  commit(head);
  const root = `repos/${plan.repository}`;
  assert.equal((await api(`${root}/commits/${plan.branch}`)).sha, head, 'Proposal head changed before dispatch');
  const runs = [];
  for (const workflow of workflows) {
    const endpoint = `${root}/actions/workflows/${workflow}`;
    const find = async () => {
      const result = await api(`${endpoint}/runs?head_sha=${head}&event=workflow_dispatch&per_page=100`);
      return result.workflow_runs.filter(run => run.head_sha === head && run.head_branch === plan.branch &&
        run.event === 'workflow_dispatch').sort((a, b) => b.id - a.id)[0];
    };
    let run = await find();
    if (!run) {
      await api(`${endpoint}/dispatches`, { ref: plan.branch });
      for (let attempt = 0; attempt < 10 && !run; attempt++) {
        run = await find(); if (!run) await setTimeout(1000);
      }
    }
    assert(run, `Dispatched ${workflow} but no exact-head run observed; inspect Actions before retrying`);
    runs.push({ workflow, run: run.id, head: run.head_sha, status: run.status, conclusion: run.conclusion });
  }
  return { dispatched: workflows, expectedHead: head, runs,
    verification: 'Exact workflow_dispatch heads observed. Each run still must complete successfully; this receiver never treats dispatch as qualification or merges a PR.' };
}
