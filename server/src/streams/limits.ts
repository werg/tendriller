import { HttpError } from "../http";
import { STREAM_LIMITS } from "../../../contract/limits.mjs";
import type { Tendril } from "../tendril";

export const MAX_STREAMS = STREAM_LIMITS.streams;
export const MAX_PRODUCERS = STREAM_LIMITS.producers;
export const MAX_STREAM_RECORD_BYTES = STREAM_LIMITS.record_bytes;
export const MAX_STREAM_SNAPSHOT_RECORD_BYTES = STREAM_LIMITS.snapshot_record_bytes;
export const MAX_STREAM_BATCH_BYTES = STREAM_LIMITS.batch_bytes;
export const MAX_STREAM_BYTES = STREAM_LIMITS.retained_bytes;
export const MAX_STREAM_RECORDS = STREAM_LIMITS.retained_records;
export const MAX_STREAM_REPLAY_BYTES = STREAM_LIMITS.replay_bytes;
export const MAX_SUBSCRIPTIONS = STREAM_LIMITS.subscriptions;
export const STREAM_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function effectiveStreamLimits(t: Pick<Tendril, 'db'>) {
  const { unclaimed_retained_bytes, ...policy } = STREAM_LIMITS;
  return { ...policy, retained_bytes: t.db.get<string | null>('owner_account', null) ? policy.retained_bytes : unclaimed_retained_bytes };
}

export function streamCursor(value: unknown, label = "after"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new HttpError(400, "bad_request", `${label} must be an explicit nonnegative safe integer`);
  return value as number;
}
