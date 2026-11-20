import { createParticipantTransport, validateParticipantRequest, participantAccepts,
  CONTROL_PARTICIPANT_POLICY, ParticipantProtocolError } from './participant.mjs';
export * from './participant.mjs';

/** A page's immutable application scope is resolved once at its bootstrap boundary. */
export function createPeerParticipantClient({ applicationId, request }) {
  let transport, opening;
  const start = scopeHint => {
    const pending = { controller: new AbortController(), waiters: new Set() };
    opening = pending;
    // Discovery belongs to all callers currently waiting for it. A caller's
    // cancellation must not cancel or poison another caller's shared lookup.
    void Promise.resolve().then(async () => {
      const signal = pending.controller.signal;
      signal.throwIfAborted();
      const scope = typeof applicationId === 'function' ? await applicationId()
        : applicationId ?? scopeHint ?? (await request('application', { signal })).selection?.id;
      signal.throwIfAborted();
      return createParticipantTransport({ applicationId: scope,
        exchange: (message, options) => request('peers/participant', { method: 'POST', body: message, signal: options.signal }),
      });
    }).then(value => {
      if (opening === pending) { transport = value; opening = undefined; }
      for (const waiter of pending.waiters) waiter.resolve(value);
    }, error => {
      if (opening === pending) opening = undefined;
      for (const waiter of pending.waiters) waiter.reject(error);
    });
    return pending;
  };
  const open = (scopeHint, { signal } = {}) => {
    signal?.throwIfAborted();
    if (transport) return Promise.resolve(transport);
    const pending = opening ?? start(scopeHint);
    return new Promise((resolve, reject) => {
      const finish = callback => {
        if (!pending.waiters.delete(waiter)) return;
        signal?.removeEventListener('abort', cancelled);
        callback();
      };
      const waiter = { resolve: value => finish(() => resolve(value)), reject: error => finish(() => reject(error)) };
      const cancelled = () => {
        waiter.reject(signal.reason);
        if (!pending.waiters.size && opening === pending) {
          opening = undefined;
          pending.controller.abort(signal.reason);
        }
      };
      pending.waiters.add(waiter);
      if (signal?.aborted) cancelled();
      else signal?.addEventListener('abort', cancelled, { once: true });
    });
  };
  return Object.freeze({
    async exchange(message, options) {
      options?.signal?.throwIfAborted();
      // Reject unwanted facets before a scope lookup or transport request.
      const input = validateParticipantRequest(message);
      return (await open(input.applicationId, options)).exchange(input, options);
    },
    async request(facet, action, payload, options) {
      options?.signal?.throwIfAborted();
      if (!participantAccepts(CONTROL_PARTICIPANT_POLICY, { facet, action }))
        throw new ParticipantProtocolError('PEER_PARTICIPANT_FACET_FORBIDDEN');
      return (await open(undefined, options)).request(facet, action, payload, options);
    },
  });
}
