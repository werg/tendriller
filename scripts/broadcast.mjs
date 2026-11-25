#!/usr/bin/env node
/**
 * Operator helper for Tendriller Ed25519-signed system broadcasts.
 *
 * Usage:
 *   node scripts/broadcast.mjs keygen [--kid ID]
 *   node scripts/broadcast.mjs list --server https://staging.tendriller.dev [--token ENV_OR_VALUE]
 *   node scripts/broadcast.mjs publish --server https://staging.tendriller.dev --file broadcast.json
 *   node scripts/broadcast.mjs revoke --server https://staging.tendriller.dev --id bc_... [--reason "..."]
 *
 * Authentication: set BROADCAST_ADMIN_TOKEN (or pass --token).
 */
import { readFileSync } from 'node:fs';
import { generateBroadcastKeyPair, publicJwkFromPrivate } from '../contract/broadcasts.mjs';

function parseFlags(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { cmd: positionals[0], flags };
}

const { cmd, flags } = parseFlags(process.argv.slice(2));

if (!cmd || cmd === 'help' || flags.help) {
  console.log(`Usage:
  node scripts/broadcast.mjs keygen [--kid ID]
  node scripts/broadcast.mjs list --server ORIGIN
  node scripts/broadcast.mjs publish --server ORIGIN --file PATH
  node scripts/broadcast.mjs revoke --server ORIGIN --id bc_... [--reason TEXT]

Set BROADCAST_ADMIN_TOKEN in the environment (or pass --token) for publish/revoke/admin list.`);
  process.exit(0);
}

if (cmd === 'keygen') {
  const { kid, publicJwk, privateJwk } = await generateBroadcastKeyPair({
    ...(typeof flags.kid === 'string' ? { kid: flags.kid } : {}),
  });
  console.log(JSON.stringify({
    kid,
    BROADCAST_SIGNING_JWK: JSON.stringify(privateJwk),
    publicJwk: publicJwkFromPrivate(privateJwk),
  }, null, 2));
  process.exit(0);
}

const server = typeof flags.server === 'string' ? new URL(flags.server).origin : '';
if (!server) {
  console.error('Missing --server ORIGIN');
  process.exit(64);
}
const token = typeof flags.token === 'string' ? flags.token : (process.env.BROADCAST_ADMIN_TOKEN ?? '');

if (cmd === 'list') {
  const url = token ? `${server}/api/admin/broadcasts` : `${server}/api/broadcasts`;
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify(data, null, 2)); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

if (!token) {
  console.error('Set BROADCAST_ADMIN_TOKEN or pass --token');
  process.exit(64);
}

if (cmd === 'publish') {
  if (typeof flags.file !== 'string') { console.error('Missing --file PATH'); process.exit(64); }
  const payload = JSON.parse(readFileSync(flags.file, 'utf8'));
  const res = await fetch(`${server}/api/admin/broadcasts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify(data, null, 2)); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

if (cmd === 'revoke') {
  if (typeof flags.id !== 'string') { console.error('Missing --id bc_...'); process.exit(64); }
  const url = new URL(`/api/admin/broadcasts/${encodeURIComponent(flags.id)}`, server);
  if (typeof flags.reason === 'string') url.searchParams.set('reason', flags.reason);
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) { console.error(JSON.stringify(data, null, 2)); process.exit(1); }
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
process.exit(64);
