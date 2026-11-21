/** Canonical application transport defaults. STUN discovers public addresses;
 * it does not relay application traffic or require a paid TURN account. */
export const PEER_TRANSPORT_POLICY = Object.freeze({
  directTimeoutMs: 5000,
  configuration: Object.freeze({ iceServers: Object.freeze([
    Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' }),
  ]) }),
});
