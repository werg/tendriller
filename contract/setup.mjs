import { ApiError, requireServiceOrigin } from './client.mjs';

const operation = /^[A-Za-z0-9_.:-]{1,160}$/;
const hex = /^[a-f0-9]{64}$/;
const credential = /^tk_[a-z2-7]{32}$/;
const fail = (code, message, status = 400) => { throw new ApiError(status, { code, message }); };
const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
async function digest(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), n => n.toString(16).padStart(2, '0')).join(''); }
function serviceOrigin(value) {
  if (typeof value !== 'string') fail('invalid_service_origin', 'Supply the selected service origin as a string.');
  return requireServiceOrigin(value);
}

/** One canonical public request; no caller-supplied owner or OAuth identity. */
export function setupRequest(value) {
  const { operationId, name = 'Tendril', mode = 'interactive', applicationId, credentialCommitment } = value ?? {};
  if (typeof operationId !== 'string' || !operation.test(operationId) || typeof name !== 'string' || !name.trim() || name.length > 120 ||
      !['interactive', 'dashboard'].includes(mode) || typeof applicationId !== 'string' || !hex.test(applicationId) ||
      typeof credentialCommitment !== 'string' || !hex.test(credentialCommitment))
    fail('invalid_setup_request', 'A bounded operation ID, name, mode, stable application ID and SHA-256 credential commitment are required.');
  return { operationId, name, mode, applicationId, credentialCommitment };
}
export async function setupRequestDigest(service, value) {
  return digest(JSON.stringify(['tendriller/account-setup/v1', serviceOrigin(service), setupRequest(value)]));
}
async function validateIntent(intent) {
  if (intent?.schemaVersion !== 1 || typeof intent.serviceOrigin !== 'string' || typeof intent.credential !== 'string' || !credential.test(intent.credential) ||
      intent.credentialCommitment !== await digest(intent.credential) ||
      intent.requestDigest !== await setupRequestDigest(intent.serviceOrigin, intent))
    fail('setup_state_invalid', 'Retained setup state failed verification. Preserve it and inspect the original operation; do not replace its credential.');
  return intent;
}

/** The store must atomically create an absent operation and never overwrite one. */
export async function createSetupIntent(service, input, { store } = {}) {
  input = structuredClone(input);
  const origin = serviceOrigin(service);
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function')
    fail('setup_storage_required', 'Provide durable private load/save storage before preparing a page.');
  if (typeof input?.operationId !== 'string' || !operation.test(input.operationId)) fail('invalid_setup_request', 'Retain a bounded operationId before setup.');
  let saved = await store.load(input.operationId);
  if (saved === null || saved === undefined) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    const token = 'tk_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), n => alphabet[n & 31]).join('');
    const request = setupRequest({ ...input, applicationId: input.applicationId ?? randomHex(), credentialCommitment: await digest(token) });
    const intent = { schemaVersion: 1, serviceOrigin: origin, ...request, credential: token, requestDigest: await setupRequestDigest(origin, request) };
    await store.save(input.operationId, structuredClone(intent));
    saved = await store.load(input.operationId);
    if (!saved) fail('setup_storage_required', 'The setup credential was not durably readable after saving; no network request was made.');
  }
  await validateIntent(saved);
  if (saved.serviceOrigin !== origin || saved.operationId !== input.operationId ||
      ['name', 'mode', 'applicationId'].some(key => input[key] !== undefined && input[key] !== saved[key]))
    fail('setup_operation_conflict', 'This retained operation belongs to different setup input or another service. Keep the original operation.');
  return structuredClone(saved);
}

/** Combine only the exact successful public receipt with the retained private credential. */
export async function completeSetupIntent(intent, result) {
  intent = structuredClone(intent); result = structuredClone(result);
  await validateIntent(intent);
  if (result?.schemaVersion !== 1 || result.serviceOrigin !== intent.serviceOrigin || result.operationId !== intent.operationId ||
      result.requestDigest !== intent.requestDigest || result.credentialCommitment !== intent.credentialCommitment ||
      result.applicationId !== intent.applicationId)
    fail('setup_receipt_mismatch', 'The setup receipt does not identify this exact retained operation.', 409);
  if (result.state !== 'ready') fail(result.code ?? 'setup_not_ready', result.nextAction ?? 'Inspect the original setup operation before continuing.', 409);
  const page = result.page;
  if (!page || typeof result.pageId !== 'string' || !/^[a-z2-7]{12}$/.test(result.pageId) || page.id !== result.pageId ||
      page.api !== intent.serviceOrigin + '/api/t/' + result.pageId || page.application?.id !== intent.applicationId ||
      typeof page.page_url !== 'string' || typeof page.token !== 'undefined')
    fail('setup_receipt_mismatch', 'The prepared page metadata does not match the selected service and application.', 409);
  let url;
  try { url = new URL(page.page_url); } catch { /* Rejected below. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !url.hostname.startsWith(result.pageId + '.') && !url.hostname.startsWith(result.pageId + '--p-') || !/^\/s\/[a-z2-7]{26}\/$/.test(url.pathname))
    fail('setup_receipt_mismatch', 'The owner page URL is invalid.', 409);
  return { ...structuredClone(page), token: intent.credential };
}

async function setupHttp(service, accessToken, path, body, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  const origin = serviceOrigin(service);
  if (typeof accessToken !== 'string' || !accessToken) fail('setup_authentication_required', 'Use the linked account OAuth access token with tendrils:create.');
  const response = await fetcher(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', signal,
    headers: { Authorization: 'Bearer ' + accessToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let result;
  try { result = await response.json(); } catch { fail('invalid_response', 'Setup response is not JSON.', response.status); }
  if (!response.ok) throw new ApiError(response.status, result?.error);
  if (result?.serviceOrigin !== origin) fail('service_origin_mismatch', 'Setup identified another service.', 409);
  return result;
}
export async function prepareTendrilSetup(intent, options) {
  intent = structuredClone(intent);
  await validateIntent(intent);
  return setupHttp(intent.serviceOrigin, options?.accessToken, '/api/setup', setupRequest(intent), options);
}
export function inspectTendrilSetup(service, operationId, options) {
  if (typeof operationId !== 'string' || !operation.test(operationId)) fail('invalid_setup_request', 'The original operationId is required.');
  return setupHttp(service, options?.accessToken, '/api/setup?operationId=' + encodeURIComponent(operationId), undefined, options);
}
export function listTendrilSetups(service, options) { return setupHttp(service, options?.accessToken, '/api/setup', undefined, options); }
