-- System-wide Ed25519-signed broadcasts, signing keys, and agent/page fleet version inventory.
CREATE TABLE system_broadcasts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (id GLOB 'bc_*'),
  kind TEXT NOT NULL CHECK (kind IN ('upgrade', 'security', 'maintenance', 'deprecation', 'announcement')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'recommended', 'urgent', 'critical')),
  audiences TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  docs_url TEXT,
  action_json TEXT,
  match_json TEXT,
  dismissible INTEGER NOT NULL DEFAULT 1,
  issuer TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature_alg TEXT NOT NULL,
  signature_kid TEXT NOT NULL,
  signature_b64 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  superseded_by TEXT
);

CREATE INDEX system_broadcasts_active ON system_broadcasts(revoked_at, expires_at, seq DESC);

CREATE TABLE broadcast_keys (
  kid TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  private_jwk TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

CREATE TABLE agent_versions (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  core_version TEXT,
  tools_version TEXT,
  chronolog_version TEXT,
  authority_version TEXT,
  node_version TEXT,
  kit_id TEXT,
  packages_json TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX agent_versions_updated ON agent_versions(updated_at DESC);

CREATE TABLE page_versions (
  page_id TEXT PRIMARY KEY REFERENCES tendrils(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  runtime_id TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  published_at INTEGER NOT NULL
);

CREATE INDEX page_versions_runtime ON page_versions(runtime_version, runtime_id);
