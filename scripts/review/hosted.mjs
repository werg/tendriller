/** The OAuth grant ID an access token was issued under. The token itself is never logged or stored. */
export function reviewGrantId(token) {
  let claims;
  try { claims = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8')); } catch {}
  if (typeof claims?.sid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sid)) throw Error('REVIEW_GRANT_ID_UNAVAILABLE');
  return claims.sid;
}

/** The owner's hosted MCP connections as the signed page's own runtime reads them. */
export const readHostedGrants = page => page.evaluate(async () => {
  const response = await fetch(window.tendril.identity.base + '_tendril/mcp/grants', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw Object.assign(Error('REVIEW_HOSTED_GRANTS_READ_FAILED'), { status: response.status });
  const value = await response.json();
  return { configured: value.configured === true, grants: value.grants.map(grant => grant.id), connections: value.connections.map(row => ({ grant: row.grant_id, handle: row.handle })) };
});

/**
 * The owner explicitly opts this page into hosted MCP for exactly this run's OAuth grant from Page options → An agent.
 * The page's connector enrolls a fresh hosted key, grants it membership and wraps the current epoch keys to the grant;
 * nothing connects without this click, and other grants on the same account are left untouched.
 */
export async function connectHostedReview({ page, grantId, handle, step = () => {}, timeoutMs = 60000 }) {
  step('open-agent-options');
  await page.getByRole('button', { name: 'Page options' }).click();
  await page.getByRole('tab', { name: 'An agent' }).click();
  const box = page.locator('.agent-mcp-box');
  await box.waitFor({ timeout: timeoutMs });
  const listed = await readHostedGrants(page);
  if (!listed.configured) throw Error('REVIEW_HOSTED_MCP_UNCONFIGURED');
  const index = listed.grants.indexOf(grantId);
  if (index < 0) throw Error('REVIEW_HOSTED_GRANT_NOT_LISTED');
  // The runtime renders one card per active grant in the same order as the grants read above.
  const card = box.locator('li.agent-card').nth(index);
  step('connect-hosted-mcp');
  if (!listed.connections.some(row => row.grant === grantId)) {
    await card.getByRole('textbox').fill(handle);
    await card.getByRole('button', { name: 'Connect to this page', exact: true }).click();
  }
  step('wait-hosted-connection');
  await card.getByText('Connected as @' + handle, { exact: true }).waitFor({ timeout: timeoutMs });
  await page.keyboard.press('Escape');
}
