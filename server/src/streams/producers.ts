// Grant storage and management. Authentication and liveness live in access.ts.
import { assertValid } from "../../../contract/index.mjs";
import type { Tendril } from "../tendril";
import { HttpError } from "../http";
import { randomB32, sha256Hex } from "../ids";
import { streamInfo } from "./store";
import { MAX_PRODUCERS, STREAM_NAME_PATTERN } from "./limits";

type ProducerRow = { name: string; hash: string; streams: string; created_at: number; last_seen: number | null };
function publicProducer(row: ProducerRow) {
  return { name: row.name, streams: JSON.parse(row.streams) as string[], created_at: row.created_at, last_seen: row.last_seen };
}
export function listProducers(t: Tendril) { return t.db.all<ProducerRow>("SELECT * FROM stream_producers ORDER BY name").map(publicProducer); }
export async function createProducer(t: Tendril, value: unknown) {
  const body = assertValid("producerCreate", value);
  for (const name of body.streams) if (streamInfo(t, name).builtin) throw new HttpError(400, "bad_request", "Producers can publish only custom streams");
  const token = `tp_${randomB32(40)}`, hash = await sha256Hex(token);
  if (t.db.one("SELECT name FROM stream_producers WHERE name=?", body.name)) throw new HttpError(409, "exists", "Producer already exists");
  if ((t.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM stream_producers")?.n ?? 0) >= MAX_PRODUCERS)
    throw new HttpError(429, "quota", "At most 32 producers per tendril");
  t.db.run("INSERT INTO stream_producers(name,hash,streams,created_at,last_seen) VALUES(?,?,?,?,NULL)", body.name, hash,
    JSON.stringify([...new Set(body.streams)]), t.now());
  return { producer: publicProducer(t.db.one<ProducerRow>("SELECT * FROM stream_producers WHERE name=?", body.name)!), token };
}
export function deleteProducer(t: Tendril, name: string): void {
  if (!STREAM_NAME_PATTERN.test(name)) throw new HttpError(400, "bad_request", "Invalid producer name");
  if (!t.db.one("SELECT name FROM stream_producers WHERE name=?", name)) throw new HttpError(404, "not_found", "No such producer");
  t.db.run("DELETE FROM stream_producers WHERE name=?", name);
}
