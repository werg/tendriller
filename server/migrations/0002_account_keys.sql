ALTER TABLE tendrils ADD COLUMN lifetime TEXT NOT NULL DEFAULT 'ad_hoc' CHECK (lifetime IN ('ad_hoc', 'resident'));

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
