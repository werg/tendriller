-- Per-account plan caps, Polar.sh Merchant of Record subscriptions, idempotent billing events,
-- coalesced monthly usage periods, and active relay concurrency leases.
-- Compatible with unlimited NULL service_state caps for localhost / self-hosted deployments.

ALTER TABLE accounts ADD COLUMN plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team', 'unlimited'));
ALTER TABLE accounts ADD COLUMN page_cap INTEGER CHECK (page_cap IS NULL OR page_cap >= 0);
ALTER TABLE accounts ADD COLUMN resident_cap INTEGER CHECK (resident_cap IS NULL OR resident_cap >= 0);
ALTER TABLE accounts ADD COLUMN storage_cap INTEGER CHECK (storage_cap IS NULL OR storage_cap >= 0);
ALTER TABLE accounts ADD COLUMN agent_cap INTEGER CHECK (agent_cap IS NULL OR agent_cap >= 0);
ALTER TABLE accounts ADD COLUMN guest_cap INTEGER CHECK (guest_cap IS NULL OR guest_cap >= 0);
ALTER TABLE accounts ADD COLUMN version_retention_cap INTEGER CHECK (version_retention_cap IS NULL OR version_retention_cap >= 1);
ALTER TABLE accounts ADD COLUMN mcp_page_cap INTEGER CHECK (mcp_page_cap IS NULL OR mcp_page_cap >= 0);
ALTER TABLE accounts ADD COLUMN mcp_call_cap INTEGER CHECK (mcp_call_cap IS NULL OR mcp_call_cap >= 0);
ALTER TABLE accounts ADD COLUMN mcp_store_cap INTEGER CHECK (mcp_store_cap IS NULL OR mcp_store_cap >= 0);
ALTER TABLE accounts ADD COLUMN media_bytes_cap INTEGER CHECK (media_bytes_cap IS NULL OR media_bytes_cap >= 0);
ALTER TABLE accounts ADD COLUMN relay_ms_cap INTEGER CHECK (relay_ms_cap IS NULL OR relay_ms_cap >= 0);
ALTER TABLE accounts ADD COLUMN relay_concurrent_cap INTEGER CHECK (relay_concurrent_cap IS NULL OR relay_concurrent_cap >= 0);
ALTER TABLE accounts ADD COLUMN payg_enabled INTEGER NOT NULL DEFAULT 0 CHECK (payg_enabled IN (0, 1));
ALTER TABLE accounts ADD COLUMN payg_spend_cap_cents INTEGER DEFAULT 2500 CHECK (payg_spend_cap_cents IS NULL OR payg_spend_cap_cents >= 0);

CREATE TABLE IF NOT EXISTS subscriptions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'polar',
  customer_id TEXT,
  subscription_id TEXT UNIQUE,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('free', 'pro', 'team', 'unlimited')),
  billing_interval TEXT NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  status TEXT NOT NULL CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'revoked')),
  period_start INTEGER,
  period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  grace_until INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS subscriptions_customer ON subscriptions(customer_id);

CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  account_id TEXT,
  received_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_periods (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  mcp_calls INTEGER NOT NULL DEFAULT 0 CHECK (mcp_calls >= 0),
  relay_ms INTEGER NOT NULL DEFAULT 0 CHECK (relay_ms >= 0),
  relay_bytes INTEGER NOT NULL DEFAULT 0 CHECK (relay_bytes >= 0),
  media_bytes INTEGER NOT NULL DEFAULT 0 CHECK (media_bytes >= 0),
  reported_media_overage_mb INTEGER NOT NULL DEFAULT 0 CHECK (reported_media_overage_mb >= 0),
  reported_mcp_overage_calls INTEGER NOT NULL DEFAULT 0 CHECK (reported_mcp_overage_calls >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, period)
);

CREATE INDEX IF NOT EXISTS usage_periods_period ON usage_periods(period, updated_at);

CREATE TABLE IF NOT EXISTS active_relay_leases (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS active_relay_leases_account ON active_relay_leases(account_id, expires_at);

-- Update atomic storage & page/resident triggers to respect per-account caps while keeping
-- NULL service_state caps (localhost/self-hosted) unlimited and allowing non-destructive downgrades.
DROP TRIGGER IF EXISTS tendril_reservation;
CREATE TRIGGER tendril_reservation AFTER UPDATE OF reserved, owner_account ON tendrils
BEGIN
  UPDATE service_state SET reserved = reserved + NEW.reserved - OLD.reserved
    WHERE id = 1 AND reserved + NEW.reserved - OLD.reserved BETWEEN 0 AND storage_cap;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'service_full') END;
  UPDATE accounts SET reserved = MAX(0, reserved - OLD.reserved) WHERE id = OLD.owner_account;
  UPDATE accounts SET reserved = reserved + NEW.reserved
    WHERE id = NEW.owner_account
      AND (
        (SELECT account_storage_cap FROM service_state WHERE id = 1) IS NULL
        OR plan = 'unlimited'
        OR (NEW.owner_account = OLD.owner_account AND NEW.reserved <= OLD.reserved)
        OR reserved + NEW.reserved <= COALESCE(storage_cap, (SELECT account_storage_cap FROM service_state WHERE id = 1))
      );
  SELECT CASE WHEN NEW.owner_account IS NOT NULL AND changes() != 1 THEN RAISE(ABORT, 'account_full') END;
END;

DROP TRIGGER IF EXISTS account_tendril_cap_insert;
CREATE TRIGGER account_tendril_cap_insert BEFORE INSERT ON tendrils
WHEN NEW.owner_account IS NOT NULL AND NEW.state = 'active'
BEGIN
  SELECT CASE
    WHEN (SELECT account_page_cap FROM service_state WHERE id = 1) IS NOT NULL
      AND (SELECT plan FROM accounts WHERE id = NEW.owner_account) != 'unlimited'
      AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND state = 'active')
          >= COALESCE((SELECT page_cap FROM accounts WHERE id = NEW.owner_account),
                      (SELECT account_page_cap FROM service_state WHERE id = 1))
    THEN RAISE(ABORT, 'account_tendrils_full') END;
  SELECT CASE
    WHEN NEW.lifetime = 'resident'
      AND (SELECT account_resident_cap FROM service_state WHERE id = 1) IS NOT NULL
      AND (SELECT plan FROM accounts WHERE id = NEW.owner_account) != 'unlimited'
      AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND lifetime = 'resident' AND state = 'active')
          >= COALESCE((SELECT resident_cap FROM accounts WHERE id = NEW.owner_account),
                      (SELECT account_resident_cap FROM service_state WHERE id = 1))
    THEN RAISE(ABORT, 'account_residents_full') END;
END;

DROP TRIGGER IF EXISTS account_tendril_cap_update;
CREATE TRIGGER account_tendril_cap_update BEFORE UPDATE OF owner_account, lifetime, state ON tendrils
WHEN NEW.owner_account IS NOT NULL AND NEW.state = 'active'
BEGIN
  SELECT CASE
    WHEN (OLD.owner_account IS NOT NEW.owner_account OR OLD.state != 'active')
      AND (SELECT account_page_cap FROM service_state WHERE id = 1) IS NOT NULL
      AND (SELECT plan FROM accounts WHERE id = NEW.owner_account) != 'unlimited'
      AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND state = 'active' AND id != NEW.id)
          >= COALESCE((SELECT page_cap FROM accounts WHERE id = NEW.owner_account),
                      (SELECT account_page_cap FROM service_state WHERE id = 1))
    THEN RAISE(ABORT, 'account_tendrils_full') END;
  SELECT CASE
    WHEN NEW.lifetime = 'resident'
      AND (OLD.owner_account IS NOT NEW.owner_account OR OLD.lifetime != 'resident' OR OLD.state != 'active')
      AND (SELECT account_resident_cap FROM service_state WHERE id = 1) IS NOT NULL
      AND (SELECT plan FROM accounts WHERE id = NEW.owner_account) != 'unlimited'
      AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND lifetime = 'resident' AND state = 'active' AND id != NEW.id)
          >= COALESCE((SELECT resident_cap FROM accounts WHERE id = NEW.owner_account),
                      (SELECT account_resident_cap FROM service_state WHERE id = 1))
    THEN RAISE(ABORT, 'account_residents_full') END;
END;
