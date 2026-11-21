import ipaddr from 'ipaddr.js';
import { HttpError } from './http';

const encoder = new TextEncoder();

const DENIED = [
  '0.0.0.0/8', '100.64.0.0/10', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '240.0.0.0/4',
  '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20',
].map(value => ipaddr.parseCIDR(value));

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    throw new HttpError(400, 'invalid_arguments', `${label} must be bounded text`);
  return value;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function publicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    if (parsed.range() !== 'unicast') return false;
    if (DENIED.some(([network, bits]) => parsed.kind() === network.kind() && parsed.match(network, bits))) return false;
    return parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3);
  } catch { return false; }
}

export function callbackUrl(value: unknown): string {
  const raw = requireText(value, 'callback URL', 4096);
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'CALLBACK_URL_INVALID', 'Callback URL must be HTTPS'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash)
    throw new HttpError(400, 'CALLBACK_URL_INVALID', 'Callback URL must be HTTPS without credentials or a fragment');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !publicAddress(host))
    throw new HttpError(400, 'CALLBACK_ADDRESS_BLOCKED', 'Callback destination must be public');
  return url.href;
}

export function webhookKey(secret: unknown): Uint8Array {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new HttpError(400, 'WEBHOOK_SECRET_INVALID', 'Expected whsec_ followed by a base64 signing key');
  const encoded = secret.slice(6);
  let raw: string;
  try { raw = atob(encoded); } catch { throw new HttpError(400, 'WEBHOOK_SECRET_INVALID', 'Webhook signing key must be valid base64'); }
  const key = Uint8Array.from(raw, ch => ch.charCodeAt(0));
  if (key.length < 24 || key.length > 64 || toBase64(key) !== encoded)
    throw new HttpError(400, 'WEBHOOK_SECRET_INVALID', 'Webhook signing key must decode to 24–64 bytes of canonical base64');
  return key;
}

async function signHmac(keyBytes: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return `v1,${toBase64(new Uint8Array(signature))}`;
}

export async function signedHeaders(input: { id: string; subscriptionId: string; body: string; secrets: string[]; now?: number }): Promise<Record<string, string>> {
  const { id, subscriptionId, body, secrets, now = Date.now() } = input;
  requireText(id, 'event ID', 256);
  requireText(subscriptionId, 'subscription ID', 256);
  const timestamp = String(Math.floor(now / 1000));
  const payload = `${id}.${timestamp}.${body}`;
  const signatures = await Promise.all([...new Set(secrets)].map(secret => signHmac(webhookKey(secret), payload)));
  return {
    'Content-Type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': signatures.join(' '),
    'X-MCP-Subscription-Id': subscriptionId,
  };
}

export async function verifyCallback(input: {
  subscriptionId: string; url: string; secret: string;
  send: (url: string, init: { body: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; body: string }>;
  now?: number; signal?: AbortSignal;
}): Promise<void> {
  const { subscriptionId, url, secret, send, now = Date.now(), signal } = input;
  webhookKey(secret);
  callbackUrl(url);
  const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const id = `verify_${toHex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const body = JSON.stringify({ type: 'verification', challenge });
  try {
    const headers = await signedHeaders({ id, subscriptionId, body, secrets: [secret], now });
    const response = await send(url, { body, headers, signal });
    const echoed = JSON.parse(response.body).challenge;
    const expectedBytes = encoder.encode(challenge);
    const actualBytes = typeof echoed === 'string' ? encoder.encode(echoed) : new Uint8Array(0);
    if (response.status < 200 || response.status >= 300 || !constantTimeEqual(actualBytes, expectedBytes))
      throw Error('Invalid challenge response');
  } catch (error: any) {
    const reason = ['TimeoutError', 'AbortError'].includes(error?.name) || error?.code === 'ABORT_ERR' ? 'timeout' : 'challenge_failed';
    throw new HttpError(400, 'CALLBACK_VERIFICATION_FAILED', 'Callback verification failed', { rpcCode: -32015, reason });
  }
}

export function deliveryDisposition(status: number): 'accepted' | 'gone' | 'retry' | 'failed' {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 410) return 'gone';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry';
  return 'failed';
}
