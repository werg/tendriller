import { createParticipantTransport, validateParticipantRequest } from './participant.mjs';
export * from './participant.mjs';

/** A page's immutable application scope is resolved once at its bootstrap boundary. */
export function createPeerParticipantClient({ applicationId, request }) {
  let transport;
  const open = (scopeHint) => {
    if (!transport) transport = (async () => {
      const scope = typeof applicationId === 'function' ? await applicationId()
        : applicationId ?? scopeHint ?? (await request('application')).selection?.id;
      return createParticipantTransport({ applicationId: scope,
        exchange: (message, options) => request('peers/participant', { method: 'POST', body: message, signal: options.signal }),
      });
    })().catch(error => { transport = undefined; throw error; });
    return transport;
  };
  return Object.freeze({
    async exchange(message, options) {
      // Reject unwanted facets before a scope lookup or transport request.
      const input = validateParticipantRequest(message);
      return (await open(input.applicationId)).exchange(input, options);
    },
    async request(facet, action, payload, options) {
      return (await open()).request(facet, action, payload, options);
    },
  });
}
