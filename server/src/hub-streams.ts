/**
 * Stateless DO-to-DO stream subscriptions between AgentHub and Tendril.
 *
 * Neither Durable Object holds an outbound WebSocket: AgentHub keeps only its
 * hibernatable inbound agent socket and persists active virtual stream rows in
 * SQLite, while Tendril persists hub subscribers in `hub_subscribers` and pushes
 * frames back via one-shot `POST /stream/deliver`. Both DOs hibernate at ~0 GB-s
 * when idle and survive eviction cleanly.
 */
import type { Tendril } from './tendril';

export type HubStreamKind = 'setup-watch' | 'peer-discovery' | 'peer-invitations' | 'rendezvous';

export interface HubStreamRef {
  key: string;
  kind: HubStreamKind;
  agentId: string;
  connId: string;
  streamId: number;
}

export interface HubSubscriber<T = unknown> extends HubStreamRef {
  state: T;
  createdAt: number;
}

export interface HubStreamOpenResult {
  protocol: string;
  initial: string[];
}

export interface HubStreamDataResult {
  frames?: string[];
  close?: { code: number; reason: string };
}

interface SubscriberRow {
  key: string;
  kind: HubStreamKind;
  agent_id: string;
  conn_id: string;
  stream_id: number;
  state: string;
  created_at: number;
}

export function hubStreamKey(agentId: string, connId: string, streamId: number): string {
  return `${agentId}:${connId}:${streamId}`;
}

function hydrate<T>(row: SubscriberRow): HubSubscriber<T> {
  return {
    key: row.key,
    kind: row.kind,
    agentId: row.agent_id,
    connId: row.conn_id,
    streamId: row.stream_id,
    state: JSON.parse(row.state) as T,
    createdAt: row.created_at,
  };
}

export function listHubSubscribers<T = unknown>(t: Tendril, kind?: HubStreamKind): HubSubscriber<T>[] {
  return t.db.cached(`hub_subscribers:${kind ?? '*'}`, () => {
    const rows = kind
      ? t.db.all<SubscriberRow>('SELECT key,kind,agent_id,conn_id,stream_id,state,created_at FROM hub_subscribers WHERE kind=? ORDER BY created_at, key', kind)
      : t.db.all<SubscriberRow>('SELECT key,kind,agent_id,conn_id,stream_id,state,created_at FROM hub_subscribers ORDER BY created_at, key');
    return rows.map(row => hydrate<T>(row));
  }, ['hub_subscribers']);
}

export function getHubSubscriber<T = unknown>(t: Tendril, key: string): HubSubscriber<T> | null {
  const row = t.db.one<SubscriberRow>('SELECT key,kind,agent_id,conn_id,stream_id,state,created_at FROM hub_subscribers WHERE key=?', key);
  return row ? hydrate<T>(row) : null;
}

export function putHubSubscriber<T>(t: Tendril, sub: HubSubscriber<T>): void {
  t.db.run(
    `INSERT INTO hub_subscribers(key,kind,agent_id,conn_id,stream_id,state,created_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET kind=excluded.kind, agent_id=excluded.agent_id, conn_id=excluded.conn_id,
       stream_id=excluded.stream_id, state=excluded.state`,
    sub.key, sub.kind, sub.agentId, sub.connId, sub.streamId, JSON.stringify(sub.state), sub.createdAt,
  );
}

export function deleteHubSubscriber(t: Tendril, key: string): boolean {
  const existing = t.db.one<{ key: string }>('SELECT key FROM hub_subscribers WHERE key=?', key);
  if (!existing) return false;
  t.db.run('DELETE FROM hub_subscribers WHERE key=?', key);
  return true;
}

export type HubDeliveryResult = 'delivered' | 'gone' | 'transient_error';

/** One-shot push from Tendril to AgentHub. Distinguishes permanent stream absence from transient DO/network errors. */
export async function deliverHubData(t: Tendril, ref: HubStreamRef, text: string): Promise<HubDeliveryResult> {
  const hub = t.env.AGENT_HUB;
  if (!hub) return 'gone';
  try {
    const response = await hub.get(hub.idFromName(ref.agentId)).fetch(new Request('https://hub.internal/stream/deliver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connId: ref.connId, s: ref.streamId, kind: 'data', text }),
    }));
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      return 'gone';
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return 'transient_error';
    }
    const body = await response.json().catch(() => null) as { delivered?: unknown } | null;
    if (body?.delivered === true) return 'delivered';
    if (body?.delivered === false) return 'gone';
    return 'transient_error';
  } catch {
    return 'transient_error';
  }
}

/** Deletes the local subscriber synchronously and best-effort notifies AgentHub to close the virtual stream. */
export function closeHubSubscriber(t: Tendril, ref: HubStreamRef, code: number, reason: string, { notify = true } = {}): void {
  t.db.run('DELETE FROM hub_subscribers WHERE key=?', ref.key);
  if (!notify || !t.env.AGENT_HUB) return;
  const delivery = t.env.AGENT_HUB.get(t.env.AGENT_HUB.idFromName(ref.agentId)).fetch(new Request('https://hub.internal/stream/deliver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connId: ref.connId, s: ref.streamId, kind: 'closed', code, reason }),
  })).then(r => r.body?.cancel()).catch(() => {});
  t.ctx.waitUntil(delivery);
}

/** Closes hub subscribers owned by `agentId` (or older grant revisions), returning the removed rows for module cleanup. */
export function closeAgentHubSubscribers(
  t: Tendril,
  agentId: string,
  reason: string,
  keepRevision?: number,
): HubSubscriber[] {
  const rows = t.db.all<SubscriberRow>(
    'SELECT key,kind,agent_id,conn_id,stream_id,state,created_at FROM hub_subscribers WHERE agent_id=?',
    agentId,
  ).map(row => hydrate<{ principal?: { revision?: number } }>(row));
  const closed: HubSubscriber[] = [];
  for (const sub of rows) {
    if (keepRevision !== undefined && sub.state?.principal?.revision === keepRevision) continue;
    closeHubSubscriber(t, sub, 4003, reason);
    closed.push(sub);
  }
  return closed;
}

/** Closes every hub subscriber on page deletion. */
export function closeAllHubSubscribers(t: Tendril, code: number, reason: string): void {
  const rows = listHubSubscribers(t);
  for (const sub of rows) closeHubSubscriber(t, sub, code, reason);
}
