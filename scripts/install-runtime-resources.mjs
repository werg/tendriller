// Install declared, content-addressed resources in the existing FILES bucket.
// Usage: node scripts/install-runtime-resources.mjs <bucket> [--remote]
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RUNTIME_RESOURCES } from '../runtime/resources.mjs';

const bucket = process.argv[2];
if (!bucket || !/^[a-z0-9-]+$/.test(bucket)) throw Error('Pass an R2 bucket name');
const remote = process.argv.includes('--remote');
const directory = await mkdtemp(join(tmpdir(), 'tendriller-resources-'));
try {
  for (const resource of RUNTIME_RESOURCES) {
    const response = await fetch(resource.source);
    if (!response.ok) throw Error(`${resource.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== resource.sha256) throw Error(`${resource.name}: integrity mismatch`);
    const file = join(directory, resource.name);
    await writeFile(file, bytes);
    execFileSync(process.execPath, [new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url).pathname, 'r2', 'object', 'put',
      `${bucket}/assets/${resource.sha256}/${resource.name}`, '--file', file, '--content-type', resource.type,
      '--cache-control', 'public, max-age=31536000, immutable', remote ? '--remote' : '--local'], { stdio: 'inherit' });
  }
} finally { await rm(directory, { recursive: true, force: true }); }
