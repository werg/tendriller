// Shared sequence mathematics; no storage, authorization, or transport effects.
export interface Sequenced { seq: number }
export interface HistorySource<T extends Sequenced> {
  highWater(): number;
  earliest(): number | null;
  /** Render records on demand so byte-bounded pages do not decode unused rows. */
  read(after: number, limit: number): Iterable<T>;
}
export interface HistoryGap { from: number | null; through: number | null }

/** Preserve earlier gaps when a leased reader requests a smaller replay. */
export function mergeHistoryGaps(first: HistoryGap, second: HistoryGap): HistoryGap {
  return {
    from: first.from === null ? second.from : second.from === null ? first.from : Math.min(first.from, second.from),
    through: first.through === null ? second.through : second.through === null ? first.through : Math.max(first.through, second.through),
  };
}

/** Only inspect through the returned page unless the source is exhausted. */
export function historyGap(records: readonly Sequenced[], after: number, boundary: number): HistoryGap {
  let next = after + 1, gap: HistoryGap = { from: null, through: null };
  for (const record of records) {
    if (record.seq > next) gap = mergeHistoryGaps(gap, { from: next, through: record.seq - 1 });
    next = record.seq + 1;
  }
  if (boundary >= next) gap = mergeHistoryGaps(gap, { from: next, through: boundary });
  return gap;
}

export function historyPage<T extends Sequenced>(rows: Iterable<T>, options: {
  after: number; limit: number; latest: number; earliest: number | null;
  maxBytes?: number; sizeOf?: (record: T) => number;
}) {
  const records: T[] = [];
  let used = 0, truncated = false;
  for (const record of rows) {
    const size = options.sizeOf?.(record) ?? 0;
    // At least one record must advance a reader, including built-in event envelopes
    // larger than a caller's preferred page size.
    if (records.length && used + size > (options.maxBytes ?? Infinity)) { truncated = true; break; }
    records.push(record); used += size;
  }
  const cursor = records.at(-1)?.seq ?? options.after;
  const exhausted = !truncated && records.length < options.limit;
  const gap = historyGap(records, options.after, exhausted ? options.latest : cursor);
  return { records, cursor, gap, history: {
    earliest_available_seq: options.earliest, latest_seq: options.latest,
    gap: gap.from !== null, missing_through: gap.through,
  } };
}

export function readHistory<T extends Sequenced>(source: HistorySource<T>, after: number, limit: number,
  options: { maxBytes?: number; sizeOf?: (record: T) => number } = {}) {
  const latest = source.highWater();
  const rows = source.read(after, limit);
  return historyPage(rows, { ...options, after, limit, latest, earliest: source.earliest() });
}
