// Opt-in processing checkpoints. Legacy event readers remain independent.
import type { Tendril } from "./tendril";
import { assertValid } from "../../contract/index.mjs";
import type { ConsumerBatch, ConsumerLease, EventConsumer } from "../../contract/index.mjs";
import { HttpError, json, readJson } from "./http";
import { randomB32, sha256Hex } from "./ids";
import { renderEvent } from "./events";
import { addActivity } from "./activity";

type ConsumerRow = { name: string; handled_seq: number; delivered_seq: number; gap_from: number | null; gap_through: number | null;
  holder: string | null; lease_hash: string | null; lease_expires_at: number; generation: number; created_at: number; updated_at: number };
const MAX_CONSUMERS = 16;
const DEFAULT_TTL = 90;
export const CONSUMER_ROUTE = /^consumers(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/(?:claim|events|renew|ack|release))?$/;

function stored(t: Tendril, name: string): ConsumerRow | null { return t.db.one<ConsumerRow>("SELECT * FROM event_consumers WHERE name=?", name); }
function publicConsumer(t: Tendril, row: ConsumerRow): EventConsumer {
  return { name: row.name, handled_seq: row.handled_seq, delivered_seq: row.delivered_seq, generation: row.generation,
    lease: row.holder && row.lease_expires_at > t.now() ? { holder: row.holder, expires_at: row.lease_expires_at } : null,
    created_at: row.created_at, updated_at: row.updated_at };
}
function highWater(t: Tendril): number { return t.db.one<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name='events'")?.seq ?? 0; }
function lease(t: Tendril, name: string, hash: string): ConsumerRow {
  const row = stored(t, name);
  if (!row) throw new HttpError(404, "not_found", "No such event consumer");
  if (row.lease_hash !== hash || !row.holder || row.lease_expires_at <= t.now())
    throw new HttpError(409, "lease_lost", "This processing lease expired, was released, or belongs to another holder");
  return row;
}
async function leaseHash(req: Request): Promise<string> {
  const token = req.headers.get("X-Tendril-Lease");
  if (!token) throw new HttpError(401, "lease_required", "Provide the current X-Tendril-Lease token");
  assertValid("consumerLeaseToken", token);
  return sha256Hex(token);
}

export async function claimConsumer(t: Tendril, name: string, value: unknown): Promise<ConsumerLease> {
  assertValid("consumerName", name);
  const body = assertValid("consumerClaim", value), holder = body.holder.trim();
  if (!holder) throw new HttpError(400, "bad_request", "holder must identify a processing instance");
  const token = `cl_${randomB32(40)}`, hash = await sha256Hex(token);
  const consumer = t.ctx.storage.transactionSync(() => {
    const row = stored(t, name), now = t.now();
    if (row?.holder && row.lease_expires_at > now) throw new HttpError(409, "lease_busy", "Another instance holds this consumer", {
      holder: row.holder, expires_at: row.lease_expires_at, generation: row.generation });
    if (!row && (t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM event_consumers")?.n ?? 0) >= MAX_CONSUMERS)
      throw new HttpError(429, "quota", "At most 16 named event consumers per page");
    if (row && body.after !== undefined) throw new HttpError(409, "checkpoint_exists", "after is only accepted when creating a new consumer; existing checkpoints cannot be overwritten");
    const handled = row?.handled_seq ?? body.after ?? 0;
    if (handled > highWater(t)) throw new HttpError(400, "bad_request", "after is beyond the event history");
    t.db.run(`INSERT INTO event_consumers(name,handled_seq,delivered_seq,holder,lease_hash,lease_expires_at,generation,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET delivered_seq=excluded.delivered_seq,gap_from=NULL,gap_through=NULL,
      holder=excluded.holder,lease_hash=excluded.lease_hash,lease_expires_at=excluded.lease_expires_at,generation=excluded.generation,updated_at=excluded.updated_at`,
      name, handled, handled, holder, hash, now + (body.ttl_seconds ?? DEFAULT_TTL) * 1000, (row?.generation ?? 0) + 1, row?.created_at ?? now, now);
    return publicConsumer(t, stored(t, name)!);
  });
  return { consumer, lease_token: token };
}

export function readConsumer(t: Tendril, name: string, hash: string, limit: number): ConsumerBatch {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "bad_request", "limit must be an integer from 1 to 500");
  return t.ctx.storage.transactionSync(() => {
    const row = lease(t, name, hash);
    const events = t.db.all("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?", row.handled_seq, limit).map(renderEvent);
    const cursor = events.at(-1)?.seq ?? row.handled_seq, latest = highWater(t);
    const boundary = events.length < limit ? latest : cursor;
    // A narrower replay must not forget a gap already exposed under this lease.
    // The delivered ceiling also survives replay, so forgetting the gap would
    // otherwise allow a later acknowledgement to skip an unseen event silently.
    let next = row.handled_seq + 1, gapFrom = row.gap_from, gapThrough = row.gap_through;
    for (const event of events) {
      if (event.seq > next) { gapFrom = Math.min(gapFrom ?? next, next); gapThrough = Math.max(gapThrough ?? 0, event.seq - 1); }
      next = event.seq + 1;
    }
    if (boundary >= next) { gapFrom = Math.min(gapFrom ?? next, next); gapThrough = Math.max(gapThrough ?? 0, boundary); }
    t.db.run("UPDATE event_consumers SET delivered_seq=?,gap_from=?,gap_through=?,updated_at=? WHERE name=?",
      Math.max(row.delivered_seq, cursor), gapFrom, gapThrough, t.now(), name);
    return { consumer: publicConsumer(t, stored(t, name)!), events, cursor, history: {
      earliest_available_seq: t.db.one<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events")?.seq ?? null,
      latest_seq: latest, gap: gapFrom !== null, missing_through: gapThrough,
    } };
  });
}

export function acknowledgeConsumer(t: Tendril, name: string, hash: string, value: unknown): EventConsumer {
  const body = assertValid("consumerAck", value);
  return t.ctx.storage.transactionSync(() => {
    const row = lease(t, name, hash);
    if (body.through < row.handled_seq) throw new HttpError(409, "checkpoint_regression", "The handled checkpoint cannot move backwards");
    if (body.through > Math.max(row.delivered_seq, row.gap_through ?? 0)) throw new HttpError(400, "unseen_cursor", "Read this range under the current lease before acknowledging it");
    if (body.through > row.handled_seq && row.gap_from !== null && body.through >= row.gap_from && body.gap_acknowledged !== true)
      throw new HttpError(409, "history_gap", "Some events in this range expired. Recover the context and explicitly acknowledge the gap before advancing", { missing_through: row.gap_through });
    const gapRemains = row.gap_through !== null && row.gap_through > body.through;
    t.db.run("UPDATE event_consumers SET handled_seq=?,delivered_seq=?,gap_from=?,gap_through=?,updated_at=? WHERE name=?", body.through, Math.max(row.delivered_seq, body.through),
      gapRemains ? Math.max(row.gap_from!, body.through + 1) : null, gapRemains ? row.gap_through : null, t.now(), name);
    if (body.through !== row.handled_seq) addActivity(t, { kind: "events_handled", summary: `Consumer ${name} handled through #${body.through}${body.gap_acknowledged ? " (history gap acknowledged)" : ""}`, by: row.holder });
    return publicConsumer(t, stored(t, name)!);
  });
}

export async function handleConsumers(t: Tendril, req: Request, url: URL, rest: string): Promise<Response> {
  if (rest === "consumers") {
    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
    return json({ consumers: t.db.all<ConsumerRow>("SELECT * FROM event_consumers ORDER BY name").map(row => publicConsumer(t, row)) });
  }
  const [, name, action] = /^consumers\/([^/]+)\/([^/]+)$/.exec(rest)!;
  if (action === "claim" && req.method === "POST") return json(await claimConsumer(t, name, await readJson(req, 2048)));
  const hash = await leaseHash(req);
  if (action === "events" && req.method === "GET") {
    if ([...url.searchParams.keys()].some(key => key !== "limit")) throw new HttpError(400, "bad_request", "Consumer reads use the stored handled checkpoint; only limit is accepted");
    return json(readConsumer(t, name, hash, url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100));
  }
  if (action === "ack" && req.method === "POST") return json({ consumer: acknowledgeConsumer(t, name, hash, await readJson(req, 2048)) });
  if (action === "renew" && req.method === "POST") {
    const body = assertValid("consumerRenew", await readJson(req, 2048));
    return json({ consumer: t.ctx.storage.transactionSync(() => {
      lease(t, name, hash);
      t.db.run("UPDATE event_consumers SET lease_expires_at=?,updated_at=? WHERE name=?", t.now() + (body.ttl_seconds ?? DEFAULT_TTL) * 1000, t.now(), name);
      return publicConsumer(t, stored(t, name)!);
    }) });
  }
  if (action === "release" && req.method === "POST") {
    return json({ consumer: t.ctx.storage.transactionSync(() => {
      const previous = stored(t, name);
      if (previous?.lease_hash === hash && previous.holder === null) return publicConsumer(t, previous);
      lease(t, name, hash);
      t.db.run("UPDATE event_consumers SET holder=NULL,lease_expires_at=0,updated_at=? WHERE name=?", t.now(), name);
      return publicConsumer(t, stored(t, name)!);
    }) });
  }
  throw new HttpError(405, "method_not_allowed");
}
