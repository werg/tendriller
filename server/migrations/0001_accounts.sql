-- Unified fresh account/service schema. Initialize empty storage; no legacy migrations.
PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  email TEXT,
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  suspended_at INTEGER,
  deleting_at INTEGER
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
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  lifetime TEXT NOT NULL DEFAULT 'ad_hoc' CHECK (lifetime IN ('ad_hoc', 'resident'))
);

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
  created_at INTEGER NOT NULL,
  disqualified INTEGER NOT NULL DEFAULT 0
);

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

-- First-party integration OAuth for the hosted /mcp endpoint.
CREATE TABLE integration_oauth_intents (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('authorize', 'revoke')),
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

CREATE TABLE assistant_connections (
  page_id TEXT PRIMARY KEY REFERENCES tendrils(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  owner_account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
);

-- Account-bound page setup journal and independent allocation fence.
CREATE TABLE account_setup_schema (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
INSERT INTO account_setup_schema (id, revision) VALUES (1, 3);

CREATE TABLE account_setup_allocations (
  service_origin TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  credential_commitment TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  intended_email TEXT NOT NULL,
  page_id TEXT NOT NULL UNIQUE,
  application_id TEXT NOT NULL,
  creator_ip TEXT NOT NULL,
  creation_day TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (service_origin, account_id, client_id, operation_id)
);

CREATE TABLE account_setups (
  service_origin TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  credential_commitment TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  intended_email TEXT NOT NULL,
  page_id TEXT NOT NULL UNIQUE,
  application_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  creator_ip TEXT NOT NULL,
  creation_day TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'provisioning', 'ready', 'blocked', 'expired', 'reconciliation_required')),
  indexed INTEGER NOT NULL DEFAULT 0 CHECK (indexed IN (0, 1)),
  initialization_started INTEGER NOT NULL DEFAULT 0 CHECK (initialization_started IN (0, 1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  failure_code TEXT,
  PRIMARY KEY (service_origin, account_id, client_id, operation_id)
);

CREATE INDEX identities_account ON identities(account_id);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX tendrils_owner ON tendrils(owner_account);
CREATE INDEX reports_tendril_time ON reports(tendril_id, created_at);
CREATE INDEX appeals_open ON appeals(resolved_at, created_at);
CREATE INDEX account_notices_owner ON account_notices(account_id, created_at DESC);
CREATE INDEX account_appeals_open ON account_appeals(resolved_at, created_at);
CREATE INDEX integration_oauth_intents_account ON integration_oauth_intents(account_id, expires_at);
CREATE INDEX integration_oauth_intents_expiry ON integration_oauth_intents(expires_at);
CREATE INDEX integration_oauth_grants_account ON integration_oauth_grants(account_id, expires_at);
CREATE INDEX integration_oauth_grants_expiry ON integration_oauth_grants(expires_at);
CREATE INDEX integration_oauth_grants_revoked ON integration_oauth_grants(revoked_at);
CREATE INDEX integration_oauth_codes_grant ON integration_oauth_codes(grant_id);
CREATE INDEX integration_oauth_refresh_grant ON integration_oauth_refresh(grant_id);
CREATE INDEX integration_oauth_access_grant ON integration_oauth_access(grant_id);
CREATE INDEX integration_oauth_access_expiry ON integration_oauth_access(expires_at);
CREATE INDEX assistant_connections_owner ON assistant_connections(owner_account, enabled, page_id);
CREATE UNIQUE INDEX assistant_connections_enabled_app ON assistant_connections(owner_account, application_id) WHERE enabled = 1;
CREATE INDEX account_setup_allocations_account ON account_setup_allocations(account_id, created_at);
CREATE INDEX account_setups_account ON account_setups(account_id, created_at);

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

CREATE TRIGGER account_setup_capacity BEFORE INSERT ON account_setups
WHEN NOT EXISTS(SELECT 1 FROM account_setups WHERE service_origin = NEW.service_origin AND account_id = NEW.account_id AND client_id = NEW.client_id AND operation_id = NEW.operation_id)
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM account_setup_allocations WHERE service_origin = NEW.service_origin AND account_id = NEW.account_id AND client_id = NEW.client_id AND operation_id = NEW.operation_id)
    THEN RAISE(ABORT, 'setup_journal_missing') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM account_setup_allocations WHERE page_id = NEW.page_id)
    OR EXISTS(SELECT 1 FROM tendrils WHERE id = NEW.page_id) THEN RAISE(ABORT, 'setup_allocation_conflict') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM integration_oauth_grants g JOIN accounts a ON a.id = g.account_id
    WHERE g.id = NEW.grant_id AND g.account_id = NEW.account_id AND g.client_id = NEW.client_id
      AND g.resource = NEW.service_origin || '/mcp' AND g.revoked_at IS NULL AND g.expires_at > NEW.created_at
      AND instr(' ' || g.scope || ' ', ' tendrils:create ') > 0 AND a.suspended_at IS NULL AND a.deleting_at IS NULL)
    THEN RAISE(ABORT, 'setup_binding_inactive') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM identities i JOIN identity_emails e ON e.provider = i.provider AND e.subject = i.subject
    WHERE i.account_id = NEW.account_id AND lower(e.email) = NEW.intended_email) THEN RAISE(ABORT, 'owner_verification_required') END;
  SELECT CASE WHEN COALESCE((SELECT mode FROM service_state WHERE id = 1), 'unavailable') <> 'open' THEN RAISE(ABORT, 'creation_paused') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.account_id AND state = 'active') +
    (SELECT COUNT(*) FROM account_setup_allocations s WHERE s.account_id = NEW.account_id AND s.expires_at > NEW.created_at
      AND NOT EXISTS(SELECT 1 FROM tendrils t WHERE t.id = s.page_id AND t.owner_account = NEW.account_id AND t.state = 'active')) >= 20
    THEN RAISE(ABORT, 'setup_account_full') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM account_setup_allocations WHERE account_id = NEW.account_id) >= 100
    OR (SELECT COUNT(*) FROM account_setup_allocations) >= 10000 THEN RAISE(ABORT, 'setup_ledger_full') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM account_setup_allocations a LEFT JOIN account_setups s ON s.page_id = a.page_id
    WHERE a.account_id = NEW.account_id AND COALESCE(s.state, 'reconciliation_required') <> 'ready' AND a.expires_at > NEW.created_at) >= 20
    THEN RAISE(ABORT, 'setup_pending_full') END;
  SELECT CASE WHEN (SELECT count FROM creation_ip WHERE ip = NEW.creator_ip AND day = NEW.creation_day) >= 30
    THEN RAISE(ABORT, 'setup_creation_rate_limited') END;
END;

CREATE TRIGGER account_setup_charge AFTER INSERT ON account_setups
BEGIN
  INSERT INTO account_setup_allocations VALUES(NEW.service_origin, NEW.account_id, NEW.client_id, NEW.operation_id, NEW.request_digest,
    NEW.credential_commitment, NEW.grant_id, NEW.intended_email, NEW.page_id, NEW.application_id, NEW.creator_ip, NEW.creation_day, NEW.created_at, NEW.expires_at);
  INSERT INTO creation_ip (ip, day, count) VALUES (NEW.creator_ip, NEW.creation_day, 1)
    ON CONFLICT(ip, day) DO UPDATE SET count = count + 1;
END;

INSERT INTO service_state (id, mode) VALUES (1, 'creation_paused');
