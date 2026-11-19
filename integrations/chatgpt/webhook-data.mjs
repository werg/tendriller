import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { fail, text } from './common.mjs';

const DENIED = ['0.0.0.0/8', '100.64.0.0/10', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '240.0.0.0/4',
  '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].map(value => ipaddr.parseCIDR(value));

export function publicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    if (parsed.range() !== 'unicast') return false;
    if (DENIED.some(([network, bits]) => parsed.kind() === network.kind() && parsed.match(network, bits))) return false;
    return parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3);
  } catch { return false; }
}

export function callbackUrl(value) {
  text(value, 'callback URL', 4096);
  let url;
  try { url = new URL(value); } catch { fail('CALLBACK_URL_INVALID', 'Callback URL must be HTTPS'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash)
    fail('CALLBACK_URL_INVALID', 'Callback URL must be HTTPS without credentials or a fragment');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) fail('CALLBACK_ADDRESS_BLOCKED', 'Callback destination must be public');
  return url.href;
}

export function webhookKey(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    fail('WEBHOOK_SECRET_INVALID', 'Expected whsec_ followed by a base64 signing key');
  const encoded = secret.slice(6), key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded)
    fail('WEBHOOK_SECRET_INVALID', 'Webhook signing key must decode to 24–64 bytes of canonical base64');
  return key;
}

export function signedHeaders({ id, subscriptionId, body, secrets, now = Date.now() }) {
  text(id, 'event ID', 256); text(subscriptionId, 'subscription ID', 256);
  const timestamp = String(Math.floor(now / 1000));
  return {
    'Content-Type': 'application/json', 'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': [...new Set(secrets)].map(secret => `v1,${createHmac('sha256', webhookKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`).join(' '),
    'X-MCP-Subscription-Id': subscriptionId,
  };
}

export async function verifyCallback({ subscriptionId, url, secret, send, now = Date.now(), signal }) {
  webhookKey(secret); callbackUrl(url);
  const challenge = randomBytes(32).toString('base64url'), id = `verify_${randomBytes(16).toString('hex')}`;
  const body = JSON.stringify({ type: 'verification', challenge });
  try {
    const response = await send(url, { body, headers: signedHeaders({ id, subscriptionId, body, secrets: [secret], now }), signal });
    const echoed = JSON.parse(response.body).challenge;
    const expectedBytes = Buffer.from(challenge), actualBytes = typeof echoed === 'string' ? Buffer.from(echoed) : Buffer.alloc(0);
    if (response.status < 200 || response.status >= 300 || actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes))
      throw Error('Invalid challenge response');
  } catch (error) {
    fail('CALLBACK_VERIFICATION_FAILED', 'Callback verification failed', { rpcCode: -32015,
      data: { reason: ['TimeoutError', 'AbortError'].includes(error.name) || error.code === 'ABORT_ERR' ? 'timeout' : 'challenge_failed' } });
  }
}

export function deliveryDisposition(status) {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 410) return 'gone';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry';
  return 'failed';
}
