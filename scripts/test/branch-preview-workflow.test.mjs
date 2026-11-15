import test from 'node:test';
import assert from 'node:assert/strict';
import preview from '../../.github/scripts/branch-preview.cjs';

const sha = 'a'.repeat(40);
const newerSha = 'b'.repeat(40);
const branch = 'preview/live-previews';

function fixture({ eventName = 'workflow_run', latest = sha, run = {}, inputs = {}, ref = 'refs/heads/master', refError } = {}) {
  const calls = [];
  const outputs = {};
  const context = {
    eventName, ref, repo: { owner: 'werg', repo: 'tendriller' }, runId: 42, serverUrl: 'https://github.com',
    payload: {
      repository: { default_branch: 'master' }, ref: branch, ref_type: 'branch', inputs,
      workflow_run: {
        status: 'completed', conclusion: 'success', event: 'push', head_sha: sha, path: '.github/workflows/service.yml',
        head_branch: branch, head_repository: { full_name: 'werg/tendriller' }, ...run,
      },
    },
  };
  const summary = {
    addHeading(value) { calls.push(['heading', value]); return this; },
    addRaw(value) { calls.push(['summary', value]); return this; },
    addLink(...values) { calls.push(['link', ...values]); return this; },
    async write() { calls.push(['summaryWrite']); },
  };
  const core = {
    setOutput(name, value) { outputs[name] = value; },
    notice(value) { calls.push(['notice', value]); },
    setFailed(value) { calls.push(['failed', value]); },
    summary,
  };
  const github = {
    rest: {
      git: {
        async getRef(args) {
          calls.push(['getRef', args]);
          if (refError) throw refError;
          if (latest === null) throw Object.assign(new Error('Not found'), { status: 404 });
          return { data: { ref: `refs/${args.ref}`, object: { type: 'commit', sha: latest } } };
        },
      },
      actions: { listWorkflowRuns() {} },
      repos: {
        listDeployments() {},
        async createDeployment(args) { calls.push(['createDeployment', args]); return { data: { id: 123 } }; },
        async createDeploymentStatus(args) { calls.push(['status', args]); },
      },
    },
    async paginate(method, args) {
      calls.push(['paginate', args]);
      return method === github.rest.actions.listWorkflowRuns ? github.runs : github.deployments;
    },
    runs: [], deployments: [],
  };
  return { github, context, core, calls, outputs };
}

test('successful trusted CI selects exactly its current preview branch commit', async () => {
  const f = fixture();
  await preview.select({ ...f, env: {} });
  assert.equal(f.outputs.action, 'deploy');
  assert.equal(f.outputs.branch, branch);
  assert.equal(f.outputs.sha, sha);
  assert.match(f.outputs.environment, /^preview\/[a-f0-9]{12}$/);
  assert.deepEqual(f.calls.find(call => call[0] === 'getRef')[1], { owner: 'werg', repo: 'tendriller', ref: `heads/${branch}` });
});

test('passing release and development branches do not opt into automatic deployment', async () => {
  for (const head_branch of ['release/v0.2.0-rc.1', 'release/v3.0.0', 'feat/example', 'preview', 'previews/example', 'Preview/example']) {
    const f = fixture({ run: { head_branch } });
    await preview.select({ ...f, env: {} });
    assert.deepEqual(f.outputs, {});
    assert.deepEqual(f.calls, []);
  }
});

test('forks and unsuccessful or unsupported CI events never access a privileged branch', async () => {
  const runs = [
    { head_repository: { full_name: 'outsider/tendriller' }, event: 'pull_request' },
    { head_repository: null }, { conclusion: 'failure' }, { status: 'in_progress' }, { path: '.github/workflows/other.yml' },
    { event: 'pull_request' }, { event: 'pull_request_target' }, { event: 'schedule' }, { head_sha: 'invalid' }, { head_branch: 'master' },
  ];
  for (const run of runs) {
    const f = fixture({ run });
    await preview.select({ ...f, env: {} });
    assert.deepEqual(f.outputs, {});
    assert.deepEqual(f.calls, []);
  }
});

test('an old successful run cannot replace a newer preview or recreate a deleted branch', async () => {
  for (const latest of [newerSha, null]) {
    const f = fixture({ latest });
    await preview.select({ ...f, env: {} });
    assert.deepEqual(f.outputs, {});
    assert.equal(f.calls.some(call => call[0] === 'notice'), true);
  }
});

test('the disable switch stops new deployments but still allows deleted-branch cleanup', async () => {
  const deploy = fixture();
  await preview.select({ ...deploy, env: { BRANCH_PREVIEWS_ENABLED: 'false' } });
  assert.deepEqual(deploy.outputs, {});
  assert.deepEqual(deploy.calls, []);
  const cleanup = fixture({ eventName: 'delete', latest: null });
  await preview.select({ ...cleanup, env: { BRANCH_PREVIEWS_ENABLED: 'false' } });
  assert.equal(cleanup.outputs.action, 'delete');
  assert.equal(cleanup.outputs.branch, branch);
});

test('tag deletion and recreated branches do not delete preview resources', async () => {
  const tag = fixture({ eventName: 'delete', latest: null });
  tag.context.payload.ref_type = 'tag';
  await preview.select({ ...tag, env: {} });
  assert.deepEqual(tag.outputs, {});
  assert.deepEqual(tag.calls, []);
  const recreated = fixture({ eventName: 'delete' });
  await preview.select({ ...recreated, env: {} });
  assert.deepEqual(recreated.outputs, {});
});

test('manual deployment requires a passing trusted CI run for the exact branch head', async () => {
  const f = fixture({ eventName: 'workflow_dispatch', inputs: { branch, action: 'deploy' } });
  const good = f.context.payload.workflow_run;
  f.github.runs = [{ ...good, head_sha: newerSha }, { ...good, head_repository: { full_name: 'outsider/tendriller' } }];
  await assert.rejects(preview.select({ ...f, env: {} }), /successful Public service CI run/);
  assert.deepEqual(f.outputs, {});
  f.github.runs.push(good);
  await preview.select({ ...f, env: {} });
  assert.equal(f.outputs.sha, sha);
  const query = f.calls.find(call => call[0] === 'paginate')[1];
  assert.equal(query.workflow_id, 'service.yml');
  assert.equal(query.head_sha, sha);
});

test('manual deployment and deleted-branch cleanup remain available outside the preview namespace', async () => {
  for (const branch of ['release/v0.2.0-rc.1', 'feat/example']) {
    const deploy = fixture({ eventName: 'workflow_dispatch', inputs: { branch, action: 'deploy' }, run: { head_branch: branch } });
    deploy.github.runs = [deploy.context.payload.workflow_run];
    await preview.select({ ...deploy, env: {} });
    assert.equal(deploy.outputs.action, 'deploy');
    assert.equal(deploy.outputs.branch, branch);
    assert.equal(deploy.outputs.sha, sha);

    const cleanup = fixture({ eventName: 'delete', latest: null });
    cleanup.context.payload.ref = branch;
    await preview.select({ ...cleanup, env: {} });
    assert.equal(cleanup.outputs.action, 'delete');
    assert.equal(cleanup.outputs.branch, branch);
  }
});

test('manual controller cannot run from an arbitrary branch or deploy the default branch', async () => {
  const f = fixture({ eventName: 'workflow_dispatch', ref: `refs/heads/${branch}`, inputs: { branch, action: 'deploy' } });
  await assert.rejects(preview.select({ ...f, env: {} }), /from the default branch/);
  assert.deepEqual(f.calls, []);
  f.context.ref = 'refs/heads/master';
  f.context.payload.inputs.branch = 'master';
  await assert.rejects(preview.select({ ...f, env: {} }), /non-default/);
  assert.deepEqual(f.calls, []);
});

test('API permission and network failures are never treated as a deleted branch', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture({ eventName: 'delete', refError: Object.assign(new Error('API unavailable'), { status }) });
    await assert.rejects(preview.select({ ...f, env: {} }), /API unavailable/);
    assert.deepEqual(f.outputs, {});
  }
});

test('the last-minute branch check protects both update and deletion races', async () => {
  const updated = fixture({ latest: newerSha });
  assert.equal(await preview.current({ ...updated, action: 'deploy', env: { PREVIEW_BRANCH: branch, PREVIEW_SHA: sha } }), false);
  assert.equal(updated.outputs.current, 'false');
  const recreated = fixture();
  assert.equal(await preview.current({ ...recreated, action: 'delete', env: { PREVIEW_BRANCH: branch } }), false);
  assert.equal(recreated.outputs.current, 'false');
  const deleted = fixture({ latest: null });
  assert.equal(await preview.current({ ...deleted, action: 'delete', env: { PREVIEW_BRANCH: branch } }), true);
});

test('GitHub ref prefix matches cannot masquerade as the requested branch', async () => {
  const f = fixture();
  f.github.rest.git.getRef = async () => ({ data: { ref: `refs/heads/${branch}-other`, object: { type: 'commit', sha } } });
  await assert.rejects(preview.select({ ...f, env: {} }), /exact requested branch/);
});

test('branch identity preserves slash, punctuation and case without collisions', async () => {
  assert.notEqual(preview.branchKey('feat/a'), preview.branchKey('feat-a'));
  assert.notEqual(preview.branchKey('Feature'), preview.branchKey('feature'));
  const literal = 'preview/$(id);example';
  const f = fixture({ run: { head_branch: literal } });
  await preview.select({ ...f, env: {} });
  assert.equal(f.outputs.branch, literal);
  assert.equal(f.calls.find(call => call[0] === 'getRef')[1].ref, `heads/${literal}`);
  for (const invalid of ['master', '', '@', 'a'.repeat(256), 'refs/heads/feature', '../production', 'feature\nproduction', 'feature a', '-production', 'feature//a', 'feature./a', 'feature.lock']) {
    assert.throws(() => preview.validateBranch(invalid, 'master'), /valid non-default/);
  }
});

test('deployment records are transient, non-production, and pinned to the tested SHA', async () => {
  const f = fixture();
  const env = { PREVIEW_BRANCH: branch, PREVIEW_SHA: sha, PREVIEW_ENVIRONMENT: 'preview/abc123' };
  await preview.startDeployment({ ...f, env });
  const data = f.calls.find(call => call[0] === 'createDeployment')[1];
  assert.equal(data.ref, sha);
  assert.equal(data.auto_merge, false);
  assert.equal(data.transient_environment, true);
  assert.equal(data.production_environment, false);
  assert.equal(data.environment, env.PREVIEW_ENVIRONMENT);
  assert.equal(f.outputs.id, '123');
});

test('only a verified deployment with an HTTPS URL is reported successful', async () => {
  for (const [outcome, url, expected] of [
    ['success', 'https://preview-abcd.tendriller.dev', 'success'],
    ['failure', '', 'failure'],
    ['cancelled', '', 'failure'],
    ['success', '', 'failure'],
    ['success', 'http://preview-abcd.tendriller.dev', 'failure'],
  ]) {
    const f = fixture();
    await preview.finishDeployment({ ...f, env: {
      PREVIEW_DEPLOYMENT_ID: '123', PREVIEW_OUTCOME: outcome, PREVIEW_URL: url, PREVIEW_BRANCH: branch, PREVIEW_SHA: sha,
    } });
    const status = f.calls.find(call => call[0] === 'status')[1];
    assert.equal(status.state, expected);
    assert.equal(status.auto_inactive, expected === 'success');
    assert.equal(status.environment_url, expected === 'success' ? url : undefined);
  }
});

test('cleanup marks only this controller and branch deployments inactive', async () => {
  const f = fixture();
  f.github.deployments = [
    { id: 1, payload: { controller: 'live-branch-previews', branch } },
    { id: 2, payload: { controller: 'live-branch-previews', branch: 'other-branch' } },
    { id: 3, payload: { controller: 'other-controller', branch } },
    { id: 4 },
  ];
  await preview.finishCleanup({ ...f, env: { PREVIEW_BRANCH: branch, PREVIEW_ENVIRONMENT: 'preview/abc123' } });
  assert.deepEqual(f.calls.filter(call => call[0] === 'status').map(call => call[1].deployment_id), [1]);
  assert.equal(f.calls.find(call => call[0] === 'status')[1].state, 'inactive');
  assert.equal(f.calls.find(call => call[0] === 'paginate')[1].environment, 'preview/abc123');
});
