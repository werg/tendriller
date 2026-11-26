-- Account-level maintenance agents (self-chosen @handle + bio) and their explicit per-page grants.
CREATE TABLE agents (
  id TEXT PRIMARY KEY CHECK (id GLOB 'ag_*'),
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  owner_email TEXT,
  handle TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  -- X25519 key-wrap public key (64 lowercase hex) that page members seal epoch keys to.
  wrap_key TEXT NOT NULL CHECK (length(wrap_key) = 64),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  revoked_at INTEGER,
  CHECK (account_id IS NOT NULL OR owner_email IS NOT NULL)
);

-- Handles are unique case-insensitively among an account's live agents; revoked handles may be reused.
CREATE UNIQUE INDEX agents_account_handle ON agents(account_id, lower(handle)) WHERE account_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX agents_owner_email ON agents(owner_email) WHERE account_id IS NULL;

CREATE TABLE agent_grants (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES tendrils(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  granted_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL CHECK (granted_by IN ('creator', 'owner')),
  PRIMARY KEY (agent_id, page_id)
);
CREATE INDEX agent_grants_page ON agent_grants(page_id);

CREATE TABLE agent_join_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX agent_join_codes_account ON agent_join_codes(account_id, expires_at);
