import { pathToFileURL } from 'node:url';
import { createAccountSetup, runAccountSetup } from './helpers/account-setup.mjs';
import { privateDirectory, readPrivate, readHostHandle } from './local.mjs';
const setup = createAccountSetup({ privateDirectory, readPrivate, readHostHandle });
export const prepareAccountSetup = setup.prepareAccountSetup;
export const finishAccountSetup = setup.finishAccountSetup;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runAccountSetup(setup), null, 2)); }
  catch (error) { console.error(JSON.stringify({ error: { code: error.code ?? error.name, message: error.message } })); process.exitCode = 1; }
}
