#!/usr/bin/env node
/**
 * Generate a `LOCAL_PASSWORD_HASH` value for self-hosted Tendriller password sign-in.
 *
 * Usage:
 *   npm run auth:hash-password -- "your-strong-passphrase"
 *   # or interactive stdin without leaking to shell history:
 *   npm run auth:hash-password
 */
import { createInterface } from "node:readline/promises";
import { randomBytes, pbkdf2Sync } from "node:crypto";

const ITERATIONS = 100_000;
const toBase64Url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let password = process.argv[2];
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  password = await rl.question("Enter password to hash: ");
  rl.close();
}
if (!password || password.length < 8) {
  console.error("Choose a password of at least 8 characters.");
  process.exit(1);
}

const salt = randomBytes(16);
const derived = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
const encoded = `pbkdf2_sha256$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`;

console.log(`LOCAL_PASSWORD_HASH=${encoded}`);
console.error("\nSet LOCAL_PASSWORD_HASH (secret) and LOCAL_OWNER_EMAIL (var) in .dev.vars or via `wrangler secret put LOCAL_PASSWORD_HASH`.");
