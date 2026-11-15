-- Pre-release contract 2 cutover: old page registrations are intentionally discarded.
-- Preserve accounts, sign-in sessions, legal/audit records and moderation history.
-- The Worker binds a new SQLite Durable Object namespace for contract 2 pages.
-- Existing R2 objects are left untouched; old page file graphs are no longer exposed.
--
-- Recompute reservations before deleting pages, so their DELETE trigger can
-- release each allocation even when stored account counters were inconsistent.
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
