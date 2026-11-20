// Owner-reviewed host access for the same retained application. No signer,
// setup intent, page, OAuth credential or application grant is created here.
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { privateDirectory, readPrivate, hostIdentity, requireHostHandle, readHostHandle } from './local.mjs';

const failure = (code, message) => Object.assign(Error(message), { code });
const uncertain = () => failure('adoption_outcome_unknown', 'A submission was durably recorded without a retained response. Do not resend this one-time code. Ask the owner to inspect the named agent in the existing page’s management screen, disconnect it if present, and explicitly approve a new Add agent code. Preserve this attempt and all application state.');

async function saved(name, optional = false) {
  try { return await readPrivate(name, optional); }
  catch (error) {
    if (error instanceof SyntaxError) throw failure('host_state_invalid', 'A private adoption record is malformed. Preserve it and restore its verified checkpoint; no code was sent.');
    throw error;
  }
}

async function persist(name, value, replace = false) {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const temporary = new URL(`host-adoption-${randomUUID()}.tmp`, privateDirectory), target = new URL(name, privateDirectory);
  let created = true;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    if (replace) await rename(temporary, target);
    else try { await link(temporary, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; created = false; }
    if (process.platform !== 'win32') {
      const directory = await open(privateDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { created, value: await saved(name) };
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function responseText(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) { await reader.cancel(); throw uncertain(); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

const selectionChanged = () => failure('host_selection_changed', 'A later reviewed credential has been selected. This retained attempt cannot roll it back. Keep both histories and obtain a new explicit Add agent review if another renewal is needed.');
function requireSelectionPredecessor(current, attempt) {
  if (current?.attemptId === attempt.attemptId) return;
  if (!Object.hasOwn(attempt, 'previousAttemptId') || (current?.attemptId ?? null) !== attempt.previousAttemptId) throw selectionChanged();
}

async function selectCredential(attempt, handle, { fetcher, signal }) {
  const current = await saved('host-credential.json', true);
  requireSelectionPredecessor(current, attempt);
  try {
    // Redeeming once is not a permanent authorization. A response retained
    // before an interruption may since have been revoked by the owner.
    const response = await fetcher(handle.api + '/self', { method: 'GET', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...[signal].filter(Boolean)]),
      headers: { Authorization: 'Bearer ' + handle.token } });
    const self = JSON.parse(await responseText(response));
    if (!response.ok || self.applicationId !== attempt.applicationId || self.authority !== 'host-access-only' ||
      typeof self.binding?.id !== 'string' || self.name === 'setup') throw Error('inactive');
  } catch { throw failure('host_credential_unverified', 'The retained delegated credential could not be verified as active for this application. No code was resent and no credential was selected. Inspect the same named binding with its owner before retrying verification or approving another delegation.'); }
  if (current?.attemptId === attempt.attemptId) return;
  // A short filesystem critical section makes the predecessor check and
  // atomic selection indivisible across concurrently running CLI processes.
  const lockPath = new URL('host-selection.lock', privateDirectory);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw failure('host_selection_busy', 'Another credential selection holds .tendriller/host-selection.lock. Let it finish, then retry this saved response. After a crashed command, confirm every adoption command has stopped before removing only this lock; retain all attempt and response files.');
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ attemptId: attempt.attemptId, pid: process.pid })); await lock.sync();
    const latest = await saved('host-credential.json', true);
    requireSelectionPredecessor(latest, attempt);
    if (latest?.attemptId !== attempt.attemptId) await persist('host-credential.json', { ...attempt, handle }, true);
  } finally { try { await lock.close(); } finally { await unlink(lockPath); } }
}

/** The caller gives a private file path, never a code in shell arguments/logs. */
export async function adoptHostCredential(service, codeFile, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  const identity = await hostIdentity(service);
  const privatePath = fileURLToPath(privateDirectory), path = resolve(codeFile);
  if (!path.startsWith(privatePath.endsWith(sep) ? privatePath : privatePath + sep))
    throw failure('private_code_required', 'Save the owner’s Add agent code in a private file under this project’s .tendriller directory. Supply its path, never the code itself.');
  let code;
  try { code = (await readFile(path, 'utf8')).trim(); }
  catch { throw failure('private_code_required', 'The private delegation code file could not be read. Keep the code out of command arguments and logs.'); }
  if (!new RegExp(`^${identity.pageId}-[0-9]{6}$`).test(code))
    throw failure('adoption_page_mismatch', 'The private code does not identify this retained page. Obtain Add agent approval for the existing application.');
  const digest = createHash('sha256').update(JSON.stringify([identity.serviceOrigin, identity.applicationId, code])).digest('hex');
  const name = `host-adoption-${digest}`, attemptName = name + '.json', responseName = name + '-response.json';
  await readHostHandle(true);
  const previous = await saved('host-credential.json', true);
  if (!await saved(attemptName, true)) {
    // Earlier hosts ignored unknown POST fields. Check explicit support without
    // a code before trusting application/mode preconditions on this endpoint.
    try {
      const response = await fetcher(identity.serviceOrigin + '/api/adopt', { method: 'GET', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...[signal].filter(Boolean)]) });
      const support = JSON.parse(await responseText(response));
      if (!response.ok || support.schemaVersion !== 1 || support.serviceOrigin !== identity.serviceOrigin ||
        support.delegation?.applicationBound !== true || support.delegation?.nonReplacing !== true ||
        support.delegation?.responseRecovery !== false) throw Error('unsupported');
    } catch { throw failure('delegation_unavailable', 'This selected host did not confirm application-bound non-replacing delegation. Ask the operator to deploy the matching host. No code was submitted; keep the original service and application.'); }
  }
  const proposed = { schemaVersion: 1, attemptId: randomUUID(), serviceOrigin: identity.serviceOrigin,
    applicationId: identity.applicationId, pageId: identity.pageId, submittedAt: Date.now(), previousAttemptId: previous?.attemptId ?? null };
  const { created, value: attempt } = await persist(attemptName, proposed);
  if (attempt.schemaVersion !== 1 || attempt.serviceOrigin !== identity.serviceOrigin || attempt.applicationId !== identity.applicationId ||
    attempt.pageId !== identity.pageId || typeof attempt.attemptId !== 'string') throw failure('host_state_invalid', 'The retained adoption attempt has conflicting identity. Preserve it for inspection.');
  let result = await saved(responseName, true);
  if (!result) {
    if (!created) throw uncertain();
    signal?.throwIfAborted();
    try {
      const response = await fetcher(identity.serviceOrigin + '/api/adopt', { method: 'POST', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.any([AbortSignal.timeout(30_000), ...[signal].filter(Boolean)]),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, expectedMode: 'delegate', applicationId: identity.applicationId }) });
      // Persist the complete response before parsing or selecting its credential.
      // A process restart can finish locally without redeeming the code twice.
      result = (await persist(responseName, { status: response.status, body: await responseText(response) })).value;
    } catch { throw uncertain(); }
  }
  let handle;
  try { handle = JSON.parse(result.body); }
  catch { throw failure('adoption_response_invalid', 'The retained adoption response is not valid JSON. Keep it private and ask the owner to inspect the named agent; no code was resent.'); }
  if (result.status !== 200) {
    const code = typeof handle?.error?.code === 'string' && /^[a-z_]{1,80}$/.test(handle.error.code) ? handle.error.code : 'adoption_rejected';
    throw failure(code, 'The host rejected this retained adoption attempt. Inspect the existing page’s owner management screen, use Add agent with the required scopes, and explicitly approve another code if needed. Existing app identity and keys remain unchanged.');
  }
  requireHostHandle(handle, identity);
  await selectCredential(attempt, handle, { fetcher, signal });
  const selected = await readHostHandle();
  if (selected.token !== handle.token) throw failure('host_selection_changed', 'Another reviewed adoption selected a different host credential concurrently. Inspect the retained private records before starting the participant.');
  return { state: 'host_credential_saved', serviceOrigin: identity.serviceOrigin, pageId: identity.pageId,
    applicationId: identity.applicationId, page_url: handle.page_url, attemptId: attempt.attemptId, resumed: !created, connected: false,
    nextAction: 'Restart npm run peer for the retained native profile, verify its existing authority and query, then reconnect the same browser device. Keep the original setup intent, signer and signed operation records. If assistant access was bound to the expired credential, create and review a fresh proposal for this same app.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [service, codeFile, ...extra] = process.argv.slice(2);
    if (!service || !codeFile || extra.length) throw failure('invalid_arguments', 'Use npm run host:adopt -- SERVICE_ORIGIN .tendriller/delegation-code.txt.');
    console.log(JSON.stringify(await adoptHostCredential(service, codeFile), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.code ?? 'host_adoption_failed', message: error.message } }));
    process.exitCode = 1;
  }
}
