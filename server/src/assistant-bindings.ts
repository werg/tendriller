import type { Tendril } from './tendril';
import type { Connection } from './assistant-admission';
import type { Principal } from './assistant-shared';
import { fields, string } from './assistant-shared';
import { HttpError } from './http';
import { safeEqual, sha256Hex } from './ids';

export const CONSUMER_KEY = /^td_c_([a-f0-9-]{36})\.([a-f0-9]{64})$/u;
export const CONSUMER_ROUTES = ['on-demand', 'event-subscriber', 'mounted-inbox', 'native-loop'] as const;
export type ConsumerRoute = typeof CONSUMER_ROUTES[number];
export type ConsumerRow = {
  id: string; client_id: string; label: string; credential_hash: string; revision: number;
  status: 'pending' | 'active' | 'revoked'; queries: string; commands: string; events: string;
  route: ConsumerRoute; created_at: number;
};
export type Consumer = {
  id: string; revision: number; clientId: string; label: string; route: ConsumerRoute;
  verification: 'approved-binding' | 'oauth-client'; queries: string[]; commands: string[]; events: string[];
};

const publicConsumer = (row: ConsumerRow): Consumer => ({
  id: row.id, revision: row.revision, clientId: row.client_id, label: row.label, route: row.route,
  verification: 'approved-binding', queries: JSON.parse(row.queries), commands: JSON.parse(row.commands), events: JSON.parse(row.events),
});
export function consumerCurrent(t: Tendril, consumer: Pick<Consumer, 'id' | 'revision' | 'verification'>): boolean {
  if (consumer.verification === 'oauth-client') return true;
  const row = t.db.one<ConsumerRow>('SELECT * FROM assistant_consumers WHERE id=?', consumer.id);
  return row?.status === 'active' && row.revision === consumer.revision;
}

export async function resolveConsumer(t: Tendril, approved: Connection, principal: Principal): Promise<Consumer> {
  if (!principal.bindingCredential) return {
    id: 'oauth_client_' + await sha256Hex(JSON.stringify([approved.applicationId, principal.account, principal.client])),
    revision: 1, clientId: principal.client, label: 'Tool caller via ' + principal.client, route: 'on-demand', verification: 'oauth-client',
    queries: approved.queries.map(value => value.name), commands: approved.commands.map(value => value.name), events: approved.events.map(value => value.name),
  };
  const match = CONSUMER_KEY.exec(principal.bindingCredential);
  if (!match) throw new HttpError(401, 'invalid_agent_binding');
  const hash = await sha256Hex(principal.bindingCredential);
  const row = t.db.one<ConsumerRow>('SELECT * FROM assistant_consumers WHERE id=?', match[1]);
  if (!row || row.client_id !== principal.client || !safeEqual(row.credential_hash, hash)) throw new HttpError(401, 'invalid_agent_binding');
  if (row.status !== 'active') throw new HttpError(403, row.status === 'pending' ? 'agent_binding_approval_required' : 'agent_binding_revoked');
  const consumer = publicConsumer(row);
  // Consent to the application remains the outer ceiling after a later edit.
  for (const kind of ['queries', 'commands', 'events'] as const)
    consumer[kind] = consumer[kind].filter(name => approved[kind].some(entry => entry.name === name));
  return consumer;
}

/** The caller retains its proof before admission, so retries never mint a new identity. */
export async function registerConsumer(t: Tendril, approved: Connection, principal: Principal, input: Record<string, unknown>) {
  const token = principal.bindingCredential, match = token && CONSUMER_KEY.exec(token);
  if (!match) throw new HttpError(400, 'agent_binding_proof_required', 'Generate and retain a td_c_<uuid>.<64 hex> binding token before registration.');
  const label = string(input.label, 100), route = input.route ?? 'on-demand';
  if (!CONSUMER_ROUTES.includes(route as ConsumerRoute)) throw new HttpError(400, 'invalid_agent_route');
  const selection = (kind: 'queries' | 'commands' | 'events') => {
    const requested = input[kind] ?? approved[kind].map(entry => entry.name);
    if (!Array.isArray(requested) || requested.length > 24 || new Set(requested).size !== requested.length ||
        requested.some(name => !approved[kind].some(entry => entry.name === name))) throw new HttpError(403, 'operation_not_approved');
    return JSON.stringify(requested);
  };
  const queries = selection('queries'), commands = selection('commands'), events = selection('events');
  const credentialHash = await sha256Hex(token!);
  const existing = t.db.one<ConsumerRow>('SELECT * FROM assistant_consumers WHERE id=?', match[1]);
  if (existing) {
    if (existing.client_id !== principal.client || existing.credential_hash !== credentialHash || existing.label !== label ||
        existing.route !== route || existing.queries !== queries || existing.commands !== commands || existing.events !== events)
      throw new HttpError(409, 'agent_binding_conflict');
    return { agentBindingId: existing.id, status: existing.status, revision: existing.revision };
  }
  if ((t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM assistant_consumers')?.n ?? 0) >= 32)
    throw new HttpError(429, 'agent_binding_capacity');
  t.db.run(`INSERT INTO assistant_consumers(id,client_id,label,credential_hash,revision,status,queries,commands,events,route,created_at)
    VALUES(?,?,?,?,1,'pending',?,?,?,?,?)`, match[1], principal.client, label, credentialHash, queries, commands, events, route, t.now());
  return { agentBindingId: match[1], status: 'pending', revision: 1 };
}

export function requireConsumerOperation(consumer: Consumer, kind: 'queries' | 'commands' | 'events', name: string): void {
  if (!consumer[kind].includes(name)) throw new HttpError(403, 'agent_operation_not_approved');
}

export function callerContext(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  const context = fields(input, ['endpointId', 'endpointIncarnation', 'runId', 'interactionId', 'threadId', 'documentPath', 'publicationId'], []);
  return Object.fromEntries(Object.entries(context).map(([name, value]) => [name, string(value, name === 'documentPath' ? 512 : 160)]));
}

export type Provider = { bindingId: string; adapterHash: string; selectionEpoch: number };
export const providerBindingId = (hash: string): string => 'provider_' + hash;
export function selectedProvider(t: Tendril): Provider | null {
  return t.db.get<Provider | null>('assistant_provider', null);
}
export function selectProvider(t: Tendril, hash: string): Provider {
  const current = selectedProvider(t);
  if (current?.adapterHash === hash) return current;
  const next = { bindingId: providerBindingId(hash), adapterHash: hash, selectionEpoch: (current?.selectionEpoch ?? 0) + 1 };
  t.db.set('assistant_provider', next);
  return next;
}
