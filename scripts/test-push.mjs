#!/usr/bin/env node
// Tests server/src/push.ts under Node WebCrypto:
//   1. RFC 8291 Appendix A test vector (fixed salt and keys) -> exact bytes.
//   2. Round trip: encrypt for a fresh subscription key, decrypt as the user agent.
//   3. VAPID JWT: claims, header, ES256 signature verifies with the public key.
//   4. sendWebPush: request shape against a mocked fetch; 410 -> gone.
// Usage: node scripts/test-push.mjs
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "tendril-push-"));
const out = join(dir, "push.mjs");
await build({ entryPoints: [join(root, "server/src/push.ts")], outfile: out, bundle: true, format: "esm", platform: "neutral", logLevel: "warning" });
const push = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const { subtle } = globalThis.crypto;
const d = (s) => new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "base64url"));
const e = (b) => Buffer.from(b).toString("base64url");
let passed = 0;
const ok = (name) => { passed++; console.log("ok -", name); };

// ---- 1. RFC 8291 Appendix A ----
{
  const plaintext = d("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
  const asPublic = d("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const asPrivate = d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
  const uaPublic = d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const salt = d("DGv6ra1nlYgDCS1FRnbzlw");
  const auth = d("BTBZMqHH6r4Tts7J_aSIgg");
  const expectedHeader = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const expectedCipher = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";
  const body = await push.encryptPayload(plaintext, uaPublic, auth, { salt, asPrivate, asPublic });
  assert.equal(e(body.slice(0, 86)), expectedHeader, "header");
  assert.equal(e(body.slice(86)), expectedCipher, "ciphertext");
  assert.equal(e(body), e(Buffer.concat([d(expectedHeader), d(expectedCipher)])));
  ok("RFC 8291 Appendix A test vector matches byte for byte");
}

// ---- 2. Round trip with a random key pair, decrypting as the user agent ----
async function decrypt(body, uaPair, uaPublic, auth) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  assert.equal(rs, 4096);
  const hmac = async (k, m) => new Uint8Array(await subtle.sign("HMAC", await subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), m));
  const asKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, uaPair.privateKey, 256));
  const te = new TextEncoder();
  const ikm = await hmac(await hmac(auth, ecdh), Buffer.concat([te.encode("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, Buffer.concat([te.encode("Content-Encoding: aes128gcm\0"), Buffer.from([1])]))).slice(0, 16);
  const nonce = (await hmac(prk, Buffer.concat([te.encode("Content-Encoding: nonce\0"), Buffer.from([1])]))).slice(0, 12);
  const pt = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  assert.equal(pt[pt.length - 1], 2, "last-record delimiter");
  return new TextDecoder().decode(pt.slice(0, -1));
}
const uaPair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPublic = new Uint8Array(await subtle.exportKey("raw", uaPair.publicKey));
const auth = crypto.getRandomValues(new Uint8Array(16));
{
  const msg = JSON.stringify({ title: "Hi ✓", body: "x".repeat(500), url: "/p/abc/", tag: "t", tendril: "abc" });
  const body = await push.encryptPayload(new TextEncoder().encode(msg), uaPublic, auth);
  assert.equal(await decrypt(body, uaPair, uaPublic, auth), msg);
  ok("random-key round trip decrypts");
}

// ---- 3. VAPID JWT ----
const vapidPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const VAPID_PUBLIC_KEY = e(new Uint8Array(await subtle.exportKey("raw", vapidPair.publicKey)));
const VAPID_PRIVATE_KEY = (await subtle.exportKey("jwk", vapidPair.privateKey)).d;
const env = { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY };
{
  const now = Math.floor(Date.now() / 1000);
  const h = await push.vapidAuthorization(env, "https://fcm.googleapis.com", now);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, "header format: " + h);
  assert.equal(m[2], VAPID_PUBLIC_KEY);
  const [hb, cb, sb] = m[1].split(".");
  assert.deepEqual(JSON.parse(Buffer.from(hb, "base64url")), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(cb, "base64url"));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:admin@example.com");
  assert.ok(claims.exp > now && claims.exp <= now + 24 * 3600, "exp within 24 h");
  const sig = d(sb);
  assert.equal(sig.length, 64);
  // Verify with the public key imported from the base64url point, as a push service would.
  const verifyKey = await subtle.importKey("raw", d(m[2]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, sig, new TextEncoder().encode(hb + "." + cb)), "signature verifies");
  // Tampered claims must fail.
  const bad = e(new TextEncoder().encode(JSON.stringify({ ...claims, aud: "https://evil.example" })));
  assert.ok(!(await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, sig, new TextEncoder().encode(hb + "." + bad))));
  const h2 = await push.vapidAuthorization({ ...env, VAPID_SUBJECT: "mailto:x@y.z" }, "https://other.example", now);
  assert.equal(JSON.parse(Buffer.from(h2.split("t=")[1].split(".")[1], "base64url")).sub, "mailto:x@y.z");
  ok("VAPID JWT claims correct and ES256 signature verifies with the public key");
}

// ---- 4. sendWebPush against a mocked fetch ----
{
  const sub = { endpoint: "https://push.example.com/send/abc?x=1", keys: { p256dh: e(uaPublic), auth: e(auth) } };
  let seen;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response(null, { status: 201 }); };
  try {
    const payload = { title: "Decision needed", body: "Pick a colour", url: "/t/abc/", tag: "job", tendril: "abc" };
    const r = await push.sendWebPush(env, sub, payload, { ttl: 60, urgency: "high", topic: "job:42 update" });
    assert.deepEqual(r, { ok: true, status: 201, gone: false });
    assert.equal(seen.url, sub.endpoint);
    assert.equal(seen.init.method, "POST");
    const hd = seen.init.headers;
    assert.equal(hd["TTL"], "60");
    assert.equal(hd["Urgency"], "high");
    assert.equal(hd["Topic"], "job_42_update");
    assert.equal(hd["Content-Encoding"], "aes128gcm");
    assert.match(hd["Authorization"], /^vapid t=.+\..+\..+, k=/);
    const aud = JSON.parse(Buffer.from(hd["Authorization"].split("t=")[1].split(".")[1], "base64url")).aud;
    assert.equal(aud, "https://push.example.com");
    assert.equal(JSON.parse(await decrypt(new Uint8Array(seen.init.body), uaPair, uaPublic, auth)).title, "Decision needed");

    globalThis.fetch = async () => new Response("gone", { status: 410 });
    assert.deepEqual(await push.sendWebPush(env, sub, payload), { ok: false, status: 410, gone: true });
    globalThis.fetch = async () => new Response("", { status: 404 });
    assert.deepEqual(await push.sendWebPush(env, sub, payload), { ok: false, status: 404, gone: true });
    globalThis.fetch = async () => new Response("", { status: 429 });
    assert.deepEqual(await push.sendWebPush(env, sub, payload), { ok: false, status: 429, gone: false });
    assert.equal((await push.sendWebPush({}, sub, payload)).status, 501);
    assert.equal((await push.sendWebPush(env, sub, { body: "x".repeat(5000) })).status, 413);
    ok("sendWebPush headers, encrypted body, gone on 404/410");
  } finally { globalThis.fetch = realFetch; }
}

console.log(`\n${passed} passed`);
