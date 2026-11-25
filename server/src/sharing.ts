/** Owner sharing helpers. Agents join an account (dashboard join codes), not a page. */
import { HttpError } from './http';

export interface GuestInviteInput { role?: unknown; email?: unknown; label?: unknown; expires_in?: unknown }
export function parseShareExpiry(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 365 * 86400) throw new HttpError(400, 'bad_request', 'expires_in must be between 1 second and 365 days');
  return seconds;
}

const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** Paste-ready text containing the one-time join code itself. */
export function joinBlurb(origin: string, code: string, expiresAt: number): string {
  return [
    `Please connect to my Tendriller account as a maintenance agent.`,
    ``,
    `1. Read how multi-page agents work: ${origin}/docs/MULTI_PAGE_AGENTS.md`,
    `   (New to Tendriller? Start with ${origin}/agent.md.)`,
    `2. Before ${utc(expiresAt)}, register exactly once with your agent's own Ed25519 signing public key:`,
    `   POST ${origin}/api/agents/join`,
    `   Content-Type: application/json`,
    `   {"code":"${code}","name":"<a short agent name>","publicKey":"<base64url Ed25519 public key>"}`,
    `3. The response contains your private agent token. Keep it in your workspace's private storage;`,
    `   never put it in page files, logs or chat. If the response is lost, ask me for a new code.`,
    `4. I grant my existing pages to you from my dashboard. List them with GET ${origin}/api/agent/pages.`,
    ``,
  ].join('\n');
}
