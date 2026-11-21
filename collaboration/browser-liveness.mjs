/** A caller deadline is not owner activity. At most one non-renewable finite
 * request window is available per authenticated owner response. Classification
 * comes exclusively from the public Chronolog facade's boundedRequest getter.
 */
export function createOwnerLiveness({ livenessTimeoutMs, requestTimeoutMs, now = () => performance.now() }) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120000) throw Error('OWNER_CONFIGURATION_INVALID');
  let lastReceived = now(), spent = false, grace = 0, source;
  return {
    bind(session) {
      if (source || !session || !('boundedRequest' in session)) throw Error('CONTRACT_INCOMPATIBLE');
      source = () => session.boundedRequest;
      this.deadline();
    },
    authenticated() { lastReceived = now(); spent = false; grace = 0; },
    deadline() {
      const request = source?.(), time = now();
      const finite = request && Number.isFinite(request.startedAt) && Number.isFinite(request.deadline) &&
        request.startedAt <= time && request.deadline > time && request.deadline > request.startedAt &&
        request.deadline - request.startedAt <= requestTimeoutMs;
      if (!spent && finite && request.startedAt < lastReceived + livenessTimeoutMs) {
        spent = true; grace = request.deadline;
      }
      // Cancelling every finite call withdraws protection; it cannot rearm the
      // window. Later requests still share the first deadline until a real reply.
      return Math.max(lastReceived + livenessTimeoutMs, finite ? grace : 0);
    },
    clear() { source = undefined; spent = true; grace = 0; },
  };
}
