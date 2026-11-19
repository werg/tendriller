import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
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

// Supplying this lookup directly to https.request validates the addresses at
// socket creation and dials those exact addresses, preserving TLS hostname/SNI.
export function publicLookup(resolve = lookup) {
  return (hostname, options, callback) => {
    Promise.resolve().then(() => resolve(hostname, { all: true, verbatim: true })).then(addresses => {
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !publicAddress(item.address)))
        fail('CALLBACK_ADDRESS_BLOCKED', 'Callback destination must have only public addresses');
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch(error => callback(error));
  };
}

export function createPublicWebhookTransport({ resolve, requestImpl = request, timeoutMs = 10000, maxResponseBytes = 8192 } = {}) {
  const checkedLookup = publicLookup(resolve);
  return async function send(url, { body, headers, signal, prepareWrite, beforeWrite } = {}) {
    const target = new URL(callbackUrl(url));
    if (typeof body !== 'string' || Buffer.byteLength(body) > 262144)
      fail('EVENT_TOO_LARGE', 'Webhook body must be a string of at most 256 KiB');
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    combined.throwIfAborted();
    return new Promise((resolveResult, reject) => {
      const req = requestImpl(target, { method: 'POST', agent: false,
        lookup: checkedLookup, rejectUnauthorized: true, signal: combined,
        headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, response => {
        response.on('error', reject);
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy(); req.destroy();
          reject(Object.assign(Error('Webhook redirects are not allowed'), { code: 'CALLBACK_REDIRECT' }));
          return;
        }
        let bytes = 0; const chunks = [];
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            response.destroy(); reject(Object.assign(Error('Webhook response exceeds limit'), { code: 'CALLBACK_RESPONSE_TOO_LARGE' }));
          } else chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => resolveResult({ status, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      // Wait for authenticated TLS before checking the native selection and
      // handing the event bytes to Node. DNS/connect must not queue an old event.
      if (!beforeWrite) req.end(body);
      else req.once('socket', socket => socket.once('secureConnect', async () => {
        try {
          combined.throwIfAborted();
          if (prepareWrite) await prepareWrite();
          combined.throwIfAborted();
          beforeWrite();
          req.end(body);
        } catch (error) { req.destroy(error); reject(error); }
      }));
    });
  };
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
