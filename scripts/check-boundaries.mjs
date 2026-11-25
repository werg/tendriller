import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
const application = /(?:^|[/\\])(?:tendriller-contrib|chronolog-db|components|cookbooks|recipes|examples)(?:[/\\]|$)|@tendriller\/(?:contrib|workflows)|@chronolog\//;
const tooling = /(?:^|[/\\])tools(?:[/\\]|$)|(?:node_modules[/\\])(?:ws|@modelcontextprotocol|playwright|@playwright)(?:[/\\]|$)/;
// The host admits portable control and declared input-schema verification.
// Opt-in hosted MCP participants (`server/src/mcp-*.ts`) use portable `@chronolog/peer-session`
// + in-memory DoltLite WASM + QuickJS WASM without storing plaintext keys at rest.
const authorityImports = new Set([
  'server/src/authority.ts', 'server/src/admissions.ts', 'server/src/host-attestation.ts',
  'server/src/peer-publications.ts', 'server/src/peer-participant.ts',
]);
const hostedMcpImports = new Set([
  'server/src/mcp-participant.ts', 'server/src/mcp-sql.ts',
]);
const portableAuthority = new Set(['@chronolog/authority', ...['control', 'metadata', 'participant', 'publication', 'finality'].map(name => '@chronolog/authority/' + name)]);
const portablePeerSession = new Set(['@chronolog/peer-session']);
const controlArtifacts = new Set(['index', 'control', 'metadata', 'participant', 'publication', 'finality'].map(name => 'node_modules/@chronolog/authority/' + name + '.mjs'));
const isPortablePeerSessionArtifact = input => /^node_modules\/@chronolog\/peer-session\/(?:index\.mjs|chunks\/[^/]+\.mjs)$/.test(input);
for (const directory of ['server/src', 'runtime/src', 'contract']) for (const path of walk(join(root, directory))) {
  if (!/\.(ts|mjs|mts)$/.test(path)) continue;
  const rel = relative(root, path);
  if (rel.startsWith('server/src/vendor/doltlite/')) continue;
  for (const match of readFileSync(path, 'utf8').matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)/g)) {
    const allowedChronolog =
      (authorityImports.has(rel) && portableAuthority.has(match[1])) ||
      (hostedMcpImports.has(rel) && portablePeerSession.has(match[1]));
    assert.ok((allowedChronolog || !application.test(match[1])) && !tooling.test(match[1]), `${rel} imports application/tool implementation ${match[1]}`);
  }
}
const engine = JSON.parse(readFileSync(join(root, 'dist/engine/inputs.json')));
for (const input of engine) assert.ok((controlArtifacts.has(input) || isPortablePeerSessionArtifact(input) || !application.test(input)) && !tooling.test(input), `Worker includes application/tool dependency ${input}`);
const workerSource = readFileSync(join(root, 'dist/engine/worker.mjs'), 'utf8');
for (const match of workerSource.matchAll(/(?:from\s*|import\s*\()\s*["'](node:[^"']+)/g))
  assert.fail(`Unexpected native Worker dependency ${match[1]}`);
assert.ok(engine.some(input => controlArtifacts.has(input)), 'The deployed engine must include the public portable authority artifact');
const toolGraph = join(root, 'dist/tools-inputs.json');
if (existsSync(toolGraph)) for (const input of JSON.parse(readFileSync(toolGraph))) {
  const path = input.replaceAll('\\', '/');
  const publicChronolog = /(?:^|\/)node_modules\/@chronolog\/(?:authority|peer-session)(?:\/|$)/.test(path);
  assert.ok(!/^(?:server\/src|runtime\/src|runtime\/types|contract)\//.test(path) && (!application.test(path) || publicChronolog),
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
