ALTER TABLE reports ADD COLUMN disqualified INTEGER NOT NULL DEFAULT 0;
CREATE TABLE appeals (
  id TEXT PRIMARY KEY,
  tendril_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);
CREATE INDEX appeals_open ON appeals(resolved_at, created_at);
