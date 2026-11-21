// Copied into dependent PRs. Node builtins only; never downloads or executes a tuple.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function select(tuple, mode, env = {}) {
  const { id, ...body } = tuple;
  assert.equal(tuple.format, 'tendriller-companion-release/v1');
  assert.equal(id, createHash('sha256').update(JSON.stringify(body)).digest('hex'), 'Tuple digest mismatch');
  const sha = value => { assert.match(value ?? '', /^[a-f0-9]{40}$/); return value; };
  assert.equal(tuple.core.repository, 'werg/tendriller');
  assert.equal(tuple.kernel.repository, 'werg/chronolog-db');
  assert.equal(tuple.core.dirty, false); assert.equal(tuple.kernel.dirty, false);
  const host = sha(env.TENDRILLER_REF || tuple.core.source);
  if (mode === 'contrib') return { HOST_REF: host, CORE_REF: host, CHRONOLOG_REF: sha(env.CHRONOLOG_REF_INPUT || tuple.kernel.source) };
  assert.equal(mode, 'chronolog'); assert.equal(tuple.stage, 'qualified');
  assert.equal(tuple.contrib.repository, 'werg/tendriller-contrib');
  return { HOST_REF: host, CONTRIB_REF: sha(env.CONTRIB_REF_INPUT || tuple.contrib.source) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  const tuple = JSON.parse(readFileSync(new URL('./companion-release.json', import.meta.url)));
  for (const [key, value] of Object.entries(select(tuple, mode, process.env))) console.log(`${key}=${value}`);
}
