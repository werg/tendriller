export { watchApplicationSetup, validateSetupNotice, SETUP_WATCH_PROTOCOL } from './setup-watch.mjs';
import { ApiError, requireServiceOrigin } from './client.mjs';

// Host-only: the current server's account-setup route still canonicalizes its
// request with these two functions. They are deleted together with that route
// when the multi-page host lands; no client path creates setup intents.
const operation = /^[A-Za-z0-9_.:-]{1,160}$/, hex = /^[a-f0-9]{64}$/;
const fail = (code, message, status = 400) => { throw new ApiError(status, { code, message }); };
async function digest(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), n => n.toString(16).padStart(2, '0')).join(''); }
export function setupRequest(value) {
  const { operationId, name = 'Tendril', mode = 'interactive', applicationId, credentialCommitment } = value ?? {};
  if (typeof operationId !== 'string' || !operation.test(operationId) || typeof name !== 'string' || !name.trim() || name.length > 120 ||
      !['interactive', 'dashboard'].includes(mode) || typeof applicationId !== 'string' || !hex.test(applicationId) ||
      typeof credentialCommitment !== 'string' || !hex.test(credentialCommitment))
    fail('invalid_setup_request', 'A bounded operation ID, name, mode, stable application ID and SHA-256 credential commitment are required.');
  return { operationId, name, mode, applicationId, credentialCommitment };
}
export async function setupRequestDigest(service, value) {
  if (typeof service !== 'string') fail('invalid_service_origin', 'Supply the selected service origin as a string.');
  return digest(JSON.stringify(['tendriller/account-setup/v1', requireServiceOrigin(service), setupRequest(value)]));
}
