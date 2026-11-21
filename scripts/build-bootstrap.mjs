import {buildSync} from 'esbuild';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// One maintained parser/downloader; the distributed executable needs only Node builtins.
export function buildBootstrap({check = false} = {}) {
  const root = resolve(import.meta.dirname, '..');
  return buildSync({absWorkingDir: root, entryPoints: ['scripts/bootstrap/main.mjs'],
    outfile: 'scripts/tendriller-bootstrap.mjs', bundle: true, platform: 'node',
    target: 'node22.15', format: 'esm', write: !check});
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildBootstrap();
