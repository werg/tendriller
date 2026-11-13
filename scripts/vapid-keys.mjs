#!/usr/bin/env node
// Generates a VAPID key pair for Web Push (PROTOCOL section 10) and prints the
// values to store as Worker secrets:
//   VAPID_PUBLIC_KEY  base64url uncompressed P-256 point (65 bytes)
//   VAPID_PRIVATE_KEY base64url raw 32-byte private scalar
// Usage: node scripts/vapid-keys.mjs [--json]
const { subtle } = globalThis.crypto;

const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
const jwk = await subtle.exportKey("jwk", pair.privateKey);
const b64url = (b) => Buffer.from(b).toString("base64url");
const publicKey = b64url(pub);
const privateKey = jwk.d;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey }));
} else {
  console.log(`VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}

Store them as Worker secrets (paste each value when prompted):
  npx wrangler secret put VAPID_PUBLIC_KEY  --config server/wrangler.jsonc
  npx wrangler secret put VAPID_PRIVATE_KEY --config server/wrangler.jsonc
  npx wrangler secret put VAPID_SUBJECT     --config server/wrangler.jsonc   # e.g. mailto:you@example.com (optional)

For local development put the same lines in server/.dev.vars.
Keep the private key secret. Changing the key pair invalidates every existing
push subscription; devices must subscribe again.`);
}
