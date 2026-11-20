import type { Env } from '../env';
import { errorResponse, readBody } from '../http';
import { safeEqual, sha256Hex } from '../ids';
import { publicBase } from '../urls';
import { servicePage } from './ui';

export function testAccess(env: Env): { accountId: string; tokenSha256: string; expiresAt: number } | null {
  try {
    const value = JSON.parse(env.TEST_ACCESS_JSON ?? 'null');
    if (value && /^test_[a-f0-9]{32}$/.test(value.accountId) && /^[a-f0-9]{64}$/.test(value.tokenSha256) &&
        Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now()) return value;
  } catch { /* Missing, expired, or malformed configuration disables access. */ }
  return null;
}

export function testAccountEnabled(env: Env, accountId: string): boolean {
  return !accountId.startsWith('test_') || testAccess(env)?.accountId === accountId;
}

export async function routeTestAccess(req: Request, env: Env): Promise<Response> {
  const access = testAccess(env);
  if (!access) return errorResponse(404, 'not_found');
  if (req.method === 'GET') {
    const response = servicePage('Test account', `<h1>Open the test account</h1>
      <p>This account contains shared sample data. Changes you make are visible to other testers.</p>
      <form method="post" action="/auth/test"><label>Private access token
      <input name="token" type="password" required autocomplete="off"></label>
      <button type="submit">Open test account</button></form>`, `<script>
      const token = new URLSearchParams(location.hash.slice(1)).get('token');
      history.replaceState(null, '', location.pathname);
      if (token) document.querySelector('input[name="token"]').value = token;
      </script>`);
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }
  if (req.method !== 'POST') return errorResponse(405, 'method_not_allowed');
  if (req.headers.get('Origin') !== new URL(publicBase(env)).origin) return errorResponse(403, 'bad_origin');
  if (env.AUTH_RATE && !(await env.AUTH_RATE.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'unknown' })).success)
    return errorResponse(429, 'rate_limited');
  if (req.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded')
    return errorResponse(415, 'unsupported_media_type');
  const form = new URLSearchParams(new TextDecoder().decode(await readBody(req, 4096)));
  const token = form.get('token') ?? '';
  if ([...form.keys()].some(name => name !== 'token') || form.getAll('token').length !== 1 ||
      !/^[A-Za-z0-9_-]{43}$/.test(token) || !safeEqual(await sha256Hex(token), access.tokenSha256))
    return errorResponse(401, 'invalid_test_access', 'The test link is invalid or expired');
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  const now = Date.now(), expires = Math.min(access.expiresAt, now + 86_400_000);
  const result = await env.ACCOUNTS.prepare(`INSERT INTO sessions(hash,account_id,created_at,expires_at)
    SELECT ?,a.id,?,? FROM accounts a JOIN identities i ON i.account_id=a.id
    WHERE a.id=? AND i.provider='test' AND i.subject=a.id AND a.suspended_at IS NULL AND a.deleting_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM identities other WHERE other.account_id=a.id AND other.provider<>'test')`)
    .bind(await sha256Hex(raw), now, expires, access.accountId).run();
  if (result.meta.changes !== 1) return errorResponse(403, 'test_account_unavailable');
  return new Response(null, { status: 303, headers: { Location: '/dashboard', 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Set-Cookie': `__Host-tendriller=${raw}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expires - now) / 1000)}` } });
}
