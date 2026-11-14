CREATE TABLE suspension_queue (
  tendril_id TEXT PRIMARY KEY REFERENCES tendrils(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('disable', 'restore')),
  queued_at INTEGER NOT NULL
);

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
