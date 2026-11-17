/** Bounded routing hints. Nothing in this directory grants application authority. */
export const PEER_DIRECTORY_LIMITS = Object.freeze({ peers: 64, peersPerPrincipal: 8, routes: 4, profiles: 8,
  defaultTtlMs: 120_000, minTtlMs: 30_000, maxTtlMs: 600_000, advertisementBytes: 16_384 });
export class PeerDiscoveryError extends Error {
  constructor(code, message) { super(message); this.name = 'PeerDiscoveryError'; this.code = code; }
}
const invalid = message => { throw new PeerDiscoveryError('invalid_advertisement', message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;
export function validatePeerId(value) {
  if (!identifier(value)) invalid('Expected a bounded peer identity');
  return value;
}
export function validatePeerAdvertisement(value) {
  if (!exact(value, ['peerId', 'storageId', 'profiles', 'routes', 'coordinatorEligible', 'recovery']) ||
      !identifier(value.peerId) || !identifier(value.storageId) || typeof value.coordinatorEligible !== 'boolean' ||
      !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > PEER_DIRECTORY_LIMITS.profiles ||
      !value.profiles.every(identifier) || new Set(value.profiles).size !== value.profiles.length ||
      !Array.isArray(value.routes) || !value.routes.length || value.routes.length > PEER_DIRECTORY_LIMITS.routes)
    invalid('Expected a bounded peer advertisement');
  const routes = value.routes.map(route => {
    if (route?.kind === 'invitation' && exact(route, ['kind', 'peerId']) && identifier(route.peerId))
      return Object.freeze({ kind: 'invitation', peerId: route.peerId });
    if (route?.kind === 'rendezvous' && exact(route, ['kind', 'channel']) && identifier(route.channel) && route.channel.length <= 160)
      return Object.freeze({ kind: 'rendezvous', channel: route.channel });
    if (route?.kind !== 'https' || !exact(route, ['kind', 'url']) || typeof route.url !== 'string' || route.url.length > 2048)
      invalid('Expected an HTTPS introduction, invitation listener or rendezvous channel');
    let url; try { url = new URL(route.url); } catch { invalid('Invalid peer route'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.href.length > 2048 ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && local))
      invalid('Peer introductions require secure URLs without credentials');
    return Object.freeze({ kind: 'https', url: url.href });
  });
  if (new Set(routes.map(route => JSON.stringify(route))).size !== routes.length) invalid('Peer routes must be distinct');
  let recovery;
  if (value.recovery !== undefined) {
    const point = value.recovery;
    if (!exact(point, ['generation', 'sequence', 'root', 'controlRevision', 'retainedAt']) || !identifier(point.generation) ||
        !natural(point.sequence) || !natural(point.controlRevision) || !natural(point.retainedAt) ||
        typeof point.root !== 'string' || !/^[0-9a-f]{64}$/.test(point.root)) invalid('Invalid retained-prefix hint');
    recovery = Object.freeze({ generation: point.generation, sequence: point.sequence, root: point.root,
      controlRevision: point.controlRevision, retainedAt: point.retainedAt });
  }
  return Object.freeze({ peerId: value.peerId, storageId: value.storageId, profiles: Object.freeze([...value.profiles].sort()),
    routes: Object.freeze(routes), coordinatorEligible: value.coordinatorEligible, ...(recovery ? { recovery } : {}) });
}
export function validatePeerTtl(value = PEER_DIRECTORY_LIMITS.defaultTtlMs) {
  if (!Number.isSafeInteger(value) || value < PEER_DIRECTORY_LIMITS.minTtlMs || value > PEER_DIRECTORY_LIMITS.maxTtlMs)
    invalid('Peer advertisement lifetime is outside the supported range');
  return value;
}
export function validatePeerAdvertisementLease(value) {
  if (!exact(value, ['advertisement', 'expiresAt', 'refreshAfter']) || !natural(value.expiresAt) ||
      !natural(value.refreshAfter) || value.refreshAfter >= value.expiresAt) invalid('Invalid advertisement lease');
  return Object.freeze({ advertisement: validatePeerAdvertisement(value.advertisement), expiresAt: value.expiresAt, refreshAfter: value.refreshAfter });
}
export function validatePeerDirectory(value) {
  if (!exact(value, ['applicationId', 'peers']) || !identifier(value.applicationId) || !Array.isArray(value.peers) ||
      value.peers.length > PEER_DIRECTORY_LIMITS.peers) invalid('Invalid peer directory');
  const peers = value.peers.map(validatePeerAdvertisementLease);
  if (new Set(peers.map(peer => peer.advertisement.peerId)).size !== peers.length) invalid('Duplicate directory peer');
  return Object.freeze({ applicationId: value.applicationId, peers: Object.freeze(peers) });
}
