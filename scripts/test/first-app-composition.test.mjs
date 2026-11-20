import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyFirstAppComposition } from '../first-app-composition.mjs';
import { runtimeManifest } from '../runtime-manifest.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identify = value => {
  const { id: _id, ...body } = value;
  value.id = digest(JSON.stringify(body));
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'first-app-composition-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '1.2.3', contract = 3;
  const runtime = runtimeManifest({ version, contract, assets: [], resources: [] });
  const archiveRoot = join(directory, 'runtime');
  await mkdir(join(archiveRoot, 'package/assets'), { recursive: true });
  await writeFile(join(archiveRoot, 'package/package.json'), JSON.stringify({ name: '@tendriller/runtime' }));
  await writeFile(join(archiveRoot, 'package/assets/manifest.json'), JSON.stringify(runtime));
  const archives = {}, components = [];
  for (const role of ['sdk', 'runtime', 'engine', 'tools']) {
    const file = `tendriller-${role}-${version}.tgz`, path = join(directory, file);
    if (role === 'runtime') execFileSync('tar', ['-czf', path, '-C', archiveRoot, 'package']);
    else await writeFile(path, `exact ${role} archive`);
    const bytes = await readFile(path);
    archives[role] = path;
    components.push({ role, file, sha256: digest(bytes), size: bytes.byteLength });
  }
  const source = { source: 'a'.repeat(40), sourceTree: 'b'.repeat(40), dirty: false };
  const composition = { format: 'tendriller-release-composition-v1', version, contract,
    runtime: runtime.id, core: source, components };
  identify(composition);
  const release = { format: 'tendriller-core-release', version, contract, runtime: runtime.id,
    source_commit: source.source, source_tree: source.sourceTree,
    composition: { id: composition.id }, artifacts: structuredClone(components) };
  const coreProof = { ...source, artifacts: structuredClone(components.filter(item => item.role !== 'tools')) };
  const toolsProof = { version, contract, runtime: runtime.id, source_commit: source.source,
    source_tree: source.sourceTree, dirty: false, artifacts: structuredClone(components.filter(item => item.role === 'tools')) };
  const input = { release, composition, coreProof, toolsProof, archives, version, contract };
  return { ...input, verify: () => verifyFirstAppComposition(input), reidentify() {
    identify(composition); release.composition.id = composition.id;
  } };
}

test('exact first-app preflight binds all core archives and packed runtime identity', async t => {
  const f = await fixture(t);
  await f.verify();
});

for (const role of ['engine', 'runtime', 'sdk', 'tools']) {
  test(`exact first-app preflight rejects rebuilt ${role} bytes with matching local provenance`, async t => {
    const f = await fixture(t), bytes = Buffer.from(`rebuilt ${role} from the same source checkpoint`);
    await writeFile(f.archives[role], bytes);
    // The current local build and its provenance agree with each other. They
    // still must not qualify the older kit's composition or its packed host.
    const proof = role === 'tools' ? f.toolsProof : f.coreProof;
    const record = proof.artifacts.find(item => item.role === role);
    record.sha256 = digest(bytes); record.size = bytes.byteLength;
    await assert.rejects(f.verify(), new RegExp(`actual ${role} archive does not match`));
  });
}

test('exact first-app preflight rejects missing or duplicate engine bindings', async t => {
  const f = await fixture(t), engine = f.composition.components.find(item => item.role === 'engine');
  f.composition.components = f.composition.components.filter(item => item.role !== 'engine');
  f.reidentify();
  await assert.rejects(f.verify(), /requires one engine component/);
  f.composition.components.push(engine, engine); f.reidentify();
  await assert.rejects(f.verify(), /requires one engine component/);
});

test('exact first-app preflight verifies declared runtime against the actual packed runtime', async t => {
  const f = await fixture(t);
  f.composition.runtime = f.release.runtime = f.toolsProof.runtime = 'c'.repeat(64);
  f.reidentify();
  await assert.rejects(f.verify(), /packed runtime does not match/);
});

test('exact first-app preflight refuses contract or source-tree drift', async t => {
  const f = await fixture(t);
  f.release.contract = 4;
  await assert.rejects(f.verify(), /Release contract does not match/);
  f.release.contract = f.contract;
  f.coreProof.sourceTree = 'd'.repeat(40);
  await assert.rejects(f.verify(), /source trees disagree/);
});
