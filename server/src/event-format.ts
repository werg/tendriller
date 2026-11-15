import type { StoredEvent } from "./events";

export function renderEvent(r: Record<string, any>): StoredEvent {
  return {
    seq: r.seq,
    ...(r.context ? { context: JSON.parse(r.context) } : {}),
    ts: r.ts,
    type: r.type,
    data: r.data === null || r.data === undefined ? null : JSON.parse(r.data),
    device: r.device ?? null,
    role: r.role ?? null,
    wake: !!r.wake,
    withheld: !!r.withheld,
    by: r.by ?? null,
  };
}
