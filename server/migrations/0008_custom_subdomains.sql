-- Per-page named subdomains (`<name>.<PAGE_BASE_DOMAIN>`) for paid plans (Pro, Team, Self-Hosted)
-- and per-account named subdomain quota cap (`subdomain_cap`).

CREATE TABLE IF NOT EXISTS page_subdomains (
  subdomain TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tendril_id TEXT NOT NULL UNIQUE REFERENCES tendrils(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS page_subdomains_account ON page_subdomains(account_id, created_at DESC);

ALTER TABLE accounts ADD COLUMN subdomain_cap INTEGER;

UPDATE accounts SET subdomain_cap = 0 WHERE plan = 'free' AND subdomain_cap IS NULL;
UPDATE accounts SET subdomain_cap = 25 WHERE plan = 'pro' AND subdomain_cap IS NULL;
UPDATE accounts SET subdomain_cap = 100 WHERE plan = 'team' AND subdomain_cap IS NULL;
