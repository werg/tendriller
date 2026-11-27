-- Complimentary access is a separate ledger. Billing webhooks continue to own
-- accounts.plan and its materialized caps. Grants never create subscriptions.
CREATE TABLE premium_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('pro', 'team')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR (expires_at > created_at AND expires_at <= 253402300799999)),
  created_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  revoked_at INTEGER,
  revoked_by TEXT,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 500),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX premium_grants_account_active ON premium_grants(account_id, revoked_at, expires_at);
CREATE INDEX premium_grants_account_history ON premium_grants(account_id, created_at DESC, id DESC);
CREATE INDEX audit_log_premium_page ON audit_log(created_at DESC, id DESC) WHERE action IN ('premium:grant', 'premium:revoke');

-- The audit and grant mutation are one SQLite transaction, including under
-- concurrent retries. Revocation is permanent; changing a grant requires a new ID.
CREATE TRIGGER premium_grant_created AFTER INSERT ON premium_grants
BEGIN
  INSERT INTO audit_log(id, actor, action, subject, reason, created_at)
    VALUES ('premium:grant:' || NEW.id, NEW.created_by, 'premium:grant', NEW.account_id,
      json_object('grantId', NEW.id, 'plan', NEW.plan_id, 'expiresAt', NEW.expires_at, 'reason', NEW.reason), NEW.created_at);
END;
CREATE TRIGGER premium_grant_immutable BEFORE UPDATE ON premium_grants
WHEN OLD.id IS NOT NEW.id OR OLD.account_id IS NOT NEW.account_id
  OR OLD.plan_id IS NOT NEW.plan_id OR OLD.created_at IS NOT NEW.created_at
  OR OLD.expires_at IS NOT NEW.expires_at OR OLD.created_by IS NOT NEW.created_by
  OR OLD.reason IS NOT NEW.reason OR OLD.revoked_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'premium_grant_immutable');
END;
CREATE TRIGGER premium_grant_revoked AFTER UPDATE OF revoked_at ON premium_grants
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO audit_log(id, actor, action, subject, reason, created_at)
    VALUES ('premium:revoke:' || NEW.id, NEW.revoked_by, 'premium:revoke', NEW.account_id,
      json_object('grantId', NEW.id, 'reason', NEW.revoke_reason), NEW.revoked_at);
END;

-- Retain exempt units after expiration/revocation so a later paid subscription
-- cannot retroactively turn testing usage into PAYG charges.
ALTER TABLE usage_periods ADD COLUMN complimentary_mcp_calls INTEGER NOT NULL DEFAULT 0 CHECK (complimentary_mcp_calls >= 0);
ALTER TABLE usage_periods ADD COLUMN complimentary_media_bytes INTEGER NOT NULL DEFAULT 0 CHECK (complimentary_media_bytes >= 0);

-- The three SQL-enforced quotas must see the same grants as application checks.
-- No materialization or cron is necessary for expiry. The constants mirror the
-- Pro/Team plan definitions; premium-grants.public.test.ts guards their parity.
CREATE VIEW effective_account_limits AS
SELECT a.id AS account_id,
  CASE WHEN s.account_page_cap IS NULL OR a.plan = 'unlimited' THEN NULL ELSE
    MAX(COALESCE(a.page_cap, s.account_page_cap), COALESCE((
      SELECT MAX(CASE g.plan_id WHEN 'team' THEN 1000 ELSE 100 END)
      FROM premium_grants g WHERE g.account_id = a.id AND g.revoked_at IS NULL
        AND g.created_at <= unixepoch('subsec') * 1000 AND (g.expires_at IS NULL OR g.expires_at > unixepoch('subsec') * 1000)
        AND a.suspended_at IS NULL AND a.deleting_at IS NULL
    ), 0)) END AS page_cap,
  CASE WHEN s.account_resident_cap IS NULL OR a.plan = 'unlimited' THEN NULL ELSE
    MAX(COALESCE(a.resident_cap, s.account_resident_cap), COALESCE((
      SELECT MAX(CASE g.plan_id WHEN 'team' THEN 1000 ELSE 100 END)
      FROM premium_grants g WHERE g.account_id = a.id AND g.revoked_at IS NULL
        AND g.created_at <= unixepoch('subsec') * 1000 AND (g.expires_at IS NULL OR g.expires_at > unixepoch('subsec') * 1000)
        AND a.suspended_at IS NULL AND a.deleting_at IS NULL
    ), 0)) END AS resident_cap,
  CASE WHEN s.account_storage_cap IS NULL OR a.plan = 'unlimited' THEN NULL ELSE
    MAX(COALESCE(a.storage_cap, s.account_storage_cap), COALESCE((
      SELECT MAX(CASE g.plan_id WHEN 'team' THEN 107374182400 ELSE 21474836480 END)
      FROM premium_grants g WHERE g.account_id = a.id AND g.revoked_at IS NULL
        AND g.created_at <= unixepoch('subsec') * 1000 AND (g.expires_at IS NULL OR g.expires_at > unixepoch('subsec') * 1000)
        AND a.suspended_at IS NULL AND a.deleting_at IS NULL
    ), 0)) END AS storage_cap
FROM accounts a CROSS JOIN service_state s WHERE s.id = 1;

DROP TRIGGER tendril_reservation;
CREATE TRIGGER tendril_reservation AFTER UPDATE OF reserved, owner_account ON tendrils
BEGIN
  UPDATE service_state SET reserved = reserved + NEW.reserved - OLD.reserved
    WHERE id = 1 AND reserved + NEW.reserved - OLD.reserved BETWEEN 0 AND storage_cap;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'service_full') END;
  UPDATE accounts SET reserved = MAX(0, reserved - OLD.reserved) WHERE id = OLD.owner_account;
  UPDATE accounts SET reserved = reserved + NEW.reserved
    WHERE id = NEW.owner_account AND (
      (SELECT storage_cap FROM effective_account_limits WHERE account_id = NEW.owner_account) IS NULL
      OR (NEW.owner_account = OLD.owner_account AND NEW.reserved <= OLD.reserved)
      OR reserved + NEW.reserved <= (SELECT storage_cap FROM effective_account_limits WHERE account_id = NEW.owner_account));
  SELECT CASE WHEN NEW.owner_account IS NOT NULL AND changes() != 1 THEN RAISE(ABORT, 'account_full') END;
END;

DROP TRIGGER account_tendril_cap_insert;
CREATE TRIGGER account_tendril_cap_insert BEFORE INSERT ON tendrils
WHEN NEW.owner_account IS NOT NULL AND NEW.state = 'active'
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND state = 'active')
    >= (SELECT page_cap FROM effective_account_limits WHERE account_id = NEW.owner_account)
    THEN RAISE(ABORT, 'account_tendrils_full') END;
  SELECT CASE WHEN NEW.lifetime = 'resident'
    AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND lifetime = 'resident' AND state = 'active')
      >= (SELECT resident_cap FROM effective_account_limits WHERE account_id = NEW.owner_account)
    THEN RAISE(ABORT, 'account_residents_full') END;
END;

DROP TRIGGER account_tendril_cap_update;
CREATE TRIGGER account_tendril_cap_update BEFORE UPDATE OF owner_account, lifetime, state ON tendrils
WHEN NEW.owner_account IS NOT NULL AND NEW.state = 'active'
BEGIN
  SELECT CASE WHEN (OLD.owner_account IS NOT NEW.owner_account OR OLD.state != 'active')
    AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND state = 'active' AND id != NEW.id)
      >= (SELECT page_cap FROM effective_account_limits WHERE account_id = NEW.owner_account)
    THEN RAISE(ABORT, 'account_tendrils_full') END;
  SELECT CASE WHEN NEW.lifetime = 'resident'
    AND (OLD.owner_account IS NOT NEW.owner_account OR OLD.lifetime != 'resident' OR OLD.state != 'active')
    AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND lifetime = 'resident' AND state = 'active' AND id != NEW.id)
      >= (SELECT resident_cap FROM effective_account_limits WHERE account_id = NEW.owner_account)
    THEN RAISE(ABORT, 'account_residents_full') END;
END;
