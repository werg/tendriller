/** Canonical application transport defaults. STUN discovers public addresses;
 * it does not relay application traffic or require a paid TURN account. */
export const PEER_TRANSPORT_POLICY = Object.freeze({
  // ICE over STUN normally settles well under 2 s; a silent stall falls back to the
  // relay after 3 s (promotion back to direct stays available via reconsiderConnections).
  directTimeoutMs: 3000,
  configuration: Object.freeze({ iceServers: Object.freeze([
    Object.freeze({ urls: 'stun:stun.cloudflare.com:3478' }),
  ]) }),
});

/** Merge host-minted TURN iceServers with the canonical STUN default. */
export function mergeIceServers(hostIceServers) {
  const base = PEER_TRANSPORT_POLICY.configuration.iceServers.map(s => ({ ...s }));
  if (!Array.isArray(hostIceServers) || !hostIceServers.length) return base;
  const seen = new Set(base.map(s => JSON.stringify(s.urls)));
  for (const server of hostIceServers) {
    if (!server || typeof server !== 'object' || !server.urls) continue;
    const key = JSON.stringify(server.urls);
    if (seen.has(key)) continue;
    seen.add(key);
    base.push({ ...server });
  }
  return base;
}
