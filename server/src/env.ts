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
  /** Loopback-only passwordless local dev sign-in ("1"). Ignored on non-loopback origins. */
  LOCAL_DEV_AUTH?: string;
  /** Optional self-hosted passphrase hash (`pbkdf2_sha256$iterations$salt$derived`). */
  LOCAL_PASSWORD_HASH?: string;
  /** Email identity for `LOCAL_PASSWORD_HASH` (and default email for `LOCAL_DEV_AUTH`). */
  LOCAL_OWNER_EMAIL?: string;
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
  /** Host attestation signing identity JSON `{publicKey, privateKey}` (hex), a Worker secret. Pages pin its public key in their signed admission policy. */
  HOST_ATTESTATION_KEY?: string;
  /** Optional Ed25519 OKP private JWK for signing system broadcasts (falls back to D1 broadcast_keys). */
  BROADCAST_SIGNING_JWK?: string;
  /** Optional rotated public Ed25519 OKP JWKs JSON array retained for verifying earlier broadcasts. */
  BROADCAST_PUBLIC_JWKS?: string;
  /** Optional operator bearer token for CI/CLI access to /api/admin/broadcasts. */
  BROADCAST_ADMIN_TOKEN?: string;
  /** Optional JSON map of outbound OAuth provider credentials: `{ github: { client_id, client_secret }, linear: ... }`. */
  OUTBOUND_OAUTH_CLIENTS_JSON?: string;
  /** Optional secret key material for envelope-encrypting BYO OAuth client secrets & HMAC webhook secrets at rest in D1 (falls back to HOST_ATTESTATION_KEY). */
  OAUTH_CONFIG_KEY?: string;
  /** Optional HMAC-SHA256 secret for verifying GitHub org/team membership webhooks (`/api/webhooks/github-org`). */
  GITHUB_ORG_WEBHOOK_SECRET?: string;
  /** Optional Polar.sh Merchant of Record configuration for hosted billing. */
  POLAR_ACCESS_TOKEN?: string;
  /** Standard Webhooks signing secret from Polar (`whsec_...` or raw secret). */
  POLAR_WEBHOOK_SECRET?: string;
  /** Optional Polar API environment: "production" (default) or "sandbox". */
  POLAR_SERVER?: string;
  /** Optional Polar API base URL override for testing/proxies. */
  POLAR_API_BASE?: string;
  /** JSON map of Polar product IDs: `{ pro_month, pro_year, team_month, team_year }`. */
  POLAR_PRODUCTS_JSON?: string;
  /** JSON map of Polar meter names/IDs: `{ media_egress_gb, mcp_overage_calls }`. */
  POLAR_METERS_JSON?: string;
  /** Explicitly enable billing UI/routes even without live Polar tokens (e.g. preview/tests). */
  BILLING_ENABLED?: string;
  /** Optional Cloudflare Realtime SFU credentials. */
  CF_REALTIME_APP_ID?: string;
  CF_REALTIME_API_TOKEN?: string;
  /** Optional Cloudflare Realtime TURN credentials. */
  CF_TURN_KEY_ID?: string;
  CF_TURN_API_TOKEN?: string;
  /** Optional Cloudflare Realtime API base URL override (defaults to https://rtc.live.cloudflare.com/v1). */
  CF_REALTIME_API_BASE?: string;
}
