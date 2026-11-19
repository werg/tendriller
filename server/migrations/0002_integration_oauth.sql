-- Optional first-party integration OAuth. Existing accounts remain authoritative.
-- Opaque credentials are stored only as SHA-256 hashes. Signing keys are secrets.
CREATE TABLE integration_oauth_intents (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('authorize', 'handoff', 'revoke')),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE integration_oauth_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE integration_oauth_codes (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES integration_oauth_grants(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE integration_oauth_refresh (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES integration_oauth_grants(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replacement_hash TEXT
);

CREATE TABLE integration_oauth_access (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES integration_oauth_grants(id) ON DELETE CASCADE,
  jti TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE integration_oauth_handoffs (
  hash TEXT PRIMARY KEY,
  bridge_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX integration_oauth_intents_account ON integration_oauth_intents(account_id, expires_at);
CREATE INDEX integration_oauth_grants_account ON integration_oauth_grants(account_id, expires_at);
CREATE INDEX integration_oauth_codes_grant ON integration_oauth_codes(grant_id);
CREATE INDEX integration_oauth_refresh_grant ON integration_oauth_refresh(grant_id);
CREATE INDEX integration_oauth_access_grant ON integration_oauth_access(grant_id);
CREATE INDEX integration_oauth_handoffs_account ON integration_oauth_handoffs(account_id, expires_at);
CREATE INDEX integration_oauth_intents_expiry ON integration_oauth_intents(expires_at);
CREATE INDEX integration_oauth_handoffs_expiry ON integration_oauth_handoffs(expires_at);
CREATE INDEX integration_oauth_access_expiry ON integration_oauth_access(expires_at);
CREATE INDEX integration_oauth_grants_expiry ON integration_oauth_grants(expires_at);
CREATE INDEX integration_oauth_grants_revoked ON integration_oauth_grants(revoked_at);
