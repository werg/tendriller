// Compatibility adapters read original storage and preserve original sequences.
import type { StreamInfo, StreamRecord } from "../../../contract/index.mjs";
import type { Db } from "../db";
import type { HistorySource, Sequenced } from "./history";

export type LegacyHistoryTable = "events" | "logs" | "transcript";
export const BUILTIN_STREAMS: StreamInfo[] = [
  { name: "system.events", durability: "durable", readers: "agent", builtin: true, max_records: 10_000, max_age_seconds: 30 * 86400 },
  { name: "system.logs", durability: "durable", readers: "agent", builtin: true, max_records: 2000, max_age_seconds: null },
  { name: "system.transcript", durability: "durable", readers: "page", builtin: true, max_records: 100, max_age_seconds: null },
  { name: "system.state", durability: "ephemeral", readers: "page", builtin: true, max_records: null, max_age_seconds: null },
  { name: "system.presence", durability: "ephemeral", readers: "page", builtin: true, max_records: null, max_age_seconds: null },
];
const TABLES: Record<string, LegacyHistoryTable> = Object.assign(Object.create(null), {
  "system.events": "events", "system.logs": "logs", "system.transcript": "transcript",
});

export function legacyTable(name: string): LegacyHistoryTable | undefined { return TABLES[name]; }

export function legacyHistorySource<T extends Sequenced>(db: Db, table: LegacyHistoryTable,
  render: (row: Record<string, any>) => T): HistorySource<T> {
  return {
    highWater: () => db.one<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name=?", table)?.seq ?? 0,
    earliest: () => db.one<{ seq: number | null }>(`SELECT MIN(seq) AS seq FROM ${table}`)?.seq ?? null,
    *read(after, limit) {
      for (const row of db.all(`SELECT * FROM ${table} WHERE seq>? ORDER BY seq LIMIT ?`, after, limit)) yield render(row);
    },
  };
}

export function renderBuiltinRecord(name: string, row: Record<string, any>): StreamRecord {
  let data: unknown, type: string, producer: string;
  if (name === "system.events") {
    data = { seq: row.seq, ts: row.ts, type: row.type, data: row.data == null ? null : JSON.parse(row.data),
      device: row.device ?? null, role: row.role ?? null, wake: !!row.wake, withheld: !!row.withheld, by: row.by ?? null };
    type = row.type; producer = row.by ?? (row.device ? `device:${row.device}` : "system");
  } else if (name === "system.logs") {
    data = { seq: row.seq, ts: row.ts, device: row.device, version: row.version, level: row.level, message: row.message,
      ...(row.stack ? { stack: row.stack } : {}) };
    type = row.level; producer = row.device ? `device:${row.device}` : "system";
  } else {
    data = { ts: row.ts, from: row.src, text: row.text }; type = "message"; producer = row.src;
  }
  // Legacy sources did not retain separate receipt timestamps; expose their
  // stored timestamp without inventing a second historical clock.
  return { stream: name, seq: row.seq, ts: row.ts, received_at: row.ts, type, data, producer, id: null };
}


export function builtinRecord(db: Db, name: string, seq: number): StreamRecord | null {
  const table = legacyTable(name); if (!table) return null;
  const row = db.one(`SELECT * FROM ${table} WHERE seq=?`, seq);
  return row ? renderBuiltinRecord(name, row) : null;
}
