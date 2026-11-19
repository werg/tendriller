import { callbackUrl, deliveryDisposition, signedHeaders, verifyCallback, webhookKey } from '../../integrations/chatgpt/webhook-data.mjs';
import { notifyAssistantActivity } from './assistant-activity';
import { activeAdapters, connection, type Connection } from './assistant-admission';
import { APP_ID, EVENT_LIMIT, MCP_APPLICATION_EVENT, assistantOAuth, fields, requireScope, string, type Principal } from './assistant-shared';
import { activeGrant, registeredGrant, type OAuthGrant } from './accounts/oauth-data';
import { admitPageTraffic } from './traffic-budget';
import { requireWritesOpen } from './service-state';
import { pagePolicy } from './access';
import { HttpError, readBody } from './http';
import { sha256Hex } from './ids';
import { withSelectedAssistantGeneration } from './peer-generations';
import type { Tendril } from './tendril';
import { callerContext, consumerCurrent, initializeAssistantBindings, providerBindingId, requireConsumerOperation, type Consumer } from './assistant-bindings';

const RETENTION = 256, JOB_LIMIT = 256, MAX_WATCHERS = 8, CALLBACK_DEADLINE = 4000;
const DEFER_MS = 15 * 60_000, LEASE_MS = 15_000, MAX_ATTEMPTS = 8;
const DAY = 86_400_000;
type EventRow = { seq: number; source_id: string; generation: string; name: string; payload: string; created_at: number };
type Watcher = { id: string; grant_id: string; client_id: string; name: string; url: string; secret: string; previous_secret: string | null; rotate_until: number | null; verified_at: number; expires_at: number };
type Job = EventRow & Watcher & { attempts: number; event_seq: number; watcher_id: string; block_reason: string | null; binding_id: string | null };
type InboxFloor = { generation: string; through: number };
const toMessage = (item: EventRow, applicationId: string) => ({
  name: MCP_APPLICATION_EVENT, timestamp: new Date(item.created_at).toISOString(),
  data: { applicationId, event: item.name, sourceEventId: item.source_id, generation: item.generation, payload: JSON.parse(item.payload) },
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

export async function ingestAssistantEvent(t: Tendril, adapterHash: string, deviceId: string, body: Record<string, unknown>) {
  fields(body, ['type', 'id', 'name', 'sourceEventId', 'generation', 'payload', 'context'], ['type', 'id', 'name', 'sourceEventId', 'generation', 'payload']);
  initializeAssistantBindings(t);
  const name = string(body.name, 80), sourceId = string(body.sourceEventId, 256);
  const generation = string(body.generation, 64, APP_ID), payload = JSON.stringify(body.payload);
  const context = callerContext(body.context);
  if (new TextEncoder().encode(payload).byteLength > EVENT_LIMIT) throw new HttpError(413, 'event_too_large');
  // The socket is already approved. D1 checks happen on connection and egress;
  // the hot ingest path uses local revocation and the regional traffic budget.
  await admitPageTraffic(t.env, t.tid, connection(t)?.owner ?? null);
  const retained = await withSelectedAssistantGeneration(t, async (selected, canUseDevice) => {
    if (selected !== generation) throw new HttpError(409, 'event_generation_changed');
    if (!await canUseDevice(deviceId, false) || !activeAdapters(t).includes(adapterHash))
      throw new HttpError(403, 'adapter_device_not_enrolled');
    if (!connection(t)?.events.some(event => event.name === name)) throw new HttpError(403, 'event_not_approved');
    const prior = t.db.one<{ seq: number; payload: string }>(
      'SELECT seq,payload FROM assistant_events WHERE generation=? AND source_id=? AND name=?', generation, sourceId, name);
    if (prior) {
      if (prior.payload !== payload) throw new HttpError(409, 'event_identity_conflict');
      const pending = t.db.one<{ due: number }>('SELECT MIN(due) AS due FROM assistant_jobs WHERE event_seq=?', prior.seq);
      return { seq: prior.seq, due: pending?.due ?? null };
    }
    const now = t.now(), watchers = t.db.all<{ id: string }>('SELECT id FROM assistant_watchers WHERE name=? AND expires_at>?', name, now);
    if (watchers.length && (t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM assistant_jobs')!.n + watchers.length > JOB_LIMIT))
      throw new HttpError(429, 'delivery_backlog_full');
    return t.transaction(() => {
      const { seq } = t.db.one<{ seq: number }>(`INSERT INTO assistant_events(source_id,generation,name,payload,created_at)
        VALUES(?,?,?,?,?) RETURNING seq`, sourceId, generation, name, payload, now)!;
      t.db.run('INSERT INTO assistant_export_source(event_seq,device_id,provider_binding_id,export_version,context) VALUES(?,?,?,?,?)',
        seq, deviceId, providerBindingId(adapterHash), connection(t)!.inboxVersion, JSON.stringify({ evidence: 'exporter-asserted', ...context }));
      for (const watcher of watchers)
        t.db.run('INSERT INTO assistant_jobs(event_seq,watcher_id,due) VALUES(?,?,?)', seq, watcher.id, now + 50);
      if (seq > RETENTION) {
        const bound = seq - RETENTION, floor = inboxFloor(t, generation);
        const retired = t.db.one<{ seq: number }>(`SELECT seq FROM assistant_events WHERE generation=? AND seq>? AND seq<=?
          ORDER BY seq DESC LIMIT 1`, generation, floor, bound);
        if (retired) t.db.set('assistant_inbox_floor', { generation, through: retired.seq });
        t.db.run('DELETE FROM assistant_events WHERE seq<=? AND NOT EXISTS(SELECT 1 FROM assistant_jobs WHERE event_seq=assistant_events.seq)', bound);
        t.db.run('DELETE FROM assistant_export_source WHERE NOT EXISTS(SELECT 1 FROM assistant_events WHERE seq=event_seq)');
      }
      t.afterCommit(() => notifyAssistantActivity(t));
      return { seq, due: watchers.length ? now + 50 : null };
    });
  });
  // A duplicate retries arming the original job if the first acknowledgment
  // was lost after the commit. Acknowledged events already have a durable wake.
  if (retained.due !== null) await t.ensureAssistantDelivery(retained.due);
  return retained.seq;
}

function inboxFloor(t: Tendril, generation: string | null): number {
  const floor = t.db.get<InboxFloor | null>('assistant_inbox_floor', null);
  return floor?.generation === generation ? floor.through : 0;
}

export async function assistantInbox(t: Tendril, approved: Connection, params: Record<string, unknown>, consumer: Consumer) {
  const after = params.after ?? null, limit = params.limit ?? 20;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 25) throw new HttpError(400, 'invalid_cursor');
  const filter = params.events ?? consumer.events;
  if (!Array.isArray(filter) || filter.length > 24 || new Set(filter).size !== filter.length) throw new HttpError(400, 'invalid_event_filter');
  for (const name of filter) requireConsumerOperation(consumer, 'events', String(name));
  const names = [...filter].sort() as string[];
  const cursor = after === null || after === 0 ? null : fields(after,
    ['version', 'applicationId', 'agentBindingId', 'exportVersion', 'generation', 'filter', 'sequence']);
  if (cursor && (cursor.version !== 1 || !Number.isSafeInteger(cursor.sequence) || Number(cursor.sequence) < 0 || !Array.isArray(cursor.filter)))
    throw new HttpError(400, 'invalid_cursor');
  return withSelectedAssistantGeneration(t, generation => {
    if (connection(t)?.version !== approved.version || !consumerCurrent(t, consumer)) throw new HttpError(403, 'connection_changed');
    const floor = inboxFloor(t, generation);
    const scope = { version: 1, applicationId: approved.applicationId, agentBindingId: consumer.id,
      exportVersion: approved.inboxVersion, generation, filter: names };
    const reset = cursor && (cursor.applicationId !== scope.applicationId || cursor.agentBindingId !== scope.agentBindingId ? 'binding_changed'
      : cursor.exportVersion !== scope.exportVersion ? 'export_changed' : cursor.generation !== generation ? 'generation_changed'
      : JSON.stringify(cursor.filter) !== JSON.stringify(names) ? 'filter_changed' : Number(cursor.sequence) < floor ? 'retention_truncated' : null);
    if (reset) return { generation, next: { ...scope, sequence: floor }, resetRequired: true, reason: reset,
      recovery: 'Inspect affected work, then explicitly continue with this reset cursor or start a fresh retained read.',
      hasMore: true, truncated: reset === 'retention_truncated', events: [] };
    const sequence = cursor ? Number(cursor.sequence) : floor;
    const oldest = t.db.one<{ seq: number }>('SELECT seq FROM assistant_events WHERE generation=? AND seq>? ORDER BY seq LIMIT 1',
      generation, floor)?.seq;
    const events = t.db.all<EventRow>('SELECT * FROM assistant_events WHERE seq>? AND generation=? ORDER BY seq LIMIT ?',
      sequence, generation, Number(limit) + 1);
    const page = events.slice(0, Number(limit));
    return { generation, oldest: oldest ?? null, next: { ...scope, sequence: page.at(-1)?.seq ?? sequence }, resetRequired: false,
      hasMore: events.length > Number(limit), truncated: !cursor && floor > 0,
      events: page.filter(item => names.includes(item.name)).map(item => ({ sequence: item.seq, ...toMessage(item, approved.applicationId),
        provenance: { evidence: 'approved-exporter-assertion', ...t.db.one('SELECT device_id AS deviceId,provider_binding_id AS providerBindingId,export_version AS exportVersion,context FROM assistant_export_source WHERE event_seq=?', item.seq) } })) };
  });
}

export async function changeAssistantSubscription(t: Tendril, approved: Connection, principal: Principal, method: string,
  params: Record<string, unknown>, signal: AbortSignal) {
  requireScope(principal, 'events:subscribe');
  const subscribing = method === 'events/subscribe';
  fields(params, ['name', 'arguments', 'delivery', ...(subscribing ? ['cursor', 'ttlMs'] : [])], ['name', 'arguments', 'delivery']);
  const args = fields(params.arguments, ['application_id', 'event']);
  if (args.application_id !== approved.applicationId) throw new HttpError(404, 'application_not_connected');
  const event = params.name === MCP_APPLICATION_EVENT && approved.events.find(item => item.name === args.event);
  if (!event) throw new HttpError(403, 'event_not_approved');
  const consumer = principal.consumer!;
  requireConsumerOperation(consumer, 'events', event.name);
  const delivery = fields(params.delivery, subscribing ? ['mode', 'url', 'secret'] : ['mode', 'url']);
  if (delivery.mode !== 'webhook') throw new HttpError(400, 'unsupported_delivery');
  let url: string;
  if (subscribing) url = callbackTarget(t, delivery.url);
  else {
    try { url = callbackUrl(delivery.url); } catch { throw new HttpError(400, 'invalid_callback'); }
  }
  const id = 'sub_' + await sha256Hex(JSON.stringify([approved.applicationId, principal.account, consumer.id, event.name, url]));
  if (!subscribing) {
    if (connection(t)?.version !== approved.version) throw new HttpError(403, 'connection_changed');
    t.transaction(() => {
      closeWatcher(t, id, 'unsubscribed');
    });
    return {};
  }
  if (params.cursor != null || params.ttlMs != null && (!Number.isSafeInteger(params.ttlMs) || Number(params.ttlMs) <= 0))
    throw new HttpError(400, 'invalid_subscription');
  const secret = string(delivery.secret, 200);
  try { webhookKey(secret); } catch { throw new HttpError(400, 'invalid_webhook_secret'); }
  const now = t.now(), expiry = now + Math.min(Number(params.ttlMs ?? DAY), 7 * DAY);
  const oauth = await assistantOAuth(t.env);
  const grant = oauth && await activeGrant(t.env, oauth, principal.grant, principal.account);
  if (!grant?.scope.split(' ').includes('events:subscribe')) throw new HttpError(403, 'authorization_revoked');
  const existing = t.db.one<Watcher>('SELECT * FROM assistant_watchers WHERE id=?', id);
  const previous = existing && existing.expires_at > now ? await unseal(t, id, existing.secret) : null;
  if (existing && existing.grant_id === principal.grant && previous === secret &&
      existing.expires_at >= expiry - 60_000) return { id, refreshBefore: new Date(existing.expires_at).toISOString(), cursor: null, truncated: false };
  const cachedVerification = !!existing && previous === secret && existing.verified_at > now - 300_000;
  const sealed = existing && previous === secret ? existing.secret : await seal(t, id, secret);
  const previousSecret = existing && previous !== null && previous !== secret ? existing.secret : existing?.previous_secret ?? null;
  const rotateUntil = existing && previous !== null && previous !== secret ? now + 300_000 : existing?.rotate_until ?? null;
  const count = t.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM assistant_watchers WHERE expires_at>? AND id<>?', now, id)!.n;
  if (count >= MAX_WATCHERS) throw new HttpError(429, 'subscription_capacity');
  const perBinding = t.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM assistant_watchers w JOIN assistant_watcher_bindings b ON b.watcher_id=w.id
    WHERE b.binding_id=? AND w.expires_at>? AND w.id<>?`, consumer.id, now, id)!.n;
  if (perBinding >= 4) throw new HttpError(429, 'agent_subscription_capacity');
  try {
    if (!cachedVerification) await verifyCallback({ subscriptionId: id, url, secret, now, signal,
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
  await requireWritesOpen(t.env);
  if (!oauth || !(await activeGrant(t.env, oauth, principal.grant, principal.account))?.scope.split(' ').includes('events:subscribe') ||
      connection(t)?.version !== approved.version || !consumerCurrent(t, consumer))
    throw new HttpError(403, 'connection_changed');
  t.transaction(() => {
    if (existing && existing.expires_at <= now) closeWatcher(t, id, 'expired');
    t.db.run(`DELETE FROM assistant_watchers WHERE expires_at<=?
      AND NOT EXISTS(SELECT 1 FROM assistant_jobs WHERE watcher_id=assistant_watchers.id)`, now);
    t.db.run(`INSERT INTO assistant_watchers(id,grant_id,client_id,name,url,secret,previous_secret,rotate_until,verified_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET grant_id=excluded.grant_id,secret=excluded.secret,
      previous_secret=excluded.previous_secret,rotate_until=excluded.rotate_until,verified_at=excluded.verified_at,expires_at=excluded.expires_at`,
      id, principal.grant, principal.client, event.name, url, sealed, rotateUntil && rotateUntil > now ? previousSecret : null,
      rotateUntil, cachedVerification ? existing!.verified_at : t.now(), expiry);
    t.db.run('INSERT OR REPLACE INTO assistant_watcher_bindings(watcher_id,binding_id) VALUES(?,?)', id, consumer.id);
  });
  return { id, refreshBefore: new Date(expiry).toISOString(), cursor: null, truncated: false };
}

export function nextAssistantDelivery(t: Tendril): number | null {
  if (!t.db.get('assistant_tables', false) || !connection(t) || t.db.get('disabled', false)) return null;
  return t.db.one<{ due: number }>('SELECT due FROM assistant_jobs ORDER BY due LIMIT 1')?.due ?? null;
}

const joinedJobs = `SELECT e.*,w.*,j.event_seq,j.watcher_id,j.attempts,j.block_reason,b.binding_id FROM assistant_jobs j
  JOIN assistant_watchers w ON w.id=j.watcher_id JOIN assistant_events e ON e.seq=j.event_seq
  LEFT JOIN assistant_watcher_bindings b ON b.watcher_id=w.id`;

function finishDelivery(t: Tendril, job: Job, outcome: string, attempts = job.attempts) {
  const receipt = t.db.one<{ seq: number }>(`INSERT INTO assistant_receipts(client_id,name,source_id,generation,watcher_id,outcome,attempts,updated_at)
    VALUES(?,?,?,?,?,?,?,?) RETURNING seq`, job.client_id, job.name, job.source_id, job.generation, job.watcher_id, outcome, attempts, t.now())!;
  if (receipt.seq > RETENTION)
    t.db.run('DELETE FROM assistant_receipts WHERE seq<=?', receipt.seq - RETENTION);
  t.db.run(`DELETE FROM assistant_watcher_bindings WHERE NOT EXISTS(SELECT 1 FROM assistant_watchers w WHERE w.id=watcher_id)
    AND NOT EXISTS(SELECT 1 FROM assistant_receipts r WHERE r.watcher_id=assistant_watcher_bindings.watcher_id)`);
  t.db.run('DELETE FROM assistant_jobs WHERE event_seq=? AND watcher_id=?', job.event_seq, job.watcher_id);
}

function closeWatcher(t: Tendril, id: string, outcome: string) {
  for (const job of t.db.all<Job>(joinedJobs + ' WHERE j.watcher_id=?', id)) finishDelivery(t, job, outcome);
  t.db.run('DELETE FROM assistant_watchers WHERE id=?', id);
}

export function revokeAssistantConsumer(t: Tendril, id: string): void {
  t.db.run("UPDATE assistant_consumers SET status='revoked',revision=revision+1 WHERE id=? AND status<>'revoked'", id);
  for (const row of t.db.all<{ watcher_id: string }>('SELECT watcher_id FROM assistant_watcher_bindings WHERE binding_id=?', id))
    closeWatcher(t, row.watcher_id, 'revoked');
  for (const socket of t.ctx.getWebSockets('application-activity'))
    if (socket.deserializeAttachment()?.b === id) socket.close(4003, 'Agent binding revoked');
}

export function assistantDeliveryStatus(t: Tendril, principal: Principal) {
  const pending = t.db.all(`SELECT j.watcher_id AS subscriptionId,e.source_id AS sourceEventId,e.name AS event,
    e.generation AS generation,j.due AS nextAttemptAt,j.attempts,j.block_reason AS blockedReason
    FROM assistant_jobs j JOIN assistant_watchers w ON w.id=j.watcher_id JOIN assistant_events e ON e.seq=j.event_seq
    WHERE w.client_id=? AND EXISTS(SELECT 1 FROM assistant_watcher_bindings b WHERE b.watcher_id=w.id AND b.binding_id=?)
    ORDER BY j.due LIMIT 25`, principal.client, principal.consumer!.id);
  const recent = t.db.all(`SELECT watcher_id AS subscriptionId,source_id AS sourceEventId,name AS event,generation,
    outcome,attempts,updated_at AS updatedAt FROM assistant_receipts r WHERE client_id=? AND
    EXISTS(SELECT 1 FROM assistant_watcher_bindings b WHERE b.watcher_id=r.watcher_id AND b.binding_id=?)
    ORDER BY seq DESC LIMIT 25`, principal.client, principal.consumer!.id);
  return { pending, recent };
}

export async function runAssistantDelivery(t: Tendril) {
  initializeAssistantBindings(t);
  const approved = connection(t), at = nextAssistantDelivery(t), now = t.now();
  if (!approved || at === null || at > now) return;
  // Reserve a short durable lease and release all serialization before I/O.
  // A crash leaves the original job eligible again once the lease expires.
  const lease = crypto.randomUUID();
  const jobs = t.transaction(() => {
    const due = t.db.all<Job>(joinedJobs + ' WHERE j.due<=? ORDER BY j.due LIMIT 4', now);
    for (const job of due) t.db.run('UPDATE assistant_jobs SET lease=?,due=? WHERE event_seq=? AND watcher_id=?',
      lease, now + LEASE_MS, job.event_seq, job.watcher_id);
    return due;
  });
  const current = (job: Job) => t.db.one('SELECT lease FROM assistant_jobs WHERE event_seq=? AND watcher_id=? AND lease=?',
    job.event_seq, job.watcher_id, lease) !== null;
  const defer = (job: Job, reason: string, delay = DEFER_MS) => t.db.run(
    'UPDATE assistant_jobs SET due=?,lease=NULL,block_reason=? WHERE event_seq=? AND watcher_id=? AND lease=?',
    Math.min(t.now() + delay, job.expires_at), reason, job.event_seq, job.watcher_id, lease);
  const finish = (job: Job, outcome: string, attempts = job.attempts) => {
    if (current(job)) t.transaction(() => finishDelivery(t, job, outcome, attempts));
  };
  const configuration = await (async () => {
    try {
      const oauth = await assistantOAuth(t.env);
      if (!oauth) return { blocked: 'oauth_unavailable' } as const;
      if (!activeAdapters(t).length || await pagePolicy(t) !== 'active') return { blocked: 'page_unavailable' } as const;
      return { oauth };
    } catch { return { blocked: 'configuration_unavailable' } as const; }
  })();
  const grants = new Map<string, Promise<OAuthGrant | null>>();
  await Promise.all(jobs.map(async job => {
    if (job.binding_id && !job.binding_id.startsWith('bridge_') && !t.db.one("SELECT 1 FROM assistant_consumers WHERE id=? AND status='active'", job.binding_id)) {
      finish(job, 'revoked'); return;
    }
    if (job.expires_at <= t.now()) { finish(job, 'expired'); return; }
    if (job.attempts >= MAX_ATTEMPTS) { finish(job, 'retry_exhausted'); return; }
    if (!configuration.oauth) { defer(job, configuration.blocked); return; }
    const oauth = configuration.oauth;
    let attempts = job.attempts;
    try {
      let pendingGrant = grants.get(job.grant_id);
      if (!pendingGrant) {
        pendingGrant = t.env.ACCOUNTS.prepare('SELECT * FROM integration_oauth_grants WHERE id=? AND account_id=?')
          .bind(job.grant_id, approved.owner).first<OAuthGrant>();
        grants.set(job.grant_id, pendingGrant);
      }
      const grant = await pendingGrant;
      if (!grant || grant.revoked_at !== null || grant.expires_at <= Date.now()) { finish(job, 'authorization_ended'); return; }
      if (grant.resource !== oauth.resource || !registeredGrant(oauth, grant)) { defer(job, 'oauth_unavailable'); return; }
      if (!grant.scope.split(' ').includes('events:subscribe')) { finish(job, 'authorization_ended'); return; }

      const secrets = await (async () => {
        try {
          const values = [await unseal(t, job.watcher_id, job.secret)];
          if (job.previous_secret && job.rotate_until && job.rotate_until > t.now())
            values.push(await unseal(t, job.watcher_id, job.previous_secret));
          return values;
        } catch { return null; }
      })();
      if (!secrets) { defer(job, 'delivery_key_unavailable'); return; }
      let url: string;
      try { url = callbackTarget(t, job.url); }
      catch { defer(job, 'callback_origin_unavailable'); return; }
      const eventId = 'evt_' + await sha256Hex(JSON.stringify([job.watcher_id, job.generation, job.source_id, job.name]));
      const body = JSON.stringify({ eventId, ...toMessage(job, approved.applicationId), cursor: null });
      const { pending } = await withSelectedAssistantGeneration(t, async generation => {
        if (!current(job)) return { pending: null };
        if (job.binding_id && !job.binding_id.startsWith('bridge_') && !t.db.one("SELECT 1 FROM assistant_consumers WHERE id=? AND status='active'", job.binding_id)) {
          finish(job, 'revoked'); return { pending: null };
        }
        if (generation !== job.generation) { finish(job, 'superseded'); return { pending: null }; }
        const live = t.db.one<Watcher>('SELECT * FROM assistant_watchers WHERE id=?', job.watcher_id);
        if (live?.grant_id !== job.grant_id || live.secret !== job.secret || connection(t)?.version !== approved.version) {
          defer(job, 'subscription_changed', 100); return { pending: null };
        }
        if (live.expires_at <= t.now()) { finish(job, 'expired'); return { pending: null }; }
        if (!activeAdapters(t).length) { defer(job, 'page_unavailable'); return { pending: null }; }
        attempts++;
        t.db.run('UPDATE assistant_jobs SET attempts=?,block_reason=NULL WHERE event_seq=? AND watcher_id=? AND lease=?',
          attempts, job.event_seq, job.watcher_id, lease);
        return { pending: fetch(url, { method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(CALLBACK_DEADLINE),
          headers: signedHeaders({ id: eventId, subscriptionId: job.watcher_id, body, secrets, now: t.now() }) }) };
      });
      if (!pending) return;
      const res = await pending;
      await res.body?.cancel();
      const outcome = deliveryDisposition(res.status);
      if (outcome === 'accepted') finish(job, 'accepted', attempts);
      else if (outcome === 'gone') {
        // Unsubscribe immediately, while preserving receipts for queued work.
        if (current(job)) t.transaction(() => closeWatcher(t, job.watcher_id, 'callback_gone'));
      } else if (outcome === 'failed') finish(job, 'callback_rejected', attempts);
      else if (attempts >= MAX_ATTEMPTS) finish(job, 'retry_exhausted', attempts);
      else defer(job, 'callback_retry', Math.min(300_000, 2000 * 2 ** (attempts - 1)));
    } catch {
      if (attempts >= MAX_ATTEMPTS) finish(job, 'retry_exhausted', attempts);
      else defer(job, attempts === job.attempts ? 'authorization_unavailable' : 'callback_retry',
        attempts === job.attempts ? DEFER_MS : Math.min(300_000, 2000 * 2 ** (attempts - 1)));
    }
  }));
}
