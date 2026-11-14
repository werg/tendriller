CREATE TABLE device_codes (
  hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX device_codes_expiry ON device_codes(expires_at);
