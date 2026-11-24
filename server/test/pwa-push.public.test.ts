import { describe, expect, it } from 'vitest';
import { api, apiJson, create, req } from './helpers';
import { b64UrlDecode, b64UrlEncode, encryptWebPushPayload, signVapidJwt, validatePushPayload, validatePushSubscriptionInput } from '../src/push';

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

/** Independent RFC 8291 (aes128gcm) decryptor to verify server encryption byte-for-byte. */
async function decryptAes128Gcm(
  encrypted: Uint8Array,
  uaPrivateKey: CryptoKey,
  uaPublicBytes: Uint8Array,
  authSecret: Uint8Array,
): Promise<Uint8Array> {
  const salt = encrypted.slice(0, 16);
  const rs = new DataView(encrypted.buffer, encrypted.byteOffset + 16, 4).getUint32(0, false);
  expect(rs).toBe(4096);
  const keyLen = encrypted[20]!;
  expect(keyLen).toBe(65);
  const asPublicBytes = encrypted.slice(21, 21 + keyLen);
  const ciphertext = encrypted.slice(21 + keyLen);

  const asPublicKey = await crypto.subtle.importKey('raw', asPublicBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, uaPrivateKey, 256));
  const enc = new TextEncoder();
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const ikm = await hmacSha256(prkKey, concat(enc.encode('WebPush: info\0'), uaPublicBytes, asPublicBytes, new Uint8Array([0x01])));
  const prk = await hmacSha256(salt, ikm);
  const cek = (await hmacSha256(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([0x01])))).slice(0, 16);
  const nonce = (await hmacSha256(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([0x01])))).slice(0, 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, ciphertext));
  expect(padded[padded.length - 1]).toBe(0x02);
  return padded.slice(0, padded.length - 1);
}

describe('PWA shortcuts, maskable icons, share target, and Web Push', () => {
  it('serves full-bleed maskable icons and emits validated shortcuts and share_target in manifest', async () => {
    const handle = await create({ name: 'Field Notes' });
    const base = new URL(handle.page_url).pathname;

    // Maskable icon default monogram
    const maskRes = await req(handle.page_url + '_tendril/icon-maskable.svg');
    expect(maskRes.status).toBe(200);
    expect(maskRes.headers.get('Content-Type')).toBe('image/svg+xml');
    const maskSvg = await maskRes.text();
    expect(maskSvg).toContain('<rect width="512" height="512" fill=');
    expect(maskSvg).toContain('>F</text>');

    // Configure shortcuts via PATCH
    const patched = await apiJson(handle, 'PATCH', '', {
      icon: '🧭',
      shortcuts: [
        { name: 'Voice capture', short_name: 'Voice', url: '#voice' },
        { name: 'New note', description: 'Open blank note', url: '?new=1' },
      ],
    });
    expect(patched.meta.shortcuts).toHaveLength(2);
    const emojiMask = await (await req(handle.page_url + '_tendril/icon-maskable.svg')).text();
    expect(emojiMask).toContain('>🧭</text>');

    const manifest = await (await req(handle.page_url + '_tendril/manifest.webmanifest')).json() as {
      shortcuts?: Array<{ name: string; url: string }>;
      share_target?: { action: string; method: string };
    };
    expect(manifest.shortcuts).toEqual([
      { name: 'Voice capture', short_name: 'Voice', url: `${base}#voice` },
      { name: 'New note', description: 'Open blank note', url: `${base}?new=1` },
    ]);
    expect(manifest.share_target?.action).toBe(`${base}_tendril/share-target`);
    expect(manifest.share_target?.method).toBe('POST');

    // Reject unsafe cross-origin or traversal shortcut URLs and >4 shortcuts
    for (const bad of [
      [{ name: 'Evil', url: 'https://evil.test/' }],
      [{ name: 'JS', url: 'javascript:alert(1)' }],
      [{ name: 'Up', url: '../other' }],
      [{ name: '1', url: '#1' }, { name: '2', url: '#2' }, { name: '3', url: '#3' }, { name: '4', url: '#4' }, { name: '5', url: '#5' }],
    ]) {
      const res = await api(handle, 'PATCH', '', { shortcuts: bad });
      expect(res.status).toBe(400);
    }

    // Opt out of share_target cleanly
    await apiJson(handle, 'PATCH', '', { share_target: false });
    const manifestNoShare = await (await req(handle.page_url + '_tendril/manifest.webmanifest')).json() as { share_target?: unknown };
    expect(manifestNoShare.share_target).toBeUndefined();

    // Side-effect-free POST _tendril/share-target fallback redirects to page base
    const fallback = await req(handle.page_url + '_tendril/share-target', {
      method: 'POST',
      body: 'ignored',
      redirect: 'manual',
    });
    expect(fallback.status).toBe(303);
    expect(fallback.headers.get('Location')).toBe(base);
  });

  it('encrypts RFC 8291 aes128gcm push payloads and signs verifiable ES256 VAPID JWTs', async () => {
    const vapidPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const vapidPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', vapidPair.publicKey) as ArrayBuffer);
    const vapidPrivJwk = JSON.stringify(await crypto.subtle.exportKey('jwk', vapidPair.privateKey));
    const vapidPubB64 = b64UrlEncode(vapidPubRaw);

    const jwt = await signVapidJwt('https://push.example', 'mailto:ops@tendriller.dev', vapidPubB64, vapidPrivJwk, 1_700_000_000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(b64UrlDecode(h!)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(b64UrlDecode(p!)))).toEqual({
      aud: 'https://push.example',
      exp: 1_700_000_000 + 12 * 3600,
      sub: 'mailto:ops@tendriller.dev',
    });
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      vapidPair.publicKey,
      b64UrlDecode(s!),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(verified).toBe(true);

    // Round-trip RFC 8291 encryption/decryption
    const uaPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const uaPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', uaPair.publicKey) as ArrayBuffer);
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const message = new TextEncoder().encode(JSON.stringify({ title: 'Build done', body: 'All 12 tests passed', badge: 1 }));
    const encrypted = await encryptWebPushPayload(message, b64UrlEncode(uaPubRaw), b64UrlEncode(authSecret));
    const decrypted = await decryptAes128Gcm(encrypted, uaPair.privateKey, uaPubRaw, authSecret);
    expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(message));
  });

  it('validates push subscription & payload bounds and gates host push routes honestly', async () => {
    const validPub = b64UrlEncode(new Uint8Array([0x04, ...new Array(64).fill(7)]));
    const validAuth = b64UrlEncode(new Uint8Array(16).fill(9));

    expect(() => validatePushSubscriptionInput({
      endpoint: 'http://insecure.example/push',
      keys: { p256dh: validPub, auth: validAuth },
    })).toThrow();
    expect(() => validatePushSubscriptionInput({
      endpoint: 'https://127.0.0.1/push',
      keys: { p256dh: validPub, auth: validAuth },
    })).toThrow();
    expect(() => validatePushPayload({ title: 'Alert', path: 'https://evil.test/phish' })).toThrow();
    expect(validatePushPayload({ title: 'Ready', body: 'Done', path: '#chat', badge: 2 })).toEqual({
      title: 'Ready', body: 'Done', path: '#chat', badge: 2,
    });

    const handle = await create({ name: 'Push Page' });
    const keyRes = await req(handle.page_url + '_tendril/push/key');
    expect(keyRes.status).toBe(200);
    expect(await keyRes.json()).toEqual({ configured: false, publicKey: null });

    // Sending push without VAPID returns 503 push_not_configured
    const pushRes = await api(handle, 'POST', 'push', { title: 'Hello' });
    expect(pushRes.status).toBe(503);
    expect(await pushRes.json()).toMatchObject({ error: { code: 'push_not_configured' } });

    // Delegated token without notifications:send scope gets 403
    const delegated = await apiJson(handle, 'POST', 'tokens', { name: 'readonly', scopes: ['host:read'] });
    const denied = await api({ ...handle, token: delegated.token }, 'POST', 'push', { title: 'Hello' });
    expect(denied.status).toBe(403);
  });
});
