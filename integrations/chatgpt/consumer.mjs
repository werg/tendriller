import { bounded, digest, fail, text } from './common.mjs';

/** Input is the trusted authenticator's result, never MCP arguments or metadata. */
export function consumerIdentity(principal) {
  const account = { id: text(principal?.id, 'principal ID', 512), issuer: text(principal?.issuer, 'issuer', 2048) };
  const bindingId = principal.agentBinding?.id ?? principal.agentBindingId;
  const clientId = principal.clientId;
  if (bindingId !== undefined) text(bindingId, 'approved agent binding', 128);
  if (clientId !== undefined) text(clientId, 'OAuth client', 512);
  const owner = { ...account, ...(bindingId === undefined ? clientId === undefined ? {} : { clientId } : { agentBindingId: bindingId }) };
  return { ...owner, consumerId: 'consumer_' + digest(owner),
    verification: bindingId !== undefined ? 'approved-binding' : clientId !== undefined ? 'oauth-client' : 'account' };
}
export function consumerOwner(principal) {
  const { consumerId, verification, ...owner } = consumerIdentity(principal); return owner;
}
export function accountIdentity(principal) {
  const { id, issuer } = consumerIdentity(principal); return { id, issuer };
}
export function assertConsumerAccess(principal, applicationId, kind = 'read', name) {
  const identity = consumerIdentity(principal);
  if (identity.verification !== 'approved-binding') return identity;
  const binding = principal.agentBinding;
  if (!binding || !Number.isSafeInteger(binding.revision) || binding.revision < 1 || !binding.applications ||
      typeof binding.applications !== 'object' || Array.isArray(binding.applications))
    fail('AGENT_BINDING_POLICY_REQUIRED', 'The authenticator must supply the current approved binding and its application capabilities', { status: 403 });
  const allowed = binding.applications[applicationId];
  if (!allowed || typeof allowed !== 'object' || Array.isArray(allowed)) fail('AGENT_BINDING_SCOPE_REQUIRED', 'This agent binding is not approved for the application', { status: 403 });
  const field = kind === 'query' ? 'queries' : kind === 'command' ? 'commands' : ['event', 'event-details'].includes(kind) ? 'events' : null;
  if (field && (!Array.isArray(allowed[field]) || !allowed[field].includes(name)) || kind === 'event-details' && allowed.readEvents !== true)
    fail('AGENT_BINDING_SCOPE_REQUIRED', 'This operation is outside the approved agent binding', { status: 403 });
  return identity;
}
export function retainedConsumer(principal) {
  const result = consumerOwner(principal);
  if (principal.agentBinding !== undefined) result.agentBinding = bounded(principal.agentBinding, 32768);
  if (principal.oauthGrantId !== undefined) result.oauthGrantId = text(principal.oauthGrantId, 'OAuth grant ID', 512);
  if (principal.scopes !== undefined) {
    if (!Array.isArray(principal.scopes) || principal.scopes.length > 128) fail('INVALID_PRINCIPAL', 'Invalid principal scopes');
    result.scopes = [...new Set(principal.scopes.map(scope => text(scope, 'scope', 128)))].sort();
  }
  return result;
}
export function sourceContext(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['runId', 'endpointId', 'documentPath', 'publicationId'].includes(key)))
    fail('INVALID_CONTEXT', 'Use bounded run, endpoint, document and publication context only');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, text(item, key, key === 'documentPath' ? 1024 : 128)]));
}
