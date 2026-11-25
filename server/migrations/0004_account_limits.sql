-- Configurable per-account caps in service_state (NULL = unlimited; defaults match production quotas).
ALTER TABLE service_state ADD COLUMN account_page_cap INTEGER DEFAULT 20 CHECK (account_page_cap IS NULL OR account_page_cap >= 0);
ALTER TABLE service_state ADD COLUMN account_resident_cap INTEGER DEFAULT 5 CHECK (account_resident_cap IS NULL OR account_resident_cap >= 0);
ALTER TABLE service_state ADD COLUMN account_storage_cap INTEGER DEFAULT 209715200 CHECK (account_storage_cap IS NULL OR account_storage_cap >= 0);

DROP TRIGGER IF EXISTS tendril_reservation;
CREATE TRIGGER tendril_reservation AFTER UPDATE OF reserved, owner_account ON tendrils
BEGIN
  UPDATE service_state SET reserved = reserved + NEW.reserved - OLD.reserved
    WHERE id = 1 AND reserved + NEW.reserved - OLD.reserved BETWEEN 0 AND storage_cap;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'service_full') END;
  UPDATE accounts SET reserved = reserved - OLD.reserved WHERE id = OLD.owner_account;
  UPDATE accounts SET reserved = reserved + NEW.reserved
    WHERE id = NEW.owner_account
      AND ((SELECT account_storage_cap FROM service_state WHERE id = 1) IS NULL
           OR reserved + NEW.reserved <= (SELECT account_storage_cap FROM service_state WHERE id = 1));
  SELECT CASE WHEN NEW.owner_account IS NOT NULL AND changes() != 1 THEN RAISE(ABORT, 'account_full') END;
END;

DROP TRIGGER IF EXISTS account_tendril_cap_insert;
CREATE TRIGGER account_tendril_cap_insert BEFORE INSERT ON tendrils
WHEN NEW.owner_account IS NOT NULL AND NEW.state = 'active'
BEGIN
  SELECT CASE WHEN (SELECT account_page_cap FROM service_state WHERE id = 1) IS NOT NULL
    AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND state = 'active')
        >= (SELECT account_page_cap FROM service_state WHERE id = 1)
    THEN RAISE(ABORT, 'account_tendrils_full') END;
  SELECT CASE WHEN NEW.lifetime = 'resident'
    AND (SELECT account_resident_cap FROM service_state WHERE id = 1) IS NOT NULL
    AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND lifetime = 'resident' AND state = 'active')
        >= (SELECT account_resident_cap FROM service_state WHERE id = 1)
    THEN RAISE(ABORT, 'account_residents_full') END;
END;

DROP TRIGGER IF EXISTS account_tendril_cap_update;
CREATE TRIGGER account_tendril_cap_update BEFORE UPDATE OF owner_account, lifetime, state ON tendrils
WHEN NEW.owner_account IS NOT NULL AND NEW.state = 'active'
BEGIN
  SELECT CASE WHEN (SELECT account_page_cap FROM service_state WHERE id = 1) IS NOT NULL
    AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND state = 'active' AND id != NEW.id)
        >= (SELECT account_page_cap FROM service_state WHERE id = 1)
    THEN RAISE(ABORT, 'account_tendrils_full') END;
  SELECT CASE WHEN NEW.lifetime = 'resident'
    AND (SELECT account_resident_cap FROM service_state WHERE id = 1) IS NOT NULL
    AND (SELECT COUNT(*) FROM tendrils WHERE owner_account = NEW.owner_account AND lifetime = 'resident' AND state = 'active' AND id != NEW.id)
        >= (SELECT account_resident_cap FROM service_state WHERE id = 1)
    THEN RAISE(ABORT, 'account_residents_full') END;
END;
