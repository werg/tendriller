// Account-linked MCP creates the page. This local helper retains its setup
// credential before exposing public tool arguments, then restores the handle.
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { requireServiceOrigin } from '@tendriller/core';
import { createSetupIntent, setupRequest, completeSetupIntent } from '@tendriller/core/setup';
import { privateDirectory, readPrivate as readSavedPrivate, readHostHandle } from './local.mjs';

const intentName = 'account-setup.json';
const failure = (code, message) => Object.assign(Error(message), { code });

async function readPrivate(name, optional = false) {
  try { return await readSavedPrivate(name, optional); }
  catch (error) {
    // JSON.parse includes input fragments in its error message. Keep a damaged
    // credential record private too; never print those bytes to the console.
    if (error instanceof SyntaxError)
      throw failure('setup_state_invalid', 'A retained private setup record is malformed. Preserve it and restore its verified checkpoint; no replacement operation or credential was created.');
    throw error;
  }
}

// Link a fully flushed temporary file into place without replacing another
// invocation's winning record. A crash cannot leave half a JSON credential.
async function saveOnce(name, value) {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const target = new URL(name, privateDirectory);
  const temporary = new URL(`account-setup-${randomUUID()}.tmp`, privateDirectory);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    try { await link(temporary, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // File contents were flushed before linking. Sync the directory entry on
    // platforms that support opening directories; Windows flushes the file.
    if (process.platform !== 'win32') {
      const directory = await open(privateDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return await readPrivate(name);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

const store = {
  async load(operationId) {
    const intent = await readPrivate(intentName, true);
    if (intent && intent.operationId !== operationId)
      throw failure('setup_operation_conflict', 'This project already retains a different setup operation. Inspect or resume that original operation; use a separate directory for a deliberately new application.');
    return intent;
  },
  async save(operationId, intent) {
    if (operationId !== intent.operationId) throw failure('setup_operation_conflict', 'The setup record does not match its original operation.');
    await saveOnce(intentName, intent);
  },
};

function checkHandle(handle, origin, intent) {
  let api;
  try { api = new URL(handle.api); } catch {}
  if (!api || api.origin !== origin || api.username || api.password)
    throw failure('service_origin_mismatch', 'The saved handle belongs to another service. Resume it with its matching connector; do not replace it or copy private state across services.');
  if (intent && (handle.token !== intent.credential || handle.application?.id !== intent.applicationId))
    throw failure('setup_handle_conflict', 'The saved handle belongs to a different setup. Retain both original records and inspect the operation before continuing.');
}

function ready(handle, origin, operationId, resumed) {
  return { state: 'handle_saved', serviceOrigin: origin, ...(operationId ? { operationId } : {}),
    page_url: handle.page_url, applicationId: handle.application.id, resumed, connected: false,
    nextAction: 'Run npm run init, build and publish the first signed UI, then start its participant before giving the owner the ready page. Owner sign-in, assistant permission review and browser enrollment remain distinct steps.' };
}

/** Preparing is local only; it never receives an account OAuth credential. */
export async function prepareAccountSetup(service, options = {}) {
  const origin = requireServiceOrigin(service);
  const saved = await readPrivate(intentName, true), handle = await readPrivate('handle.json', true);
  if (handle) checkHandle(handle, origin, saved);
  const selected = await readHostHandle(true);
  if (selected && selected.token !== handle?.token) {
    checkHandle(selected, origin);
    return { ...ready(selected, origin, saved?.operationId, true), nextAction: 'This project uses the owner’s reviewed host delegation. Resume its retained native participant and signed operation records; do not repeat setup or initialize a new signer.' };
  }
  if (handle && !saved) {
    if (options.operationId || options.applicationId)
      throw failure('setup_handle_conflict', 'This project already has a handle without an account-setup intent. Resume its existing setup instead of replacing its identity.');
    return ready(handle, origin, undefined, true);
  }
  const operationId = options.operationId ?? saved?.operationId ?? `setup-${randomUUID()}`;
  const intent = await createSetupIntent(origin, { ...options, operationId,
    ...(!saved && options.name === undefined ? { name: 'Shared notes' } : {}) }, { store });
  if (handle) return ready(handle, origin, intent.operationId, true);
  return { state: 'intent_saved', serviceOrigin: origin, operationId: intent.operationId,
    readinessUrl: origin + '/api/readiness', connected: false,
    prepare: { tool: 'prepare_tendril_setup', arguments: setupRequest(intent) },
    inspect: { tool: 'inspect_tendril_setup', arguments: { operationId: intent.operationId } },
    nextAction: 'Check this service readiness, then call prepare_tendril_setup through the selected account-linked connector with these exact arguments. Save its public ready result and run npm run setup:finish -- RESULT.json. If the reply is lost, inspect this same operation; do not generate another intent.' };
}

/** Complete only the retained operation; never mint a replacement credential. */
export async function finishAccountSetup(result) {
  const intent = await readPrivate(intentName, true);
  if (!intent) throw failure('setup_storage_required', 'The original private setup intent is missing. Restore its verified checkpoint before completing setup; a public result cannot recover its secret or authorize a replacement page.');
  const handle = await completeSetupIntent(intent, result);
  const existing = await readPrivate('handle.json', true);
  if (existing) {
    checkHandle(existing, intent.serviceOrigin, intent);
    if (existing.id !== handle.id || existing.api !== handle.api || existing.page_url !== handle.page_url)
      throw failure('setup_handle_conflict', 'The saved page differs from the acknowledged setup result. Inspect the original operation; no private record was replaced.');
    return ready(existing, intent.serviceOrigin, intent.operationId, true);
  }
  const retained = await saveOnce('handle.json', handle);
  checkHandle(retained, intent.serviceOrigin, intent);
  if (retained.id !== handle.id || retained.api !== handle.api || retained.page_url !== handle.page_url)
    throw failure('setup_handle_conflict', 'Another invocation saved a different page handle. Inspect the retained setup; no record was replaced.');
  return ready(retained, intent.serviceOrigin, intent.operationId, false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      mode: { type: 'string' }, operation: { type: 'string' },
    } });
    const [action, argument, name, ...extra] = positionals;
    if (extra.length || !argument || !['prepare', 'finish'].includes(action) ||
      action === 'finish' && (name !== undefined || Object.keys(values).length))
      throw Error('Use npm run setup:prepare -- SERVICE_ORIGIN [NAME] [--mode interactive|dashboard], or npm run setup:finish -- PUBLIC_RESULT.json.');
    const result = action === 'prepare'
      ? await prepareAccountSetup(argument, { ...(name === undefined ? {} : { name }),
        ...(values.mode === undefined ? {} : { mode: values.mode }),
        ...(values.operation === undefined ? {} : { operationId: values.operation }) })
      : await finishAccountSetup(JSON.parse(await readFile(argument, 'utf8')));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.code ?? error.name, message: error.message } }));
    process.exitCode = 1;
  }
}
