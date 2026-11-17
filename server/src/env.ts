// Worker environment shared by the service routes and per-tendril objects.
export interface Env {
  TENDRIL: DurableObjectNamespace;
  ADMISSION: DurableObjectNamespace;
  ACCOUNTS: D1Database;
  CREATE_RATE?: RateLimit;
  AGENT_RATE?: RateLimit;
  PAGE_RATE?: RateLimit;
  ACCOUNT_RATE?: RateLimit;
  AUTH_RATE?: RateLimit;
  FAILED_AUTH_RATE?: RateLimit;
  REPORT_RATE?: RateLimit;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  PUBLIC_BASE: string;
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
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  ADMIN_IDENTITIES?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BUDGET_WEBHOOK_SECRET?: string;
  BUDGET_PAUSE_POLICY_ID?: string;
  BUDGET_READ_ONLY_POLICY_ID?: string;
}
