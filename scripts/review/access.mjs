import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function readReviewAccess(path) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  const origin = new URL(record.origin);
  if (origin.origin !== record.origin || origin.protocol !== 'https:' || !/^test_[a-f0-9]{32}$/.test(record.accountId))
    throw Error('Use a dedicated test-account record on an exact HTTPS origin');
  const saved = new URL(record.url);
  const code = new URLSearchParams(saved.hash.slice(1)).get('token');
  if (saved.username || saved.password || saved.search || saved.origin !== origin.origin || saved.pathname !== '/auth/test' || !/^[A-Za-z0-9_-]{43}$/.test(code ?? '') ||
      createHash('sha256').update(code).digest('hex') !== record.tokenSha256)
    throw Error('Private test-account credentials are inconsistent');
  return { ...record, loginUrl: origin.origin + '/auth/test', code };
}

/** Static password form and real PKCE consent; authorization codes never leave this test's callback interceptor. */
export async function authorizeReview(context, access) {
  const page = await context.newPage(), origin = access.origin;
  await page.goto(access.loginUrl);
  await page.locator('input[name="token"]').fill(access.code);
  await page.getByRole('button', { name: 'Open test account' }).click();
  await page.waitForURL(origin + '/dashboard');
  const discovery = await context.request.get(origin + '/.well-known/oauth-protected-resource/mcp');
  if (!discovery.ok()) throw Error('Protected resource discovery failed');
  const metadata = await discovery.json(), resource = origin + '/mcp';
  if (metadata.resource !== resource || !Array.isArray(metadata.scopes_supported)) throw Error('Unexpected OAuth resource');
  const clientId = 'https://chatgpt.com/oauth/client.json', callbackUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const verifier = randomBytes(32).toString('base64url'), state = randomUUID();
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: callbackUri, resource, state,
    response_type: 'code', scope: metadata.scopes_supported.join(' '), code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  let redirect;
  await page.route(url => url.origin === origin && url.pathname === '/oauth/authorize', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch({ maxRedirects: 0 });
    redirect = response.headers().location;
    await route.fulfill({ response, headers: { ...response.headers(), location: callbackUri } });
  });
  await page.route(url => url.origin + url.pathname === callbackUri, route => route.fulfill({ contentType: 'text/plain', body: 'OAuth consent completed. Preparing the live MCP walkthrough.' }));
  await page.goto(origin + '/oauth/authorize?' + params);
  await page.getByRole('button', { name: 'Allow these permissions' }).click();
  await page.waitForURL(callbackUri);
  const callback = new URL(redirect);
  if (callback.origin + callback.pathname !== callbackUri || callback.searchParams.get('state') !== state || callback.searchParams.get('iss') !== origin)
    throw Error('OAuth callback binding did not verify');
  const response = await context.request.post(origin + '/oauth/token', { form: { grant_type: 'authorization_code', client_id: clientId,
    resource, redirect_uri: callbackUri, code: callback.searchParams.get('code'), code_verifier: verifier } });
  if (!response.ok()) throw Error('PKCE token exchange failed');
  const result = await response.json();
  return { token: result.access_token, page };
}
