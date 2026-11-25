// Worker environment shared by the service routes and per-tendril objects.
export interface Env {
  TENDRIL: DurableObjectNamespace;
  ADMISSION: DurableObjectNamespace;
  AGENT_HUB: DurableObjectNamespace;
  ACCOUNTS: D1Database;
  CREATE_RATE?: RateLimit;
  AGENT_RATE?: RateLimit;
  PAGE_RATE: RateLimit;
  ACCOUNT_RATE: RateLimit;
  AUTH_RATE?: RateLimit;
  FAILED_AUTH_RATE?: RateLimit;
  REPORT_RATE?: RateLimit;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  PUBLIC_BASE: string;
  /** Optional public deployment label; discovery otherwise displays its own host. */
  SERVICE_ENVIRONMENT?: string;
  /** Optional public source checkpoint for this deployed Worker (40 lowercase hex). */
  SERVICE_SOURCE_COMMIT?: string;
  /** Public complete release composition identity (64 lowercase SHA-256 hex). */
  SERVICE_COMPOSITION_ID?: string;
  PAGE_BASE_DOMAIN: string;
  /** Optional preview suffix in the page's DNS label, e.g. --p-0123456789ab. */
  PAGE_HOST_SUFFIX?: string;
  BRANCH_PREVIEW_SHA?: string;
  BRANCH_PREVIEW_BRANCH?: string;
  PUBLIC_CREATIONS_PER_HOUR?: string;
  PUBLIC_UNCLAIMED_CAP?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Private test-account access configuration, provisioned by the operator. */
  TEST_ACCESS_JSON?: string;
  /** Optional first-party integration OAuth. Register exact clients and resource. */
  OAUTH_CONFIG_JSON?: string;
  /** Private RS256/ES256 JWK, installed as a Worker secret. Never published. */
  OAUTH_SIGNING_JWK?: string;
  /** Optional previous public signing keys retained while issued tokens expire. */
  OAUTH_PUBLIC_JWKS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  ADMIN_IDENTITIES?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BUDGET_WEBHOOK_SECRET?: string;
  BUDGET_PAUSE_POLICY_ID?: string;
  BUDGET_READ_ONLY_POLICY_ID?: string;
  /** Optional Web Push VAPID configuration (uncompressed P-256 base64url public key, JWK or raw base64url private key, mailto:/https: subject). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}
