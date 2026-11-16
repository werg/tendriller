-- Fresh account/service schema. Initialize empty storage; there is no old-state converter.
PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  email TEXT,
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  suspended_at INTEGER
, deleting_at INTEGER);

CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

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

CREATE TABLE tendrils (
  id TEXT PRIMARY KEY,
  owner_account TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  intended_owner TEXT,
  creator_ip TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  state TEXT NOT NULL DEFAULT 'active',
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0)
, lifetime TEXT NOT NULL DEFAULT 'ad_hoc' CHECK (lifetime IN ('ad_hoc', 'resident')));

CREATE TABLE service_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('open', 'creation_paused', 'read_only')),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  storage_cap INTEGER NOT NULL DEFAULT 10737418240
);

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
, disqualified INTEGER NOT NULL DEFAULT 0);

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

CREATE TABLE appeals (
  id TEXT PRIMARY KEY,
  tendril_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);

CREATE TABLE suspension_queue (
  tendril_id TEXT PRIMARY KEY REFERENCES tendrils(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('disable', 'restore')),
  queued_at INTEGER NOT NULL
);

CREATE TABLE account_notices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  tendril_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE account_appeals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);

CREATE INDEX identities_account ON identities(account_id);

CREATE INDEX sessions_account ON sessions(account_id);

CREATE INDEX tendrils_owner ON tendrils(owner_account);

CREATE INDEX reports_tendril_time ON reports(tendril_id, created_at);

CREATE INDEX appeals_open ON appeals(resolved_at, created_at);

CREATE INDEX account_notices_owner ON account_notices(account_id, created_at DESC);

CREATE INDEX account_appeals_open ON account_appeals(resolved_at, created_at);

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

CREATE TRIGGER account_tendril_cap_insert BEFORE INSERT ON tendrils
WHEN NEW.owner_account IS NOT NULL AND NEW.state = 'active'
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND state = 'active') >= 20
    THEN RAISE(ABORT, 'account_tendrils_full') END;
  SELECT CASE WHEN NEW.lifetime = 'resident' AND
    (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND lifetime = 'resident' AND state = 'active') >= 3
    THEN RAISE(ABORT, 'account_residents_full') END;
END;

CREATE TRIGGER account_tendril_cap_update BEFORE UPDATE OF owner_account, lifetime, state ON tendrils
WHEN NEW.owner_account IS NOT NULL AND NEW.state = 'active'
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND state = 'active' AND id != NEW.id) >= 20
    THEN RAISE(ABORT, 'account_tendrils_full') END;
  SELECT CASE WHEN NEW.lifetime = 'resident' AND
    (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND lifetime = 'resident' AND state = 'active' AND id != NEW.id) >= 3
    THEN RAISE(ABORT, 'account_residents_full') END;
END;

CREATE TRIGGER queue_suspended_account_pages
AFTER UPDATE OF suspended_at ON accounts
WHEN OLD.suspended_at IS NULL AND NEW.suspended_at IS NOT NULL
BEGIN
  INSERT INTO suspension_queue (tendril_id, action, queued_at)
  SELECT id, 'disable', NEW.suspended_at FROM tendrils WHERE owner_account = NEW.id
  ON CONFLICT(tendril_id) DO UPDATE SET action = 'disable', queued_at = excluded.queued_at;
END;

CREATE TRIGGER queue_restored_account_pages
AFTER UPDATE OF suspended_at ON accounts
WHEN OLD.suspended_at IS NOT NULL AND NEW.suspended_at IS NULL
BEGIN
  INSERT INTO suspension_queue (tendril_id, action, queued_at)
  SELECT id, 'restore', CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM tendrils WHERE owner_account = NEW.id AND state = 'active'
  ON CONFLICT(tendril_id) DO UPDATE SET action = 'restore', queued_at = excluded.queued_at;
END;

INSERT INTO service_state (id, mode) VALUES (1, 'creation_paused');
