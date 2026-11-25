// Runs the real executable lifecycle with a fixture attachment in place of tendril agent run:
//   node run-cli.mjs --fixture <module> <tendril arguments...>
// The fixture exports attach({ page, signal }) returning { session, control?, detach }.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runExecutable } from '../../lib/cli.mjs';
const argv = process.argv.slice(2);
let attach;
if (argv[0] === '--fixture') {
  const url = pathToFileURL(resolve(argv[1])).href;
  // Imported on first attach, so argument validation still precedes any session work.
  attach = async options => (await import(url)).attach(options);
  argv.splice(0, 2);
}
runExecutable(argv, attach ? { attach } : {});
