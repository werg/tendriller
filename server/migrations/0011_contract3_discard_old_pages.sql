-- Pre-release Contract 3 cutover: discard page registrations in the old namespace.
-- Accounts, identities, sessions and audit records remain available.
UPDATE service_state
SET reserved = COALESCE((SELECT SUM(reserved) FROM tendrils), 0)
WHERE id = 1;

UPDATE accounts
SET reserved = COALESCE((
  SELECT SUM(t.reserved) FROM tendrils AS t WHERE t.owner_account = accounts.id
), 0);

DELETE FROM page_codes;
DELETE FROM claim_intents;
DELETE FROM suspension_queue;
DELETE FROM tendrils;
DELETE FROM creation_ip;

UPDATE service_state SET reserved = 0, mode = 'creation_paused' WHERE id = 1;
UPDATE accounts SET reserved = 0;

-- The deploy workflow consumes this marker after the new Worker passes its
-- smoke check. Later intentional pauses must not be reopened by a deploy.
CREATE TABLE contract3_cutover_pending (id INTEGER PRIMARY KEY CHECK (id = 1));
INSERT INTO contract3_cutover_pending (id) VALUES (1);
