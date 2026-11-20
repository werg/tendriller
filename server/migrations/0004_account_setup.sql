-- Required account-bound setup ledger. Apply explicitly; never synthesize it at runtime.
-- Operation IDs are not reusable: this bounded journal has no automatic pruning.
CREATE TABLE account_setup_schema (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO account_setup_schema(id,revision) VALUES(1,2);
-- Independent immutable allocation fences survive a missing/corrupt operation journal.
-- This is a second record of the original allocation, never permission to recreate it.
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
  PRIMARY KEY(service_origin,account_id,client_id,operation_id)
);
CREATE INDEX account_setup_allocations_account ON account_setup_allocations(account_id,created_at);
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
  state TEXT NOT NULL CHECK(state IN ('prepared','provisioning','ready','blocked','expired','reconciliation_required')),
  indexed INTEGER NOT NULL DEFAULT 0 CHECK(indexed IN (0,1)),
  initialization_started INTEGER NOT NULL DEFAULT 0 CHECK(initialization_started IN (0,1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  failure_code TEXT,
  PRIMARY KEY(service_origin,account_id,client_id,operation_id)
);
CREATE INDEX account_setups_account ON account_setups(account_id,created_at);
CREATE TRIGGER account_setup_capacity BEFORE INSERT ON account_setups
WHEN NOT EXISTS(SELECT 1 FROM account_setups WHERE service_origin=NEW.service_origin AND account_id=NEW.account_id AND client_id=NEW.client_id AND operation_id=NEW.operation_id)
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM account_setup_allocations WHERE service_origin=NEW.service_origin AND account_id=NEW.account_id
    AND client_id=NEW.client_id AND operation_id=NEW.operation_id) THEN RAISE(ABORT,'reconciliation_required') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM integration_oauth_grants g JOIN accounts a ON a.id=g.account_id
    WHERE g.id=NEW.grant_id AND g.account_id=NEW.account_id AND g.client_id=NEW.client_id
      AND g.resource=NEW.service_origin||'/mcp' AND g.revoked_at IS NULL AND g.expires_at>NEW.created_at
      AND instr(' '||g.scope||' ',' tendrils:create ')>0 AND a.suspended_at IS NULL AND a.deleting_at IS NULL)
    THEN RAISE(ABORT,'setup_binding_inactive') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM identities i JOIN identity_emails e ON e.provider=i.provider AND e.subject=i.subject
    WHERE i.account_id=NEW.account_id AND lower(e.email)=NEW.intended_email) THEN RAISE(ABORT,'owner_verification_required') END;
  SELECT CASE WHEN (SELECT mode FROM service_state WHERE id=1)<>'open' THEN RAISE(ABORT,'creation_paused') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM tendrils WHERE owner_account=NEW.account_id AND state='active') +
    (SELECT COUNT(*) FROM account_setup_allocations s WHERE s.account_id=NEW.account_id AND s.expires_at>NEW.created_at
      AND NOT EXISTS(SELECT 1 FROM tendrils t WHERE t.id=s.page_id AND t.owner_account=NEW.account_id AND t.state='active'))>=20
    THEN RAISE(ABORT,'setup_account_full') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM account_setup_allocations WHERE account_id=NEW.account_id)>=100
    OR (SELECT COUNT(*) FROM account_setup_allocations)>=10000 THEN RAISE(ABORT,'setup_ledger_full') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM account_setup_allocations a LEFT JOIN account_setups s ON s.page_id=a.page_id
    WHERE a.account_id=NEW.account_id AND COALESCE(s.state,'reconciliation_required')<>'ready' AND a.expires_at>NEW.created_at)>=20
    THEN RAISE(ABORT,'setup_pending_full') END;
  SELECT CASE WHEN (SELECT count FROM creation_ip WHERE ip=NEW.creator_ip AND day=NEW.creation_day)>=30
    THEN RAISE(ABORT,'setup_creation_rate_limited') END;
END;
CREATE TRIGGER account_setup_charge AFTER INSERT ON account_setups
BEGIN
  INSERT INTO account_setup_allocations(service_origin,account_id,client_id,operation_id,request_digest,credential_commitment,grant_id,intended_email,page_id,application_id,creator_ip,creation_day,created_at,expires_at)
    VALUES(NEW.service_origin,NEW.account_id,NEW.client_id,NEW.operation_id,NEW.request_digest,NEW.credential_commitment,NEW.grant_id,NEW.intended_email,NEW.page_id,NEW.application_id,NEW.creator_ip,NEW.creation_day,NEW.created_at,NEW.expires_at);
  INSERT INTO creation_ip(ip,day,count) VALUES(NEW.creator_ip,NEW.creation_day,1)
    ON CONFLICT(ip,day) DO UPDATE SET count=count+1;
END;
