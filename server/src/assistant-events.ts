import { callbackUrl, deliveryDisposition, signedHeaders, verifyCallback, webhookKey } from '../../integrations/chatgpt/webhook-data.mjs';
import { activeAdapter, connection, type Adapter, type Connection } from './assistant-admission';
import { APP_ID, EVENT_LIMIT, assistantOAuth, fields, requireScope, string, type Principal } from './assistant-shared';
import { activeGrant } from './accounts/oauth-data';
import { pagePolicy } from './access';
import { HttpError, readBody } from './http';
import { sha256Hex } from './ids';
import { withSelectedAssistantGeneration } from './peer-generations';
import type { Tendril } from './tendril';

const RETENTION = 256, JOB_LIMIT = 256, MAX_WATCHERS = 8, CALLBACK_DEADLINE = 4000;
const DAY = 86_400_000;
type EventRow = { seq: number; source_id: string; generation: string; name: string; payload: string; created_at: number };
type Watcher = { id: string; grant_id: string; name: string; url: string; secret: string; expires_at: number };
type Job = EventRow & Watcher & { attempts: number; event_seq: number; watcher_id: string };
const toMessage = (item: EventRow, applicationId: string) => ({
  name: applicationId + '.' + item.name, timestamp: new Date(item.created_at).toISOString(),
  data: { applicationId, sourceEventId: item.source_id, generation: item.generation, payload: JSON.parse(item.payload) },
});

function callbackTarget(t: Tendril, input: unknown) {
  const value = string(input, 4096);
  try {
    const url = new URL(callbackUrl(value));
    const origins = (t.env.ASSISTANT_CALLBACK_ORIGINS ?? '').split(/\s+/);
    if (origins.includes(url.origin)) return url.href;
  } catch { /* malformed or nonpublic address */ }
  throw new HttpError(400, 'callback_origin_not_allowed');
}

const storeKeys = new WeakMap<Tendril, { secret: string; key: Promise<CryptoKey> }>();
async function key(t: Tendril): Promise<CryptoKey> {
  const secret = t.env.ASSISTANT_STORE_KEY;
  try {
    if (secret) {
      let cached = storeKeys.get(t);
      if (cached?.secret !== secret) {
        const bytes = Uint8Array.from(atob(secret), char => char.charCodeAt(0));
        if (bytes.byteLength !== 32) throw Error();
        cached = { secret, key: crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
        storeKeys.set(t, cached);
      }
      return await cached.key;
    }
  } catch { /* report missing or malformed key without its value */ }
  throw new HttpError(503, 'assistant_delivery_key_unavailable');
}

async function seal(t: Tendril, id: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12)), encode = new TextEncoder();
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encode.encode(t.tid + ':' + id) },
    await key(t), encode.encode(secret));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(data)));
}
async function unseal(t: Tendril, id: string, sealed: string) {
  const data = Uint8Array.from(atob(sealed), char => char.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12),
    additionalData: new TextEncoder().encode(t.tid + ':' + id) }, await key(t), data.subarray(12)));
}

export async function ingestAssistantEvent(t: Tendril, adapter: Adapter, body: Record<string, unknown>) {
  fields(body, ['type', 'id', 'name', 'sourceEventId', 'generation', 'payload']);
  const name = string(body.name, 80), sourceId = string(body.sourceEventId, 256);
  const generation = string(body.generation, 64, APP_ID), payload = JSON.stringify(body.payload);
  if (new TextEncoder().encode(payload).byteLength > EVENT_LIMIT) throw new HttpError(413, 'event_too_large');
  if (await pagePolicy(t) !== 'active') throw new HttpError(403, 'forbidden');
  return withSelectedAssistantGeneration(t, selected => {
    if (selected !== generation) throw new HttpError(409, 'event_generation_changed');
    if (activeAdapter(t)?.id !== adapter.id || !connection(t)?.events.some(event => event.name === name))
      throw new HttpError(403, 'event_not_approved');
    const prior = t.db.one<{ seq: number; payload: string }>(
      'SELECT seq,payload FROM assistant_events WHERE generation=? AND source_id=? AND name=?', generation, sourceId, name);
    if (prior) {
      if (prior.payload !== payload) throw new HttpError(409, 'event_identity_conflict');
      return prior.seq;
    }
    const now = t.now(), watchers = t.db.all<{ id: string }>('SELECT id FROM assistant_watchers WHERE name=? AND expires_at>?', name, now);
    if (watchers.length && (t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM assistant_jobs')!.n + watchers.length > JOB_LIMIT))
      throw new HttpError(429, 'delivery_backlog_full');
    return t.transaction(() => {
      const { seq } = t.db.one<{ seq: number }>(`INSERT INTO assistant_events(source_id,generation,name,payload,created_at)
        VALUES(?,?,?,?,?) RETURNING seq`, sourceId, generation, name, payload, now)!;
      for (const watcher of watchers)
        t.db.run('INSERT INTO assistant_jobs(event_seq,watcher_id,due) VALUES(?,?,?)', seq, watcher.id, now + 50);
      if (seq > RETENTION)
        t.db.run('DELETE FROM assistant_events WHERE seq<=? AND NOT EXISTS(SELECT 1 FROM assistant_jobs WHERE event_seq=assistant_events.seq)', seq - RETENTION);
      if (watchers.length) t.scheduleAlarm();
      return seq;
    });
  });
}

export async function assistantInbox(t: Tendril, approved: Connection, params: Record<string, unknown>) {
  const cursor = params.after ?? 0, limit = params.limit ?? 20;
  if (!Number.isSafeInteger(cursor) || (cursor as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 25)
    throw new HttpError(400, 'invalid_cursor');
  return withSelectedAssistantGeneration(t, generation => {
    if (connection(t)?.version !== approved.version) throw new HttpError(403, 'connection_changed');
    const oldest = t.db.one<{ seq: number }>('SELECT seq FROM assistant_events ORDER BY seq LIMIT 1')?.seq;
    const events = t.db.all<EventRow>('SELECT * FROM assistant_events WHERE seq>? AND generation=? ORDER BY seq LIMIT ?',
      cursor, generation, Number(limit) + 1);
    const page = events.slice(0, Number(limit));
    return { generation, oldest: oldest ?? null, next: page.at(-1)?.seq ?? cursor, hasMore: events.length > Number(limit),
      truncated: typeof oldest === 'number' && Number(cursor) > 0 && Number(cursor) < oldest - 1,
      events: page.map(item => ({ sequence: item.seq, ...toMessage(item, approved.applicationId) })) };
  });
}

export async function changeAssistantSubscription(t: Tendril, approved: Connection, principal: Principal, method: string,
  params: Record<string, unknown>, signal: AbortSignal) {
  requireScope(principal, 'events:subscribe');
  const subscribing = method === 'events/subscribe';
  fields(params, ['name', 'arguments', 'delivery', ...(subscribing ? ['cursor', 'ttlMs'] : [])], ['name', 'arguments', 'delivery']);
  const args = fields(params.arguments, ['application_id']);
  if (args.application_id !== approved.applicationId) throw new HttpError(404, 'application_not_connected');
  const event = approved.events.find(item => approved.applicationId + '.' + item.name === params.name);
  if (!event) throw new HttpError(403, 'event_not_approved');
  const delivery = fields(params.delivery, subscribing ? ['mode', 'url', 'secret'] : ['mode', 'url']);
  if (delivery.mode !== 'webhook') throw new HttpError(400, 'unsupported_delivery');
  const url = callbackTarget(t, delivery.url);
  const id = 'sub_' + await sha256Hex(JSON.stringify([approved.applicationId, principal.account, principal.grant, event.name, url]));
  if (!subscribing) {
    if (connection(t)?.version !== approved.version) throw new HttpError(403, 'connection_changed');
    t.transaction(() => {
      t.db.run('DELETE FROM assistant_jobs WHERE watcher_id=?', id);
      t.db.run('DELETE FROM assistant_watchers WHERE id=?', id);
    });
    return {};
  }
  if (params.cursor != null || params.ttlMs != null && (!Number.isSafeInteger(params.ttlMs) || Number(params.ttlMs) <= 0))
    throw new HttpError(400, 'invalid_subscription');
  const secret = string(delivery.secret, 200);
  try { webhookKey(secret); } catch { throw new HttpError(400, 'invalid_webhook_secret'); }
  const sealed = await seal(t, id, secret), now = t.now(), expiry = now + Math.min(Number(params.ttlMs ?? DAY), 7 * DAY);
  const existing = t.db.one<Watcher>('SELECT * FROM assistant_watchers WHERE id=?', id);
  if (existing?.expires_at && existing.expires_at > now && await unseal(t, id, existing.secret) === secret &&
      existing.expires_at >= expiry - 60_000) return { id, refreshBefore: new Date(existing.expires_at).toISOString(), cursor: null, truncated: false };
  const count = t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM assistant_watchers WHERE expires_at>? AND id<>?', now, id)!.n;
  if (count >= MAX_WATCHERS) throw new HttpError(429, 'subscription_capacity');
  try {
    await verifyCallback({ subscriptionId: id, url, secret, now, signal,
      send: async (_target: string, options: { body: string; headers: HeadersInit; signal?: AbortSignal }) => {
        const deadline = AbortSignal.timeout(CALLBACK_DEADLINE);
        const combined = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
        const res = await fetch(url, { method: 'POST', headers: options.headers, body: options.body, redirect: 'manual', signal: combined });
        return { status: res.status, body: new TextDecoder().decode(await readBody(new Request('https://callback.invalid/', {
          method: 'POST', body: res.body, signal: combined,
        }), 8192, CALLBACK_DEADLINE)) };
      } });
  } catch (error) {
    throw new HttpError(400, 'callback_verification_failed', 'Callback verification failed',
      { rpcCode: -32015, reason: (error as { data?: { reason?: string } }).data?.reason ?? 'challenge_failed' });
  }
  const oauth = await assistantOAuth(t.env);
  if (!oauth || !await activeGrant(t.env, oauth, principal.grant, principal.account) || connection(t)?.version !== approved.version)
    throw new HttpError(403, 'connection_changed');
  t.transaction(() => {
    t.db.run('DELETE FROM assistant_jobs WHERE watcher_id IN(SELECT id FROM assistant_watchers WHERE expires_at<=?)', now);
    t.db.run('DELETE FROM assistant_watchers WHERE expires_at<=?', now);
    t.db.run(`INSERT INTO assistant_watchers(id,grant_id,name,url,secret,expires_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,expires_at=excluded.expires_at`, id, principal.grant, event.name, url, sealed, expiry);
  });
  return { id, refreshBefore: new Date(expiry).toISOString(), cursor: null, truncated: false };
}

export function nextAssistantDelivery(t: Tendril): number | null {
  if (!t.db.get('assistant_tables', false) || !connection(t) || t.db.get('disabled', false)) return null;
  return t.db.one<{ due: number }>('SELECT due FROM assistant_jobs ORDER BY due LIMIT 1')?.due ?? null;
}

export async function runAssistantDelivery(t: Tendril) {
  const approved = connection(t), at = nextAssistantDelivery(t), now = t.now();
  if (!approved || at === null || at > now) return;
  const jobs = t.db.all<Job>(`SELECT e.*,w.*,j.event_seq,j.watcher_id,j.attempts FROM assistant_jobs j
    JOIN assistant_watchers w ON w.id=j.watcher_id JOIN assistant_events e ON e.seq=j.event_seq
    WHERE j.due<=? ORDER BY j.due LIMIT 4`, now);
  const oauth = await assistantOAuth(t.env);
  // Retain signed event identity through bounded, durable retries.
  const allowed = !!oauth && !!activeAdapter(t) && await pagePolicy(t) === 'active';
  const grants = new Map<string, boolean>();
  for (const job of jobs) {
    let retry = false;
    try {
      if (allowed && job.expires_at > now) {
        if (!grants.has(job.grant_id)) {
          const grant = await activeGrant(t.env, oauth!, job.grant_id, approved.owner);
          grants.set(job.grant_id, !!grant?.scope.split(' ').includes('events:subscribe'));
        }
        if (grants.get(job.grant_id)) {
          const secret = await unseal(t, job.watcher_id, job.secret);
          const eventId = 'evt_' + await sha256Hex(JSON.stringify([job.watcher_id, job.generation, job.source_id, job.name]));
          const body = JSON.stringify({ eventId, ...toMessage(job, approved.applicationId), cursor: null });
          const url = callbackTarget(t, job.url);
          // The authority fence covers initiating egress, without retaining it
          // over an external network response.
          const { pending } = await withSelectedAssistantGeneration(t, generation => ({
            pending: generation === job.generation && connection(t)?.version === approved.version && activeAdapter(t)
              ? fetch(url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(CALLBACK_DEADLINE),
                headers: signedHeaders({ id: eventId, subscriptionId: job.watcher_id, body, secrets: [secret], now }) }) : null,
          }));
          if (pending) {
            const res = await pending;
            await res.body?.cancel();
            const outcome = deliveryDisposition(res.status);
            retry = outcome === 'retry';
            if (outcome === 'gone') {
              t.transaction(() => {
                t.db.run('DELETE FROM assistant_jobs WHERE watcher_id=?', job.watcher_id);
                t.db.run('DELETE FROM assistant_watchers WHERE id=?', job.watcher_id);
              });
            }
          }
        }
      }
    } catch (error) { retry = !(error instanceof HttpError && error.status === 400); }
    if (retry && job.attempts < 7) t.db.run('UPDATE assistant_jobs SET attempts=attempts+1,due=? WHERE event_seq=? AND watcher_id=?',
      now + Math.min(300_000, 2000 * 2 ** job.attempts), job.event_seq, job.watcher_id);
    else t.db.run('DELETE FROM assistant_jobs WHERE event_seq=? AND watcher_id=?', job.event_seq, job.watcher_id);
  }
}
