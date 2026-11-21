import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { REPOS, checksum, commit } from './tuple.mjs';

// Use gh's credential provider. Tokens are never argv, URLs, reports or errors.
export function githubApi(path, body) {
  assert(/^repos\/werg\/(tendriller|tendriller-contrib|chronolog-db)(\/|$)/.test(path));
  assert(!path.includes('..') && !/[\r\n#]/.test(path));
  return new Promise((resolve, reject) => {
    const args = ['api', '--hostname', 'github.com', path, '--method', body ? 'POST' : 'GET'];
    if (body) args.push('--input', '-');
    const child = execFile('gh', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(Object.assign(Error('GitHub request failed; verify repository access, token permissions and API availability.'), { code: 'github_request_failed' }));
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

// Only a generated in-memory plan reaches this adapter; CLI never applies a plan
// file from disk. Reverification and planning happen again in the applying run.
export async function openProposal(plan, { api = githubApi, authKind, repository = process.env.GITHUB_REPOSITORY } = {}) {
  assert(['app', 'user', 'repository'].includes(authKind), 'Explicit authentication kind required');
  if (authKind === 'repository') {
    assert.equal(repository, plan.repository, 'Repository token may only propose its own repository');
    assert(Object.keys(plan.files).every(path => path === 'distribution/companion-release.json'),
      'Bootstrap workflow/code changes require the existing authorized owner/App credential once; the receiver only updates tuple data');
  }
  assert([REPOS.contrib, REPOS.kernel].includes(plan.repository));
  commit(plan.base); commit(plan.baseTree); checksum(plan.tupleId);
  assert.equal(plan.branch, `release/tuple-${plan.tupleId.slice(0, 24)}`);
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
  assert(paths.length >= 1 && paths.length <= 16);
  for (const path of paths) assert(/^(distribution\/(companion-release\.json|select-companion-release\.mjs|release-automation\/(check-published-release\.mjs|companion-release\/(tuple|select|proposal|github|cli)\.mjs))|(?:test|tools)\/companion-workflow-pins\.test\.mjs|tools\/test-companion-workflow-pins\.mjs|\.github\/workflows\/(peer-generation|collaboration|webrtc|companion-release-receiver)\.yml)$/.test(path));
  const tree = await api(`${root}/git/trees`, { base_tree: plan.baseTree,
    tree: paths.map(path => ({ path, mode: '100644', type: 'blob', content: plan.files[path] })) });
  const created = await api(`${root}/git/commits`, { message: plan.title, tree: commit(tree.sha), parents: [plan.base] });
  await api(`${root}/git/refs`, { ref: `refs/heads/${plan.branch}`, sha: commit(created.sha) });
  const pr = await api(`${root}/pulls`, { title: plan.title, body: plan.body, base: plan.baseBranch, head: plan.branch });
  return { state: 'opened', repository: plan.repository, url: pr.html_url, head: created.sha,
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
