#!/usr/bin/env node
/** Backend-only operator client. Credentials are read from private files, never argv. */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ADMIN_SCOPES = Object.freeze(['analytics:read', 'premium:read', 'premium:write', 'audit:read']);
const DAY_MS = 86_400_000;
const TOKEN_RE = /^td_admin_[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NETWORK_FLAGS = ['server', 'token-file'];
const FLAGS = {
  'generate-credential': ['id', 'scopes', 'expires-in-days', 'token-file', 'config-file'],
  grant: [...NETWORK_FLAGS, 'id', 'account-id', 'plan', 'expires-at', 'reason'],
  revoke: [...NETWORK_FLAGS, 'id', 'reason'],
  grants: [...NETWORK_FLAGS, 'account-id', 'limit', 'before'],
  analytics: [...NETWORK_FLAGS, 'from', 'to'],
  audit: [...NETWORK_FLAGS, 'limit', 'before'],
};

export const HELP = `Usage:
  node scripts/admin.mjs generate-credential --id ID --scopes SCOPE[,SCOPE...] \\
    --token-file PATH --config-file PATH [--expires-in-days 30]
  node scripts/admin.mjs grant --server ORIGIN --token-file PATH \\
    --id UUID --account-id ID --plan pro|team --expires-at TIMESTAMP --reason TEXT
  node scripts/admin.mjs revoke --server ORIGIN --token-file PATH --id UUID --reason TEXT
  node scripts/admin.mjs grants --server ORIGIN --token-file PATH --account-id ID [--limit N] [--before CURSOR]
  node scripts/admin.mjs analytics --server ORIGIN --token-file PATH --from YYYY-MM-DD --to YYYY-MM-DD
  node scripts/admin.mjs audit --server ORIGIN --token-file PATH [--limit N] [--before CURSOR]

Scopes: ${ADMIN_SCOPES.join(', ')}
generate-credential creates two new private (0600) files. The config file is a
one-record JSON array for ADMIN_API_CREDENTIALS_JSON; it contains only a token hash.
Credential lifetime is 1–90 days, default 30. Keep both files outside the checkout.
Install the reviewed config on the intended service separately; this CLI does not deploy it.
TIMESTAMP is an absolute RFC3339 timestamp with a timezone, or epoch milliseconds.
Choose and retain a grant UUID before the first attempt; retry with the same id and body.
HTTPS is required except for loopback development. Redirects and automatic retries
are disabled. Network commands never use cookies and never accept a token on argv.
`;

export function parseAdminArgs(argv) {
  if (!argv.length || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))) return { command: 'help', flags: {} };
  const [command, ...args] = argv;
  if (!Object.hasOwn(FLAGS, command)) throw new Error('Unknown admin command. Run with --help for usage.');
  if (args.length === 1 && args[0] === '--help') return { command: 'help', flags: {} };
  const flags = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.startsWith('--') ? args[i].slice(2) : '';
    if (!FLAGS[command].includes(name)) throw new Error('Unknown or misplaced flag. Run with --help for usage.');
    if (Object.hasOwn(flags, name)) throw new Error(`Duplicate --${name}`);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    flags[name] = value;
  }
  return { command, flags };
}

function required(flags, key, max = 4096) {
  const value = flags[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`--${key} is required and must be at most ${max} characters without control characters`);
  }
  return value;
}

function integer(value, field, min, max) {
  if (!/^[0-9]+$/.test(String(value))) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return n;
}

export function adminOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('--server must be an exact HTTPS origin'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || ![url.origin, url.origin + '/'].includes(value)) {
    throw new Error('--server must be an exact HTTPS origin (HTTP is allowed only on loopback)');
  }
  return url.origin;
}

function timestamp(value) {
  if (/^[0-9]+$/.test(value)) return integer(value, '--expires-at', 1, 8_640_000_000_000_000);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('--expires-at must be an absolute RFC3339 timestamp with a timezone or epoch milliseconds');
  }
  day(value.slice(0, 10), 'expires-at');
  return Date.parse(value);
}

function day(value, flag) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`--${flag} must be a real date in YYYY-MM-DD format`);
  }
  return value;
}

function grantId(flags) {
  const id = required(flags, 'id', 36);
  if (!UUID_RE.test(id)) throw new Error('--id must be a lowercase UUID retained across retries');
  return id;
}

/** Creates neither a live principal nor a deployment; both output files must be new. */
export async function generateCredentialFiles({ id, scopes, expiresInDays = 30, tokenFile, configFile }, { now = Date.now() } = {}) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{2,63}$/.test(id)) throw new Error('--id must match ^[a-z][a-z0-9_-]{2,63}$');
  if (!Array.isArray(scopes) || !scopes.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !ADMIN_SCOPES.includes(scope))) {
    throw new Error('--scopes must be a nonempty, comma-separated list of distinct supported scopes');
  }
  const days = integer(expiresInDays, '--expires-in-days', 1, 90);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid credential creation time');
  if (!tokenFile || !configFile || resolve(tokenFile) === resolve(configFile)) throw new Error('Token and config must use different new files');
  const token = 'td_admin_' + randomBytes(32).toString('hex');
  const record = { id, sha256: createHash('sha256').update(token).digest('hex'), scopes: [...scopes], issuedAt: now, expiresAt: now + days * DAY_MS };
  const created = [];
  try {
    // Reserve both names before writing either file. wx refuses existing paths,
    // including symlinks, rather than truncating or following them.
    for (const path of [tokenFile, configFile]) {
      const handle = await open(path, 'wx', 0o600);
      created.push({ path, handle });
      await handle.chmod(0o600);
    }
    await created[0].handle.writeFile(token + '\n', 'utf8');
    await created[1].handle.writeFile(JSON.stringify([record], null, 2) + '\n', 'utf8');
    await Promise.all(created.map(({ handle }) => handle.sync()));
  } catch {
    await Promise.all(created.map(async ({ path, handle }) => {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
    }));
    throw new Error('Could not create private credential files; choose two new writable paths. Existing files were not overwritten.');
  }
  await Promise.all(created.map(({ handle }) => handle.close()));
  return { id, scopes: record.scopes, issuedAt: record.issuedAt, expiresAt: record.expiresAt, tokenFile: resolve(tokenFile), configFile: resolve(configFile) };
}

/** Reject symlinks, non-regular files and oversized credentials before reading. */
async function readTokenFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('unsafe file');
    const bytes = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024) throw new Error('oversized credential');
    const token = bytes.subarray(0, bytesRead).toString('utf8').trim();
    if (!TOKEN_RE.test(token)) throw new Error('invalid credential');
    return token;
  } catch {
    throw new Error('Cannot read a valid token from --token-file; use a private regular file (0600), not a symlink');
  } finally { await handle?.close(); }
}

async function responseJson(response) {
  if (!response.body) throw new Error('Admin server returned no JSON response');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1024 * 1024 || chunks.length >= 16_384) throw new Error('Admin response exceeds its size limit');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Admin server returned invalid JSON'); }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

/** No redirects, cookies or retries; an uncertain mutation retains its original id. */
export async function adminRequest({ server, tokenFile, path, query = {}, method = 'GET', body }, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  integer(timeoutMs, 'Request timeout', 1, 30_000);
  const origin = adminOrigin(server);
  if (!/^\/api\/admin\/v1\/[a-z0-9/-]+$/.test(path)) throw new Error('Invalid admin API path');
  const token = await readTokenFile(tokenFile);
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Admin request timed out. For grant retries, retain the original id and body.'));
    }, timeoutMs);
  });
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(url.href, {
        method, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error('Admin request failed; redirects are not allowed. For grant retries, retain the original id and body.');
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('Admin redirects are not allowed');
    }
    let data;
    try { data = await responseJson(response); }
    catch { throw new Error('Admin response is not valid JSON or exceeds the 1 MiB response limit'); }
    // Never echo a credential even if a misconfigured server reflects it.
    const safeData = JSON.parse(JSON.stringify(data).split(token).join('[redacted]'));
    return { ok: response.ok, status: response.status, data: safeData };
  })();
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}

export async function runAdmin(argv, { stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text), fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    const { command, flags } = parseAdminArgs(argv);
    if (command === 'help') { stdout(HELP); return 0; }
    if (command === 'generate-credential') {
      const result = await generateCredentialFiles({
        id: required(flags, 'id', 64), scopes: required(flags, 'scopes', 256).split(','),
        expiresInDays: flags['expires-in-days'] ?? 30,
        tokenFile: required(flags, 'token-file'), configFile: required(flags, 'config-file'),
      }, { now });
      stdout(JSON.stringify(result, null, 2) + '\n');
      return 0;
    }
    const request = { server: required(flags, 'server'), tokenFile: required(flags, 'token-file'), path: '', query: {} };
    if (command === 'grant') {
      const expiresAt = timestamp(required(flags, 'expires-at', 64));
      // The server validates new grants' lifetimes. A historical timestamp must
      // remain sendable to recover the result of the same request after expiry.
      const plan = required(flags, 'plan', 4);
      if (!['pro', 'team'].includes(plan)) throw new Error('--plan must be pro or team');
      Object.assign(request, { path: '/api/admin/v1/premium-grants', method: 'POST', body: {
        id: grantId(flags), accountId: required(flags, 'account-id', 128), plan, expiresAt, reason: required(flags, 'reason', 500).trim(),
      } });
    } else if (command === 'revoke') {
      Object.assign(request, { path: `/api/admin/v1/premium-grants/${grantId(flags)}/revoke`, method: 'POST', body: { reason: required(flags, 'reason', 500).trim() } });
    } else if (command === 'analytics') {
      request.path = '/api/admin/v1/analytics';
      request.query = { from: day(required(flags, 'from', 10), 'from'), to: day(required(flags, 'to', 10), 'to') };
      if (request.query.from > request.query.to) throw new Error('--from must not be after --to');
    } else {
      request.path = command === 'grants' ? '/api/admin/v1/premium-grants' : '/api/admin/v1/audit';
      if (command === 'grants') request.query.accountId = required(flags, 'account-id', 128);
      if (flags.limit !== undefined) request.query.limit = String(integer(flags.limit, '--limit', 1, 100));
      if (flags.before !== undefined) request.query.before = required(flags, 'before', 256);
    }
    const result = await adminRequest(request, { fetchImpl });
    (result.ok ? stdout : stderr)(JSON.stringify(result.data, null, 2) + '\n');
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr((error instanceof Error ? error.message : 'Admin command failed') + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runAdmin(process.argv.slice(2));
}
