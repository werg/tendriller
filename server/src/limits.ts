// Limits and timing constants (PROTOCOL sections 3.1, 4, 8).

export const MB = 1024 * 1024;
export const MAX_FILE = 25 * MB;
export const MAX_BLOB = 25 * MB;
export const MAX_EVENT_DATA = 64 * 1024;
export const MAX_STATE = 1 * MB;
export const MAX_EVAL_CODE = 256 * 1024;
export const MAX_LOGS = 2000;
export const MAX_EVENTS = 10_000;
export const MAX_PATH_LEN = 512;
export const MAX_FILES_PER_VERSION = 2000;
export const MAX_TRANSCRIPT = 100;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const EVENT_RETENTION = 30 * DAY;
export const ACTIVITY_RETENTION = 30 * DAY;
export const DEDUPE_RETENTION = DAY;
export const AD_HOC_IDLE = DAY;

export const HEALTH_TIMEOUT = 15 * SECOND;
export const LONGPOLL_MAX_WAIT_S = 25;
export const LONGPOLL_DEBOUNCE = 300;
export const WAKE_MERGE_WINDOW = 3 * SECOND;
export const WEBHOOK_DEBOUNCE = 2 * SECOND;
export const WEBHOOK_TIMEOUT = 10 * SECOND;
export const WEBHOOK_BACKOFF = [30 * SECOND, 2 * MINUTE, 10 * MINUTE];
export const PRESENCE_TICK = 30 * SECOND;
export const WORKING_WINDOW = 60 * SECOND;
export const STATUS_OVERRIDE_TTL = 10 * MINUTE;
export const ADOPT_CODE_TTL = 10 * MINUTE;
export const ADOPT_MAX_ATTEMPTS = 10;
export const DEFAULT_GRACE_S = 120;
export const DEFAULT_OWNER_PER_HOUR = 60;
export const DEFAULT_PAGE_PER_HOUR = 12;
export const EVAL_DEFAULT_TIMEOUT = 10 * SECOND;
export const EVAL_MAX_TIMEOUT = 120 * SECOND;
export const CHECK_TIMEOUT = 30 * SECOND;
export const CLEANUP_INTERVAL = HOUR;
