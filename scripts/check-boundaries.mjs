import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
const application = /(?:^|[/\\])(?:tendriller-contrib|chronolog-db|components|cookbooks|recipes|examples)(?:[/\\]|$)|@tendriller\/(?:contrib|workflows)|@chronolog\//;
const tooling = /(?:^|[/\\])tools(?:[/\\]|$)|(?:node_modules[/\\])(?:ws|@modelcontextprotocol|playwright|@playwright)(?:[/\\]|$)/;
// The host admits portable control verification. Executable application logic stays with its participants.
const controlImports = new Map([
  ['server/src/peer-generations.ts', '@chronolog/peer-generation/control'],
  ['server/src/peer-control-identity.ts', '@chronolog/peer-generation/control'],
  ['server/src/peer-publications.ts', '@chronolog/peer-generation/control'],
  ['server/src/peer-participant.ts', '@chronolog/peer-generation/participant'],
]);
const controlArtifacts = new Set(['node_modules/@chronolog/peer-generation/control.mjs', 'node_modules/@chronolog/peer-generation/participant.mjs']);
for (const directory of ['server/src', 'runtime/src', 'contract']) for (const path of walk(join(root, directory))) {
  if (!/\.(ts|mjs|mts)$/.test(path)) continue;
  for (const match of readFileSync(path, 'utf8').matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)/g))
    assert.ok(((controlImports.get(relative(root, path)) === match[1]) || !application.test(match[1])) && !tooling.test(match[1]), `${relative(root, path)} imports application/tool implementation ${match[1]}`);
}
const engine = JSON.parse(readFileSync(join(root, 'dist/engine/inputs.json')));
for (const input of engine) assert.ok((controlArtifacts.has(input) || !application.test(input)) && !tooling.test(input), `Worker includes application/tool dependency ${input}`);
const workerSource = readFileSync(join(root, 'dist/engine/worker.mjs'), 'utf8');
for (const match of workerSource.matchAll(/(?:from\s*|import\s*\()\s*["'](node:[^"']+)/g))
  assert.ok(['node:crypto', 'node:net'].includes(match[1]), `Unexpected native Worker dependency ${match[1]}`);
for (const artifact of controlArtifacts) assert.ok(engine.includes(artifact), `The deployed engine must include its public control artifact: ${artifact}`);
const toolGraph = join(root, 'dist/tools-inputs.json');
if (existsSync(toolGraph)) for (const input of JSON.parse(readFileSync(toolGraph))) {
  const path = input.replaceAll('\\', '/');
  assert.ok(!/^(?:server\/src|runtime\/src|contract|preview-support)\//.test(path) && !application.test(path),
    `Tools must consume public artifacts, not private source: ${input}`);
}
const kernelPath = join(root, 'dist/runtime/inputs.json');
if (existsSync(kernelPath)) for (const input of JSON.parse(readFileSync(kernelPath))) {
  assert.ok(!application.test(input) && !tooling.test(input), `Browser kernel includes application/tool dependency ${input}`);
  assert.ok(!/(?:^|[/\\])(?:control|voice)(?:[/\\]|$)|(?:^|[/\\])(?:rules|speech[^/\\]*)\.[cm]?[jt]s$|phonon-tts/.test(input), `Browser kernel includes optional interaction code ${input}`);
}
for (const name of ['composition.lock.json', 'composition', 'server/src/archives.ts', 'server/src/assignments.ts', 'server/src/interactions.ts', 'server/src/recipe-gallery.ts'])
  assert.ok(!existsSync(join(root, name)), `Prescribed application surface remains: ${name}`);
for (const path of walk(join(root, 'dist/sdk')))
  assert.ok(!/\/server\/|\/runtime\/|\/tools\/|\/test\//.test(path), 'SDK contains private implementation');
console.log('Public API, headless runtime, Worker and optional tool boundaries passed.');
