CREATE TABLE appeal_tokens (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tendril_id TEXT NOT NULL REFERENCES tendrils(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX appeal_tokens_expiry ON appeal_tokens (expires_at);
