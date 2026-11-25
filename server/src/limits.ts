import { RESOURCE_LIMITS } from "../../contract/limits.mjs";
export const MB = 1024 * 1024;
/** Default per-account caps; configurable in service_state (0004_account_limits.sql, NULL = unlimited). */
export const PAGE_LIMIT = 20;
export const RESIDENT_LIMIT = 5;
export const ACCOUNT_STORAGE_LIMIT = 200 * MB;
export const MAX_FILES_PER_VERSION = RESOURCE_LIMITS.files_per_publication;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const ACTIVITY_RETENTION = 30 * DAY;
export const AD_HOC_IDLE = DAY;
// Persist activity in minute buckets, granting at most this much extra retention.
export const ACCESS_WRITE_INTERVAL = 60_000;
/** One-time dashboard join codes for adding an agent to an account. */
export const AGENT_JOIN_CODE_TTL = 10 * 60 * 1000;
/** Granted pages returned per agent listing page. */
export const AGENT_PAGE_LIST_LIMIT = 100;
