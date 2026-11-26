import type { TransportPeerDescription } from '../../contract/transport-diagnostics.mjs';

/** The subset of the owner's signed admission state (`@tendriller/core/admission`) used to name links. */
export interface AdmissionMembers {
  readonly accounts?: readonly string[];
  readonly members: readonly {
    readonly publicKey: string; readonly self?: boolean; readonly via?: string; readonly subject?: string;
    readonly label?: string; readonly accountId?: string; readonly administrator?: boolean; readonly email?: string | null; readonly activation?: bigint | number | string;
  }[];
}
export interface PeerDirectory {
  readonly agents: readonly { readonly public_key?: string; readonly handle: string }[];
  readonly admission: AdmissionMembers | null;
}

// Built-in attestation labels say nothing about which device it is.
const GENERIC = new Set(['Browser device', 'Agent', 'Granted key', 'Page creator', 'device', 'agent']);
const MIN_MS = Date.UTC(2020, 0, 1), MAX_MS = Date.UTC(2200, 0, 1);

function admittedOn(value: unknown): string | null {
  let ms: number;
  try { ms = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : NaN; } catch { return null; }
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return null;
  return `added ${new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

/**
 * Names one authenticated signing key from local page state only: the agent roster's
 * public handles, then the owner's signed admission members (host-attested account and
 * email). The viewer's account is its own admitted member's account (a creator viewer:
 * the page's admission accounts); the creator device is the viewer's when the viewer's
 * account is one of the page's admission accounts.
 */
export function describeTransportPeer(peerId: string, { agents, admission }: PeerDirectory): TransportPeerDescription | null {
  const members = Array.isArray(admission?.members) ? admission!.members : [];
  const member = members.find(item => item.publicKey === peerId);
  // The same signed membership the Devices view badges: true/false only when the peer is a member.
  const administrator = member ? member.administrator === true : null;
  const agent = agents.find(item => item.public_key === peerId);
  if (agent) return { role: 'agent', handle: agent.handle, administrator };
  if (!member || member.self) return null;
  // The host attests an agent's label as its public @handle (shown by the Devices view too).
  if (member.subject === 'agent') {
    const attested = typeof member.label === 'string' && /^@[a-z][a-z0-9_-]{1,31}$/.test(member.label) ? member.label.slice(1) : null;
    return { role: 'agent', handle: attested, administrator };
  }
  const accounts = Array.isArray(admission?.accounts) ? admission!.accounts : [];
  const self = members.find(item => item.self);
  // The page creator created the page from the owner account, so a creator viewer
  // owns the page's admission accounts; any other viewer owns its attested account.
  const mine = new Set(typeof self?.accountId === 'string' ? [self.accountId] : self?.via === 'creator' ? accounts : []);
  const own = typeof member.accountId === 'string' && mine.has(member.accountId) || member.via === 'creator' && [...mine].some(account => accounts.includes(account));
  if (own) {
    const named = typeof member.label === 'string' && !GENERIC.has(member.label) ? member.label : null;
    return { role: 'own-device', label: named ?? (member.via === 'creator' ? 'created this page' : admittedOn(member.activation)), administrator };
  }
  return { role: 'member', email: typeof member.email === 'string' ? member.email : null, administrator };
}
