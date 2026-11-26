-- Outbound third-party OAuth connections (Tier A zero-trust agent-held & Tier B wrapped host-brokered)
-- and GitHub/Google org/team/domain verified identity groups (Issue #136).
-- Zero plaintext third-party OAuth tokens are ever stored in D1.

CREATE TABLE IF NOT EXISTS oauth_custom_providers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  authorize_url TEXT NOT NULL,
  token_url TEXT NOT NULL,
  revoke_url TEXT,
  client_id TEXT NOT NULL,
  client_secret TEXT,
  default_scopes TEXT NOT NULL DEFAULT '[]',
  allowed_hosts TEXT NOT NULL DEFAULT '[]',
  pkce INTEGER NOT NULL DEFAULT 1 CHECK (pkce IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (account_id, slug)
);

CREATE INDEX IF NOT EXISTS oauth_custom_providers_account ON oauth_custom_providers(account_id);

CREATE TABLE IF NOT EXISTS outbound_oauth_states (
  hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('agent-held', 'host-brokered')),
  custody TEXT NOT NULL DEFAULT 'personal' CHECK (custody IN ('personal', 'page')),
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  agent_wrap_key TEXT,
  page_id TEXT REFERENCES tendrils(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/connections',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS outbound_oauth_states_expires ON outbound_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS outbound_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  tier TEXT NOT NULL CHECK (tier IN ('agent-held', 'host-brokered')),
  custody TEXT NOT NULL DEFAULT 'personal' CHECK (custody IN ('personal', 'page')),
  page_id TEXT REFERENCES tendrils(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  -- Tier B: AES-256-GCM ciphertext wrapped under client-held K_conn (never plaintext). NULL for Tier A.
  wrapped_tokens TEXT,
  -- Tier A: ephemeral X25519 sealed envelope for agent wrapKey; wiped immediately on agent ack. NULL for Tier B.
  sealed_handoff TEXT,
  external_subject TEXT,
  external_label TEXT,
  webhook_secret_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS outbound_connections_account ON outbound_connections(account_id, revoked_at);
CREATE INDEX IF NOT EXISTS outbound_connections_agent ON outbound_connections(agent_id, revoked_at);
CREATE INDEX IF NOT EXISTS outbound_connections_page ON outbound_connections(page_id, revoked_at);

CREATE TABLE IF NOT EXISTS outbound_page_grants (
  connection_id TEXT NOT NULL REFERENCES outbound_connections(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES tendrils(id) ON DELETE CASCADE,
  custody TEXT NOT NULL DEFAULT 'personal' CHECK (custody IN ('personal', 'page')),
  actions TEXT NOT NULL DEFAULT '[]',
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, page_id)
);

CREATE INDEX IF NOT EXISTS outbound_page_grants_page ON outbound_page_grants(page_id);

-- Verified group/org assertions from GitHub (orgs/teams via incremental read:org) and Google Workspace (hd claim).
CREATE TABLE IF NOT EXISTS identity_groups (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject, group_id),
  FOREIGN KEY (provider, subject) REFERENCES identities(provider, subject) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS identity_groups_account ON identity_groups(account_id, group_id);
CREATE INDEX IF NOT EXISTS identity_groups_group ON identity_groups(group_id, expires_at);

-- Fast index of admin-signed page group rules for org webhook fan-out and departure detection.
CREATE TABLE IF NOT EXISTS page_group_rules (
  page_id TEXT NOT NULL REFERENCES tendrils(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reader', 'writer', 'admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, rule_id)
);

CREATE INDEX IF NOT EXISTS page_group_rules_group ON page_group_rules(group_id);
