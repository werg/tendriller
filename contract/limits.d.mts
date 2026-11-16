export const RESOURCE_LIMITS: Readonly<{
  file_bytes: number; blob_bytes: number; event_bytes: number; state_bytes: number;
  files_per_publication: number; path_characters: number;
  active_scopes: number; scope_bindings: number; command_receipts: number; command_receipt_bytes: number;
  private_record_bytes: number; private_records: number; private_records_bytes: number;
  owned_body_bytes: number; unclaimed_body_bytes: number; owned_page_bytes: number; unclaimed_page_bytes: number;
  upload_sessions_per_actor: number; upload_sessions_per_page: number; upload_expiry_seconds: number;
  shared_files: number; shared_file_paths: number; file_snapshot_bytes: number; file_history: number; file_history_seconds: number;
}>;
export const STREAM_LIMITS: Readonly<{
  streams: number; producers: number; subscriptions: number; record_bytes: number;
  snapshot_record_bytes: number; batch_bytes: number; replay_bytes: number;
  retained_bytes: number; unclaimed_retained_bytes: number; retained_records: number;
  stream_records: number; retention_seconds: number; batch_records: number; replay_records: number;
}>;
export function streamRecordLimit(info: { durability: string; max_records?: number | null }): number;
