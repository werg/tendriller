import { randomUUID } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Resolve consumer exports with ESM's import conditions, from the fixture itself. */
export async function importReviewPackages(project) {
  const path = resolve(project, '.review-imports-' + randomUUID() + '.mjs');
  writeFileSync(path, "export * as core from '@tendriller/core';\nexport * as session from '@chronolog/peer-session';\n", { flag: 'wx', mode: 0o600 });
  try { return await import(pathToFileURL(path).href); }
  finally { rmSync(path, { force: true }); }
}
