import { PEER_DIRECTORY_LIMITS as LIMITS, validatePeerAdvertisement, validatePeerId, validatePeerTtl,
  type PeerAdvertisement, type PeerAdvertisementLease } from '../../contract/discovery.mjs';
import { accountActive, currentPrincipal, type Principal } from './access';
import { selectedApplication } from './application';
import { HttpError } from './http';
import type { Tendril } from './tendril';

interface StoredAdvertisement extends PeerAdvertisementLease { owner: string; principal: Principal }
const key = 'peer_directory';
function identity(t: Tendril, principal: Principal): string {
  const current = currentPrincipal(t, principal);
  if (!current || current.kind === 'page' && (current.role === 'display' || !current.accountId))
    throw new HttpError(403, 'forbidden', 'Peer discovery requires an authenticated participant');
  return current.kind === 'agent' ? `agent:${current.credentialHash}` : `account:${current.accountId}`;
}
function active(t: Tendril): StoredAdvertisement[] {
  return t.db.get<StoredAdvertisement[]>(key, []).filter(row => row.expiresAt > t.now() && currentPrincipal(t, row.principal));
}
function publicLease(row: StoredAdvertisement): PeerAdvertisementLease {
  return { advertisement: row.advertisement, expiresAt: row.expiresAt, refreshAfter: row.refreshAfter };
}

/** On-demand only. Directory expiry never wakes a Durable Object or selects authority. */
export async function exchangeDiscovery(t: Tendril, principal: Principal, action: 'read' | 'advertise' | 'withdraw', input?: any): Promise<unknown> {
  identity(t, principal);
  if (action === 'read') {
    const before = active(t), accounts = [...new Set(before.flatMap(row => row.principal.kind === 'page' && row.principal.accountId ? [row.principal.accountId] : []))];
    const permitted = new Map(await Promise.all(accounts.map(async account => [account, await accountActive(t, account)] as const)));
    identity(t, principal);
    // Take another local snapshot after account reads; a concurrent withdrawal,
    // revocation or replacement must not leak its prior route into this response.
    const peers = active(t).filter(row => row.principal.kind !== 'page' || permitted.get(row.principal.accountId!) === true);
    return { applicationId: selectedApplication(t).id, peers: peers.map(publicLease) };
  }
  let advertisement: PeerAdvertisement | undefined, ttlMs: number | undefined, peerId: string;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an advertisement request');
    if (action === 'advertise') {
      if (Object.keys(input).some(field => !['advertisement', 'ttlMs'].includes(field))) throw new Error('Unknown advertisement request field');
      advertisement = validatePeerAdvertisement(input.advertisement); ttlMs = validatePeerTtl(input.ttlMs); peerId = advertisement.peerId;
    } else {
      if (Object.keys(input).some(field => field !== 'peerId')) throw new Error('Unknown withdrawal field');
      peerId = validatePeerId(input.peerId);
    }
  } catch (error) { throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : 'Invalid advertisement'); }
  const owner = identity(t, principal);
  return t.transaction(() => {
    const rows = active(t), previous = rows.find(row => row.advertisement.peerId === peerId);
    if (previous && previous.owner !== owner) throw new HttpError(409, 'peer_identity_conflict', 'Another participant owns this active advertisement');
    if (action === 'withdraw') {
      t.db.set(key, rows.filter(row => row.advertisement.peerId !== peerId));
      return { withdrawn: peerId };
    }
    if (!previous && (rows.length >= LIMITS.peers || rows.filter(row => row.owner === owner).length >= LIMITS.peersPerPrincipal))
      throw new HttpError(429, 'peer_directory_full', 'The bounded peer directory is full');
    // Duplicate availability updates do not create writes until the coalescing
    // window expires. Discovery carries routing hints, never per-edit updates.
    if (previous && previous.refreshAfter > t.now() && JSON.stringify(previous.advertisement) === JSON.stringify(advertisement))
      return publicLease(previous);
    const lease: StoredAdvertisement = { advertisement: advertisement!, owner, principal,
      expiresAt: t.now() + ttlMs!, refreshAfter: t.now() + Math.floor(ttlMs! / 2) };
    t.db.set(key, [...rows.filter(row => row.advertisement.peerId !== peerId), lease]);
    return publicLease(lease);
  });
}
