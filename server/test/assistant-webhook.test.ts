import { describe, expect, it } from 'vitest';
import { callbackUrl, deliveryDisposition, publicAddress, signedHeaders, verifyCallback, webhookKey } from '../src/assistant-webhook';

const secret = (start = 0, length = 32) => 'whsec_' + btoa(String.fromCharCode(...Array.from({ length }, (_, i) => start + i)));

describe('hosted webhook protocol after the sidecar removal', () => {
  it('signs exact UTF-8 bytes with independently calculated HMAC vectors and deduplicated rotation keys', async () => {
    // Expected signatures calculated independently with Python hmac/hashlib.
    const headers = await signedHeaders({ id: 'evt_123', subscriptionId: 'sub_123', now: 1700000000123,
      body: '{"type":"application_event","message":"hello 🌱"}', secrets: [secret(), secret(32), secret()] });
    expect(headers).toEqual({ 'Content-Type': 'application/json', 'webhook-id': 'evt_123',
      'webhook-timestamp': '1700000000', 'X-MCP-Subscription-Id': 'sub_123',
      'webhook-signature': 'v1,ek/sVAgAW2qdft3iX7oXmOsOTlQ7qGM1NDhXeZYw3jY= v1,/QXh9oyloBHoeYQRrEo2iY8RM7tMbYCaBny5gQlYvQM=' });
  });

  it('accepts only canonical signing keys within the protocol bounds', () => {
    expect(webhookKey(secret(0, 24))).toHaveLength(24);
    expect(webhookKey(secret(0, 64))).toHaveLength(64);
    for (const value of [secret(0, 23), secret(0, 65), secret().slice(0, -1), 'whsec_!!!!', secret() + '\n'])
      expect(() => webhookKey(value)).toThrow();
  });

  it.each(['http://example.com/hook', 'https://user:password@example.com/hook', 'https://example.com/hook#fragment',
    'https://127.0.0.1/hook', 'https://10.0.0.1/hook', 'https://[::1]/hook', 'https://[::ffff:127.0.0.1]/hook',
    'https://192.0.2.1/hook', 'https://[2001:db8::1]/hook'])('rejects an unsafe callback %s', url => {
    expect(() => callbackUrl(url)).toThrow();
  });

  it('accepts a public callback without dropping its path or query', () => {
    expect(callbackUrl('https://example.com/hook?channel=one')).toBe('https://example.com/hook?channel=one');
    expect(publicAddress('1.1.1.1')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
    expect(publicAddress('::ffff:10.0.0.1')).toBe(false);
  });

  it('requires a successful callback to echo its fresh signed challenge exactly', async () => {
    const challenges: string[] = [];
    for (let i = 0; i < 2; i++) await verifyCallback({ subscriptionId: 'sub_123', secret: secret(),
      url: 'https://example.com/hook', now: 1700000000123, async send(url, options) {
        expect(url).toBe('https://example.com/hook');
        expect(options.headers['X-MCP-Subscription-Id']).toBe('sub_123');
        expect(options.headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
        const { type, challenge } = JSON.parse(options.body);
        expect(type).toBe('verification'); expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        challenges.push(challenge); return { status: 200, body: JSON.stringify({ challenge }) };
      } });
    expect(challenges[0]).not.toBe(challenges[1]);
    for (const response of [{ status: 200, body: '{}' }, { status: 200, body: '{' },
      { status: 200, body: '{"challenge":"wrong"}' }, { status: 302, body: '{}' }])
      await expect(verifyCallback({ subscriptionId: 'sub_123', secret: secret(), url: 'https://example.com/hook',
        send: async () => response })).rejects.toMatchObject({ status: 400, code: 'CALLBACK_VERIFICATION_FAILED',
          extra: { rpcCode: -32015, reason: 'challenge_failed' } });
    await expect(verifyCallback({ subscriptionId: 'sub_123', secret: secret(), url: 'https://example.com/hook',
      send: async (_url, options) => ({ status: 302, body: options.body }) }))
      .rejects.toMatchObject({ code: 'CALLBACK_VERIFICATION_FAILED' });
  });

  it('retains timeout classification without exposing the callback error', async () => {
    await expect(verifyCallback({ subscriptionId: 'sub_123', secret: secret(), url: 'https://example.com/hook',
      send: async () => { throw new DOMException('private callback diagnostics', 'TimeoutError'); } }))
      .rejects.toMatchObject({ message: 'Callback verification failed', extra: { reason: 'timeout' } });
  });

  it.each([[204, 'accepted'], [410, 'gone'], [408, 'retry'], [425, 'retry'], [429, 'retry'],
    [500, 'retry'], [503, 'retry'], [301, 'failed'], [400, 'failed'], [401, 'failed']])(
    'classifies HTTP %i as %s', (status, outcome) => expect(deliveryDisposition(Number(status))).toBe(outcome));
});
