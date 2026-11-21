import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { publishedTuple, qualifyContrib, json, REPOS, validateTuple, commit } from './tuple.mjs';
import { githubApi, capabilities, submitProposal } from './github.mjs';
import { planProposal } from './proposal.mjs';
import { waitingReceipt } from './receipt.mjs';

const { values } = parseArgs({ options: { help: { type: 'boolean' }, source: { type: 'string' },
  'contrib-source': { type: 'string' }, 'manifest-sha256': { type: 'string' },
  output: { type: 'string' }, apply: { type: 'boolean', default: false },
  'auth-kind': { type: 'string' }, 'check-auth': { type: 'boolean' }, receiver: { type: 'string' },
  'automation-source': { type: 'string' } } });
let evidenceOutput, previouslyPublishedSource;
try {
  if (values.help) console.log(`Usage: node scripts/companion-release/cli.mjs --source FULL_CORE_SHA
  --automation-source OWNER_APPROVED_CORE_AUTOMATION_SHA --output PRIVATE_OR_TEMP_DIR
  [--manifest-sha256 PUBLISHER_DIGEST] [--contrib-source QUALIFIED_MERGED_SHA]
  [--apply --auth-kind app|user|repository]
  --receiver contrib|chronolog selects published source from core master / merged Contrib tuple.
  --check-auth performs a read-only capability probe, with no graph or write.
Default: download/verify the public graph and write tuple.json + proposal.json only.
With --contrib-source: require merged-main green CI for that exact recorded tuple,
then propose Chronolog CI refs. Otherwise propose Contrib qualification refs.
An apply run verifies everything again; it cannot apply a stored proposal file.`);
  else if (values['check-auth']) console.log(json(await capabilities()));
  else {
    if (!values.output) throw Error('An explicit output directory outside the repository is required');
    commit(values['automation-source']);
    const output = resolve(values.output), root = resolve(import.meta.dirname, '../..');
    if (output === root || output.startsWith(root + '/')) throw Error('Generated evidence must be outside the source checkout');
    evidenceOutput = output;
    let source = values.source, contrib = values['contrib-source'];
    if (values.receiver) {
      assert(['contrib', 'chronolog'].includes(values.receiver));
      assert.equal(process.env.GITHUB_REPOSITORY, values.receiver === 'contrib' ? REPOS.contrib : REPOS.kernel,
        'Receiver mode must match its own repository');
      const actual = execFileSync('git', ['-C', import.meta.dirname, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
      assert.equal(actual, values['automation-source'], 'Checked-out automation source differs from its approved pin');
      assert.equal(execFileSync('git', ['-C', import.meta.dirname, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 }).trim(), '',
        'Automation checkout must be clean');
      const previous = validateTuple(JSON.parse(await readFile(resolve(process.env.GITHUB_WORKSPACE || process.cwd(),
        'distribution/companion-release.json'), 'utf8')));
      previouslyPublishedSource = previous.core.source;
      assert(!source && !contrib, 'Receiver selects only trusted default branches, no input overrides');
      if (values.receiver === 'contrib') source = (await githubApi(`repos/${REPOS.core}/commits/master`)).sha;
      else {
        contrib = (await githubApi(`repos/${REPOS.contrib}/commits/main`)).sha;
        const file = await githubApi(`repos/${REPOS.contrib}/contents/distribution/companion-release.json?ref=${contrib}`);
        source = validateTuple(JSON.parse(Buffer.from(file.content, 'base64'))).core.source;
      }
    }
    let tuple = await publishedTuple(source, { api: githubApi, manifestSha256: values['manifest-sha256'] });
    if (contrib) tuple = await qualifyContrib(tuple, contrib, { api: githubApi });
    const plan = await planProposal(tuple, { api: githubApi, automationSource: values['automation-source'] });
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(resolve(output, 'tuple.json'), json(tuple));
    await writeFile(resolve(output, 'proposal.json'), json(plan));
    const result = !Object.keys(plan.files).length ? { state: 'unchanged', tupleId: tuple.id, noMutations: true } : values.apply ? await submitProposal(plan, { authKind: values['auth-kind'] }) :
      { state: 'dry-run', tupleId: tuple.id, repository: plan.repository, files: Object.keys(plan.files), noMutations: true };
    await writeFile(resolve(output, 'result.json'), json(result)); console.log(json(result));
  }
} catch (error) {
  const receipt = waitingReceipt(error, { receiver: Boolean(values.receiver), previouslyPublishedSource });
  if (receipt && evidenceOutput) {
    await mkdir(evidenceOutput, { recursive: true, mode: 0o700 });
    await writeFile(resolve(evidenceOutput, 'result.json'), json(receipt)); console.log(json(receipt));
  } else { console.error(error.message); process.exitCode = 1; }
}
