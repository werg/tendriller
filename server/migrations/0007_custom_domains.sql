-- Per-page custom domains (Cloudflare for SaaS custom hostnames + self-hosted TXT verification)
-- and generous unified page/resident + R2 storage caps.

CREATE TABLE IF NOT EXISTS custom_domains (
  hostname TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tendril_id TEXT NOT NULL UNIQUE REFERENCES tendrils(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'error')),
  cf_hostname_id TEXT,
  verification_txt_name TEXT,
  verification_txt_value TEXT,
  ssl_status TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS custom_domains_account ON custom_domains(account_id, created_at DESC);

-- Unify resident cap with page cap and raise default Free storage to 1 GB (preserve NULL for unlimited hosts).
UPDATE service_state
  SET account_resident_cap = CASE WHEN account_resident_cap IS NULL THEN NULL WHEN account_page_cap IS NOT NULL AND account_resident_cap < account_page_cap THEN account_page_cap ELSE account_resident_cap END,
      account_storage_cap = CASE WHEN account_storage_cap IS NULL THEN NULL WHEN account_storage_cap < 1073741824 THEN 1073741824 ELSE account_storage_cap END
  WHERE id = 1;

UPDATE accounts SET resident_cap = 20, storage_cap = 1073741824 WHERE plan = 'free' AND resident_cap = 5;
UPDATE accounts SET resident_cap = 100, storage_cap = 21474836480 WHERE plan = 'pro' AND resident_cap = 25;
UPDATE accounts SET page_cap = 1000, resident_cap = 1000, storage_cap = 107374182400 WHERE plan = 'team' AND page_cap = 500;
