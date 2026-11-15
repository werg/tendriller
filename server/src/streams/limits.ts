import { HttpError } from "../http";

export const MAX_STREAMS = 64;
export const MAX_PRODUCERS = 32;
export const MAX_STREAM_RECORD_BYTES = 64 * 1024;
export const MAX_STREAM_BATCH_BYTES = 256 * 1024;
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const MAX_STREAM_RECORDS = 20_000;
export const MAX_STREAM_REPLAY_BYTES = 512 * 1024;
export const MAX_SUBSCRIPTIONS = 16;
export const STREAM_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function streamCursor(value: unknown, label = "after"): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new HttpError(400, "bad_request", `${label} must be an explicit nonnegative safe integer`);
  return value as number;
}
