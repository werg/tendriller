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
  // Hard transport ceiling is separate from the actor's effective per-body quota.
  owned_body_bytes: 5 * 1024 * 1024,
  unclaimed_body_bytes: 1 * 1024 * 1024,
  owned_page_bytes: 25 * 1024 * 1024,
  unclaimed_page_bytes: 2 * 1024 * 1024,
  upload_sessions_per_actor: 8,
  upload_sessions_per_page: 32,
  upload_expiry_seconds: 86400,
  shared_files: 512,
  shared_file_paths: 4096,
  file_snapshot_bytes: 1024 * 1024,
  file_history: 10,
  file_history_seconds: 30 * 86400,
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
