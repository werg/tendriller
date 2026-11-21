import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { publishedTuple, qualifyContrib, json, REPOS, validateTuple } from './tuple.mjs';
import { githubApi, capabilities, openProposal, dispatchQualification } from './github.mjs';
import { planProposal } from './proposal.mjs';

const { values } = parseArgs({ options: { help: { type: 'boolean' }, source: { type: 'string' },
  'contrib-source': { type: 'string' }, 'manifest-sha256': { type: 'string' },
  output: { type: 'string' }, apply: { type: 'boolean', default: false },
  'auth-kind': { type: 'string' }, 'check-auth': { type: 'boolean' }, receiver: { type: 'string' } } });
try {
  if (values.help) console.log(`Usage: node scripts/companion-release/cli.mjs --source FULL_CORE_SHA --output PRIVATE_OR_TEMP_DIR
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
    const output = resolve(values.output), root = resolve(import.meta.dirname, '../..');
    if (output === root || output.startsWith(root + '/')) throw Error('Generated evidence must be outside the source checkout');
    let source = values.source, contrib = values['contrib-source'];
    if (values.receiver) {
      assert(['contrib', 'chronolog'].includes(values.receiver));
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
    const plan = await planProposal(tuple, { api: githubApi });
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(resolve(output, 'tuple.json'), json(tuple));
    await writeFile(resolve(output, 'proposal.json'), json(plan));
    let result = !Object.keys(plan.files).length ? { state: 'unchanged', tupleId: tuple.id, noMutations: true } : values.apply ? await openProposal(plan, { authKind: values['auth-kind'] }) :
      { state: 'dry-run', tupleId: tuple.id, repository: plan.repository, files: Object.keys(plan.files), noMutations: true };
    if (values.apply && ['opened', 'existing'].includes(result.state)) result = { ...result,
      qualification: await dispatchQualification(plan, result.head) };
    await writeFile(resolve(output, 'result.json'), json(result)); console.log(json(result));
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
