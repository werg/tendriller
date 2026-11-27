-- Service-wide operational totals only. These tables deliberately have no
-- account/page identifiers, request data, labels, or arbitrary metadata fields.
-- Usage is recorded when existing metering flushes, not on individual requests.
CREATE TABLE service_usage_daily (
  day TEXT PRIMARY KEY CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  mcp_calls INTEGER NOT NULL DEFAULT 0 CHECK (typeof(mcp_calls) = 'integer' AND mcp_calls BETWEEN 0 AND 9007199254740991),
  relay_ms INTEGER NOT NULL DEFAULT 0 CHECK (typeof(relay_ms) = 'integer' AND relay_ms BETWEEN 0 AND 9007199254740991),
  relay_bytes INTEGER NOT NULL DEFAULT 0 CHECK (typeof(relay_bytes) = 'integer' AND relay_bytes BETWEEN 0 AND 9007199254740991),
  media_bytes INTEGER NOT NULL DEFAULT 0 CHECK (typeof(media_bytes) = 'integer' AND media_bytes BETWEEN 0 AND 9007199254740991)
);

-- One latest inventory snapshot per UTC day. These are gauges, never summed
-- across days. Storage reservations are not provider-measured bytes on disk.
CREATE TABLE service_inventory_daily (
  day TEXT PRIMARY KEY CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  captured_at INTEGER NOT NULL CHECK (typeof(captured_at) = 'integer' AND captured_at BETWEEN 0 AND 253402300799999),
  total_accounts INTEGER NOT NULL CHECK (typeof(total_accounts) = 'integer' AND total_accounts BETWEEN 0 AND 9007199254740991),
  active_accounts INTEGER NOT NULL CHECK (typeof(active_accounts) = 'integer' AND active_accounts BETWEEN 0 AND 9007199254740991),
  total_pages INTEGER NOT NULL CHECK (typeof(total_pages) = 'integer' AND total_pages BETWEEN 0 AND 9007199254740991),
  active_pages INTEGER NOT NULL CHECK (typeof(active_pages) = 'integer' AND active_pages BETWEEN 0 AND 9007199254740991),
  resident_pages INTEGER NOT NULL CHECK (typeof(resident_pages) = 'integer' AND resident_pages BETWEEN 0 AND 9007199254740991),
  total_agents INTEGER NOT NULL CHECK (typeof(total_agents) = 'integer' AND total_agents BETWEEN 0 AND 9007199254740991),
  unrevoked_agents INTEGER NOT NULL CHECK (typeof(unrevoked_agents) = 'integer' AND unrevoked_agents BETWEEN 0 AND 9007199254740991),
  reserved_bytes INTEGER NOT NULL CHECK (typeof(reserved_bytes) = 'integer' AND reserved_bytes BETWEEN 0 AND 9007199254740991),
  capacity_bytes INTEGER NOT NULL CHECK (typeof(capacity_bytes) = 'integer' AND capacity_bytes BETWEEN 0 AND 9007199254740991)
);
