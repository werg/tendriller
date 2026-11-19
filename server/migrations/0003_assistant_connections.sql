CREATE TABLE assistant_connections (
  page_id TEXT PRIMARY KEY REFERENCES tendrils(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  owner_account TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
);
CREATE INDEX assistant_connections_owner ON assistant_connections(owner_account, enabled, page_id);
CREATE UNIQUE INDEX assistant_connections_enabled_app
  ON assistant_connections(owner_account, application_id) WHERE enabled=1;
