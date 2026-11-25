import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve consumer exports with ESM's import conditions, from the fixture itself. */
export async function importReviewPackages(project) {
  const path = resolve(project, '.review-imports-' + randomUUID() + '.mjs');
  writeFileSync(path, "export * as core from '@tendriller/core';\nexport * as session from '@chronolog/peer-session';\nexport * as coreAuthority from '@tendriller/core/authority';\n", { flag: 'wx', mode: 0o600 });
  try { return await import(pathToFileURL(path).href); }
  finally { rmSync(path, { force: true }); }
}

/**
 * The exact public archives of the one qualified composition: SDK, tools, authority and session. The fixture is an agent
 * workspace that imports the public @tendriller/tools/workspace helpers, and its copied helpers import @chronolog/authority
 * directly, so every one is installed from the same composition rather than resolved through a registry, a guessed path
 * or an optional fallback.
 */
export function reviewInstallArguments(composition) {
  const paths = composition?.packagePaths;
  for (const role of ['sdk', 'tools', 'authority', 'session']) assert(typeof paths?.[role] === 'string' && paths[role].endsWith('.tgz'), 'The qualified composition must name its ' + role + ' archive');
  return ['install', '--ignore-scripts', '--no-audit', '--no-fund', paths.sdk, paths.tools, paths.authority, paths.session];
}

/** After installation, the actual packages must come from the composition's clean Chronolog checkpoint. */
export function verifyInstalledReviewPackages(project, composition) {
  const read = name => JSON.parse(readFileSync(resolve(project, 'node_modules/@chronolog', name, 'provenance.json'), 'utf8'));
  const identities = {};
  for (const name of ['authority', 'peer-session']) {
    const proof = read(name);
    assert.equal(proof.repository, 'werg/chronolog-db', name + ' must come from the Chronolog repository');
    assert.equal(proof.dirty, false, name + ' must come from a clean checkpoint');
    assert.equal(proof.source, composition.session.sourceCommit, name + ' source differs from the qualified composition');
    assert.equal(proof.sourceTree, composition.session.sourceTree, name + ' source tree differs from the qualified composition');
    identities[name] = { source: proof.source, sourceTree: proof.sourceTree };
  }
  // The tools archive carries the runtime it was built against; it must be this composition's, not another release's.
  const tools = JSON.parse(readFileSync(resolve(project, 'node_modules/@tendriller/tools/package.json'), 'utf8'));
  assert.equal(tools.name, '@tendriller/tools', 'The installed tools package identity differs');
  assert.equal(tools.version, composition.build.coreRelease, 'The installed tools release differs from the qualified composition');
  assert.equal(tools.tendriller?.runtime, composition.build.runtimeId, 'The installed tools runtime differs from the qualified composition');
  identities.tools = { version: tools.version, runtime: tools.tendriller.runtime };
  return identities;
}
