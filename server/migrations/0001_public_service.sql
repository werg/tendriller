PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  email TEXT,
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  suspended_at INTEGER
);
CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_account ON identities(account_id);
CREATE TABLE identity_emails (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  PRIMARY KEY (provider, subject, email),
  FOREIGN KEY (provider, subject) REFERENCES identities(provider, subject) ON DELETE CASCADE
);
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE TABLE oauth_states (
  hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  link_account TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE page_codes (
  hash TEXT PRIMARY KEY,
  tendril_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE claim_intents (
  hash TEXT PRIMARY KEY,
  tendril_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE api_keys (
  hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX api_keys_account ON api_keys(account_id);
CREATE TABLE tendrils (
  id TEXT PRIMARY KEY,
  owner_account TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  intended_owner TEXT,
  creator_ip TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  state TEXT NOT NULL DEFAULT 'active',
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0)
);
CREATE INDEX tendrils_owner ON tendrils(owner_account);
CREATE TABLE service_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('open', 'creation_paused', 'read_only')),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  storage_cap INTEGER NOT NULL DEFAULT 10737418240
);
INSERT INTO service_state (id, mode) VALUES (1, 'creation_paused');
-- A single UPDATE of tendrils.reserved atomically updates both shared ceilings.
-- An abort rolls back all three rows in the same D1 transaction.
CREATE TRIGGER tendril_reservation AFTER UPDATE OF reserved, owner_account ON tendrils
BEGIN
  UPDATE service_state SET reserved = reserved + NEW.reserved - OLD.reserved
    WHERE id = 1 AND reserved + NEW.reserved - OLD.reserved BETWEEN 0 AND storage_cap;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'service_full') END;
  UPDATE accounts SET reserved = reserved - OLD.reserved WHERE id = OLD.owner_account;
  UPDATE accounts SET reserved = reserved + NEW.reserved
    WHERE id = NEW.owner_account AND reserved + NEW.reserved <= 209715200;
  SELECT CASE WHEN NEW.owner_account IS NOT NULL AND changes() != 1 THEN RAISE(ABORT, 'account_full') END;
END;
CREATE TRIGGER tendril_reservation_delete AFTER DELETE ON tendrils
BEGIN
  UPDATE service_state SET reserved = reserved - OLD.reserved WHERE id = 1;
  UPDATE accounts SET reserved = reserved - OLD.reserved WHERE id = OLD.owner_account;
END;
CREATE TABLE creation_ip (
  ip TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (ip, day)
);
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  tendril_id TEXT NOT NULL,
  account_id TEXT,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reports_tendril_time ON reports(tendril_id, created_at);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE blocks (
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT,
  expires_at INTEGER,
  PRIMARY KEY (kind, value)
);
