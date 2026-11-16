/** Authoritative platform resource policy shared by service, tools and preview.
 * Limits describe bytes of UTF-8 JSON before transport framing. */
export const RESOURCE_LIMITS = Object.freeze({
  file_bytes: 25 * 1024 * 1024,
  blob_bytes: 25 * 1024 * 1024,
  event_bytes: 64 * 1024,
  state_bytes: 1024 * 1024,
  files_per_publication: 2000,
  path_characters: 512,
  active_scopes: 128,
  scope_bindings: 4096,
  command_receipts: 20_000,
  command_receipt_bytes: 32 * 1024 * 1024,
  private_record_bytes: 1024 * 1024,
  private_records: 4096,
  private_records_bytes: 8 * 1024 * 1024,
});

export const STREAM_LIMITS = Object.freeze({
  streams: 64,
  producers: 32,
  subscriptions: 16,
  record_bytes: 64 * 1024,
  snapshot_record_bytes: 192 * 1024,
  batch_bytes: 256 * 1024,
  replay_bytes: 512 * 1024,
  retained_bytes: 8 * 1024 * 1024,
  unclaimed_retained_bytes: 1024 * 1024,
  retained_records: 20_000,
  stream_records: 10_000,
  retention_seconds: 30 * 86400,
  batch_records: 100,
  replay_records: 500,
});

/** A single retained snapshot uses the same total batch and storage budgets. */
export function streamRecordLimit({ durability, max_records }) {
  return durability === "durable" && max_records === 1
    ? STREAM_LIMITS.snapshot_record_bytes : STREAM_LIMITS.record_bytes;
}
