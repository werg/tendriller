// The preview controller is always loaded from the repository's default branch.
// A workflow_run must never turn a fork's read-only CI run into a deployment
// with the staging environment's Cloudflare credential.
const { createHash } = require('node:crypto');

function branchKey(branch) {
  return createHash('sha256').update(branch).digest('hex').slice(0, 12);
}

function validateBranch(branch, defaultBranch) {
  if (typeof branch !== 'string' || !branch || branch.length > 255 || branch === '@' || branch === defaultBranch ||
      /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') ||
      branch.includes('@{') || branch.startsWith('-') || branch.startsWith('refs/') ||
      branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Choose a valid non-default repository branch.');
  }
  return branch;
}

async function head(github, context, branch) {
  try {
    const { data } = await github.rest.git.getRef({ ...context.repo, ref: `heads/${branch}` });
    if (data.ref !== `refs/heads/${branch}` || data.object.type !== 'commit') {
      throw new Error('GitHub did not return the exact requested branch.');
    }
    return data.object.sha;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function trustedRun(run, context) {
  return run.conclusion === 'success' && run.status === 'completed' &&
    run.path === '.github/workflows/service.yml' &&
    // PR checks run the synthetic merge ref, not head_sha. Only these events
    // prove that the source commit we are about to deploy passed the gate.
    ['push', 'workflow_dispatch'].includes(run.event) &&
    run.head_repository?.full_name === `${context.repo.owner}/${context.repo.repo}` &&
    /^[a-f0-9]{40}$/.test(run.head_sha ?? '');
}

async function select({ github, context, core, env = process.env }) {
  const payload = context.payload;
  const defaultBranch = payload.repository.default_branch;
  let action, branch, sha;
  if (context.eventName === 'delete') {
    if (payload.ref_type !== 'branch' || payload.ref === defaultBranch) return;
    action = 'delete';
    branch = payload.ref;
  } else if (context.eventName === 'workflow_run') {
    const run = payload.workflow_run;
    if (env.BRANCH_PREVIEWS_ENABLED === 'false' || !trustedRun(run, context) || run.head_branch === defaultBranch) return;
    // A passing build is not deployment intent. Only the preview namespace
    // opts into automatic deployment; other branches require a manual request.
    if (typeof run.head_branch !== 'string' || !run.head_branch.startsWith('preview/')) return;
    action = 'deploy';
    branch = run.head_branch;
    sha = run.head_sha;
  } else if (context.eventName === 'workflow_dispatch') {
    if (context.ref !== `refs/heads/${defaultBranch}`) {
      throw new Error('Run Live branch previews from the default branch.');
    }
    action = payload.inputs.action;
    branch = payload.inputs.branch;
    if (!['deploy', 'delete'].includes(action)) throw new Error('Choose deploy or delete.');
    if (action === 'deploy' && env.BRANCH_PREVIEWS_ENABLED === 'false') {
      throw new Error('Branch previews are disabled by BRANCH_PREVIEWS_ENABLED=false.');
    }
  } else {
    throw new Error(`Unsupported preview event: ${context.eventName}`);
  }
  validateBranch(branch, defaultBranch);
  const latest = await head(github, context, branch);
  if (action === 'delete') {
    if (latest) {
      core.notice('The branch exists; its preview will not be deleted.');
      return;
    }
  } else {
    if (!latest || (sha && sha !== latest)) {
      core.notice('Skipping a deleted branch or a superseded commit.');
      return;
    }
    sha = latest;
    if (context.eventName === 'workflow_dispatch') {
      const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
        ...context.repo, workflow_id: 'service.yml', head_sha: sha, status: 'success', per_page: 100,
      });
      if (!runs.some(run => trustedRun(run, context) && run.head_sha === sha && run.head_branch === branch)) {
        throw new Error('The current branch commit needs a successful Public service CI run before deployment.');
      }
    }
  }
  const key = branchKey(branch);
  for (const [name, value] of Object.entries({ action, branch, sha: sha ?? '', key, environment: `preview/${key}` })) {
    core.setOutput(name, value);
  }
}

async function current({ github, context, core, action, env = process.env }) {
  validateBranch(env.PREVIEW_BRANCH, context.payload.repository.default_branch);
  const latest = await head(github, context, env.PREVIEW_BRANCH);
  const matches = action === 'delete' ? latest === null : Boolean(latest && latest === env.PREVIEW_SHA);
  core.setOutput('current', String(matches));
  if (!matches) core.notice(action === 'delete'
    ? 'The branch was recreated; keeping its preview.'
    : 'The branch changed or was deleted; skipping this deployment.');
  return matches;
}

function runUrl(context) {
  return `${context.serverUrl || 'https://github.com'}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function startDeployment({ github, context, core, env = process.env }) {
  const { data } = await github.rest.repos.createDeployment({
    ...context.repo, ref: env.PREVIEW_SHA, task: 'deploy:preview',
    auto_merge: false, required_contexts: [], environment: env.PREVIEW_ENVIRONMENT,
    description: `Branch preview: ${env.PREVIEW_BRANCH}`.slice(0, 140),
    production_environment: false, transient_environment: true,
    payload: { branch: env.PREVIEW_BRANCH, controller: 'live-branch-previews' },
  });
  if (!Number.isSafeInteger(data.id)) throw new Error('GitHub did not create a deployment record.');
  core.setOutput('id', String(data.id));
  await github.rest.repos.createDeploymentStatus({
    ...context.repo, deployment_id: data.id, state: 'in_progress', log_url: runUrl(context),
    description: 'Provisioning and verifying the isolated branch preview', auto_inactive: false,
  });
}

async function finishDeployment({ github, context, core, env = process.env }) {
  let state = env.PREVIEW_OUTCOME === 'success' ? 'success' : 'failure';
  const url = env.PREVIEW_URL || '';
  if (state === 'success' && !/^https:\/\/[a-z0-9.-]+\/?$/.test(url)) {
    state = 'failure';
    core.setFailed('Deployment did not return a valid preview URL.');
  }
  await github.rest.repos.createDeploymentStatus({
    ...context.repo, deployment_id: Number(env.PREVIEW_DEPLOYMENT_ID), state,
    log_url: runUrl(context), ...(state === 'success' ? { environment_url: url } : {}),
    description: state === 'success' ? 'Live branch preview verified' : 'Branch preview deployment failed',
    auto_inactive: state === 'success',
  });
  const title = state === 'success' ? 'Live branch preview' : 'Branch preview failed';
  core.summary.addHeading(title).addRaw(`<p>Branch: <code>${escapeHtml(env.PREVIEW_BRANCH)}</code><br>Commit: <code>${escapeHtml(env.PREVIEW_SHA)}</code></p>`);
  if (state === 'success') core.summary.addLink('Open branch preview', url);
  else core.summary.addRaw('<p>See the deployment step for details. The previous successful preview may still be available.</p>');
  await core.summary.write();
}

async function finishCleanup({ github, context, core, env = process.env }) {
  const deployments = await github.paginate(github.rest.repos.listDeployments, {
    ...context.repo, environment: env.PREVIEW_ENVIRONMENT, task: 'deploy:preview', per_page: 100,
  });
  for (const deployment of deployments) {
    if (deployment.payload?.controller !== 'live-branch-previews' || deployment.payload?.branch !== env.PREVIEW_BRANCH) continue;
    await github.rest.repos.createDeploymentStatus({
      ...context.repo, deployment_id: deployment.id, state: 'inactive',
      log_url: runUrl(context), description: 'Branch deleted; preview resources removed', auto_inactive: false,
    });
  }
  await core.summary.addHeading('Branch preview removed')
    .addRaw(`<p>Removed the preview resources for <code>${escapeHtml(env.PREVIEW_BRANCH)}</code>.</p>`).write();
}

// The free-tier account has a small D1 database quota. Keep at most one
// deployed branch preview: remove resources owned by older deployment records
// before provisioning another branch. Exact-branch deletion remains scoped by
// scripts/branch-preview.mjs, and a failed deletion aborts the new deployment.
async function rotatePreviews({ github, context, core, branch, remove }) {
  validateBranch(branch, context.payload.repository.default_branch);
  const deployments = await github.paginate(github.rest.repos.listDeployments, {
    ...context.repo, task: 'deploy:preview', per_page: 100,
  });
  const previous = new Map();
  for (const deployment of deployments) {
    const owner = deployment.payload?.controller === 'live-branch-previews' && deployment.payload.branch;
    if (!owner || owner === branch) continue;
    validateBranch(owner, context.payload.repository.default_branch);
    if (deployment.environment !== `preview/${branchKey(owner)}`) {
      throw new Error('Preview deployment has an unexpected environment; refusing rotation.');
    }
    if (!previous.has(owner)) previous.set(owner, []);
    previous.get(owner).push(deployment.id);
  }
  for (const [owner, ids] of previous) {
    await remove(owner);
    for (const deployment_id of ids) {
      await retryTransient(() => github.rest.repos.createDeploymentStatus({
        ...context.repo, deployment_id, state: 'inactive', log_url: runUrl(context),
        description: 'Replaced by another live preview', auto_inactive: false,
      }));
    }
    core.notice(`Rotated preview resources for ${owner}.`);
  }
}

async function retryTransient(operation, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 3 || ![429, 500, 502, 503, 504].includes(error.status)) throw error;
      await delay(1000 * 2 ** attempt);
    }
  }
}

module.exports = { branchKey, validateBranch, head, trustedRun, select, current, startDeployment, finishDeployment, finishCleanup, rotatePreviews, retryTransient };
