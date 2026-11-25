/** Bounded routing hints. Nothing in this directory grants application authority. */
export const PEER_DIRECTORY_LIMITS = Object.freeze({ peers: 64, peersPerPrincipal: 8, routes: 4,
  advertisementBytes: 16_384 });
export class PeerDiscoveryError extends Error {
  constructor(code, message) { super(message); this.name = 'PeerDiscoveryError'; this.code = code; this.retryable = false; }
}
const invalid = message => { throw new PeerDiscoveryError('invalid_advertisement', message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
export function validatePeerId(value) {
  if (!identifier(value)) invalid('Expected a bounded peer identity');
  return value;
}
export function validatePeerRoute(route) {
  if (route?.kind === 'invitation' && exact(route, ['kind', 'peerId']) && identifier(route.peerId))
    return Object.freeze({ kind: 'invitation', peerId: route.peerId });
  if (route?.kind === 'rendezvous' && exact(route, ['kind', 'channel']) && identifier(route.channel) && route.channel.length <= 160)
    return Object.freeze({ kind: 'rendezvous', channel: route.channel });
  if (route?.kind !== 'https' || !exact(route, ['kind', 'url']) || typeof route.url !== 'string' || route.url.length > 2048)
    invalid('Expected an HTTPS introduction, invitation listener or rendezvous channel');
  let url; try { url = new URL(route.url); } catch { invalid('Invalid peer route'); }
  const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.search || url.hash || url.href.length > 2048 ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && local))
    invalid('Peer introductions require secure URLs without credentials');
  return Object.freeze({ kind: 'https', url: url.href });
}
export function validatePeerAdvertisement(value) {
  if (!exact(value, ['peerId', 'storageId', 'routes']) ||
      !identifier(value.peerId) || !identifier(value.storageId) ||
      !Array.isArray(value.routes) || !value.routes.length || value.routes.length > PEER_DIRECTORY_LIMITS.routes)
    invalid('Expected a bounded peer advertisement');
  const routes = value.routes.map(validatePeerRoute);
  if (new Set(routes.map(route => JSON.stringify(route))).size !== routes.length) invalid('Peer routes must be distinct');
  return Object.freeze({ peerId: value.peerId, storageId: value.storageId, routes: Object.freeze(routes) });
}
export function validatePeerAdvertisementPresence(value) {
  if (!exact(value, ['advertisement'])) invalid('Invalid advertisement presence');
  return Object.freeze({ advertisement: validatePeerAdvertisement(value.advertisement) });
}
export function validatePeerDirectory(value) {
  if (!exact(value, ['applicationId', 'peers']) || !identifier(value.applicationId) || !Array.isArray(value.peers) ||
      value.peers.length > PEER_DIRECTORY_LIMITS.peers) invalid('Invalid peer directory');
  const peers = value.peers.map(validatePeerAdvertisementPresence);
  if (new Set(peers.map(peer => peer.advertisement.peerId)).size !== peers.length) invalid('Duplicate directory peer');
  return Object.freeze({ applicationId: value.applicationId, peers: Object.freeze(peers) });
}
