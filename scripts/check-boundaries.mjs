import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
const application = /(?:^|[/\\])(?:tendriller-contrib|chronolog-db|components|cookbooks|recipes|examples)(?:[/\\]|$)|@tendriller\/(?:contrib|workflows)|@chronolog\//;
const tooling = /(?:^|[/\\])tools(?:[/\\]|$)|(?:node_modules[/\\])(?:ws|@modelcontextprotocol|playwright|@playwright)(?:[/\\]|$)/;
// Membership is a host responsibility. Its default portable implementation is
// one self-contained public artifact, never a sibling checkout or SQL runtime.
const membershipArtifact = 'node_modules/@chronolog/membership/index.mjs';
for (const directory of ['server/src', 'runtime/src', 'contract']) for (const path of walk(join(root, directory))) {
  if (!/\.(ts|mjs|mts)$/.test(path)) continue;
  for (const match of readFileSync(path, 'utf8').matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)/g))
    assert.ok((relative(root, path) === 'server/src/membership.ts' && match[1] === '@chronolog/membership' || !application.test(match[1])) && !tooling.test(match[1]), `${relative(root, path)} imports application/tool implementation ${match[1]}`);
}
const engine = JSON.parse(readFileSync(join(root, 'dist/engine/inputs.json')));
for (const input of engine) assert.ok((input === membershipArtifact || !application.test(input)) && !tooling.test(input), `Worker includes application/tool dependency ${input}`);
assert.ok(engine.includes(membershipArtifact), 'The deployed engine must include the default public membership artifact');
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
