// Real packed Worker ↔ Node authorization contract. Only the initial host
// browser account/session is synthetic; no GitHub/Google or ChatGPT is contacted.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { parseArgs, promisify } from 'node:util';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from 'wrangler';
import { createTendrillerAccountAdapter } from '../integrations/chatgpt/account.mjs';

const root = resolve(import.meta.dirname, '..'), execute = promisify(execFile);
const { values } = parseArgs({ options: { 'engine-archive': { type: 'string' }, report: { type: 'string' } } });
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const archive = resolve(values['engine-archive'] ?? join(root, 'dist', `tendriller-engine-${version}.tgz`));
const reportPath = resolve(values.report ?? join(root, '.results/chatgpt-host.json'));
const HOST = 'https://oauth-host.example', NODE = 'https://oauth-integration.example', RESOURCE = NODE + '/mcp';
const CALLBACK = 'https://synthetic-client.example/oauth/callback', APP = 'ab'.repeat(32);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const challenge = value => createHash('sha256').update(value).digest('base64url');
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));

await test('packed OAuth host and real Node account adapter share current identity and authorization', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tendriller-chatgpt-host-'));
  const report = { status: 'running', qualification: 'packed-worker-node-account-contract', steps: [],
    limits: ['Synthetic initial host browser accounts; upstream GitHub/Google login is not exercised.',
      'Fixed-origin injected Miniflare transport; no Internet, live ChatGPT, native device, or browser rendering qualification.'] };
  let host, adapter, stage = 'verify packed engine';
  const phase = async (name, work) => { stage = name; await work(); report.steps.push(name); };
  t.after(async () => {
    adapter?.close();
    try { await host?.dispose(); }
    finally {
      report.status = report.status === 'running' ? 'failed' : report.status;
      if (report.status !== 'passed') report.failedStage = stage;
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      await rm(directory, { recursive: true, force: true });
    }
  });
  const engine = join(directory, 'engine'); await mkdir(engine);
  await execute('tar', ['-xzf', archive, '-C', engine], { timeout: 15000 });
  const packed = join(engine, 'package'), proof = await jsonFile(join(packed, 'provenance.json'));
  for (const [path, hash] of Object.entries(proof.files))
    assert.equal(sha(await readFile(join(packed, path))), hash, `Packed engine provenance mismatch: ${path}`);
  report.engine = { source: proof.source, dirty: proof.dirty, sha256: sha(await readFile(archive)), storageSchemaRevision: proof.storageSchemaRevision };
  const nodeSource = await execute('git', ['rev-parse', 'HEAD'], { cwd: root });
  const nodeStatus = await execute('git', ['status', '--porcelain'], { cwd: root });
  report.node = { source: nodeSource.stdout.trim(), dirty: nodeStatus.stdout.length > 0 };

  const bridgeSecret = randomBytes(32).toString('base64url'), bridgeId = 'roundtrip-bridge';
  const signing = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
  const oauth = { resource: RESOURCE, clients: [{ id: 'roundtrip-client', name: 'Synthetic OAuth client', redirectUris: [CALLBACK],
    scopes: ['applications:read', 'applications:write', 'events:subscribe'], tokenEndpointAuthMethod: 'none', allowRefresh: true }],
  bridges: [{ id: bridgeId, name: 'Synthetic connection manager', secretSha256: sha(bridgeSecret), applicationIds: [APP],
    managementRedirectUris: [NODE + '/connections/callback'] }] };
  const configPath = join(directory, 'wrangler.jsonc');
  const limits = (await jsonFile(join(packed, 'testing-ratelimits.json'))).ratelimits;
  await writeFile(configPath, JSON.stringify({ name: 'tendriller-oauth-contract-test', main: join(packed, 'worker.mjs'),
    compatibility_date: '2026-11-01', compatibility_flags: ['nodejs_compat'],
    durable_objects: { bindings: [{ name: 'TENDRIL', class_name: 'Tendril' }, { name: 'ADMISSION', class_name: 'Admission' }] },
    migrations: [{ tag: 'baseline', new_sqlite_classes: ['Tendril', 'Admission'] }],
    d1_databases: [{ binding: 'ACCOUNTS', database_name: 'oauth-test', database_id: '00000000-0000-4000-8000-000000000002' }],
    r2_buckets: [{ binding: 'FILES', bucket_name: 'oauth-test-files' }], ratelimits: limits,
    vars: { PUBLIC_BASE: HOST, PAGE_BASE_DOMAIN: 'oauth-pages.example' } }, null, 2), { mode: 0o600 });
  const { workerOptions: sourceOptions } = unstable_getMiniflareWorkerOptions(configPath);
  const { modulesRules: ignoredRules, ...workerOptions } = sourceOptions;
  host = new Miniflare({ ...convertV4MiniflareOptions({ ...workerOptions, modules: true, scriptPath: join(packed, 'worker.mjs'),
    modulesRoot: packed, host: '127.0.0.1', port: 0, cf: false,
    bindings: { ...workerOptions.bindings, OAUTH_CONFIG_JSON: JSON.stringify(oauth),
      OAUTH_SIGNING_JWK: JSON.stringify({ ...signing, kid: 'roundtrip-key', alg: 'ES256' }) } }),
  resourcePersistencePath: join(directory, 'host-state'), resourceTmpPath: join(directory, 'host-tmp'),
  enableDevRegistry: false, logRequests: false });
  await host.ready;
  const accounts = await host.getD1Database('ACCOUNTS'), manifest = await jsonFile(join(packed, 'package.json'));
  await phase('apply both exported migrations to isolated D1', async () => {
    for (const exported of ['./accounts-schema', './integration-oauth-schema']) {
      assert.equal(typeof manifest.exports[exported], 'string', `Missing public migration export: ${exported}`);
      for (const sql of unstable_splitSqlQuery(await readFile(join(packed, manifest.exports[exported]), 'utf8')))
        await accounts.prepare(sql).run();
    }
  });
  const owner = 'synthetic-owner', email = 'owner@example.test', hostToken = randomBytes(32).toString('base64url');
  const hostCookie = '__Host-tendriller=' + hostToken, now = Date.now();
  await accounts.batch([
    accounts.prepare("UPDATE service_state SET mode='open' WHERE id=1"),
    accounts.prepare('INSERT INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(owner, now, email),
    accounts.prepare('INSERT INTO identities(provider,subject,account_id,login,email,created_at) VALUES(?,?,?,?,?,?)').bind('github', owner, owner, owner, email, now),
    accounts.prepare('INSERT INTO identity_emails(provider,subject,email) VALUES(?,?,?)').bind('github', owner, email),
    accounts.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)').bind(sha(hostToken), owner, now, now + 3600000),
  ]);
  const fixedFetch = async (url, init = {}) => {
    assert.equal(new URL(url).origin, HOST, 'The account adapter must never choose another service destination');
    const headers = new Headers(init.headers);
    headers.set('CF-Connecting-IP', '198.18.0.1');
    return host.dispatchFetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.any([t.signal, ...(init.signal ? [init.signal] : [])]) });
  };
  const hostRequest = (path, init) => fixedFetch(new URL(path, HOST).href, init);
  const form = (path, body, cookie) => hostRequest(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
    ...(cookie ? { Cookie: cookie, Origin: HOST } : {}) }, body: new URLSearchParams(body) });
  let page;
  await phase('create and claim an actual host page through public routes', async () => {
    const created = await hostRequest('/api/tendrils', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: email, application: { id: APP }, name: 'OAuth contract test' }) });
    assert.equal(created.status, 201); page = await created.json();
    const key = new URL(page.page_url).pathname.split('/')[2];
    const claimed = await hostRequest('/auth/page?' + new URLSearchParams({ tendril: page.id, key }), { headers: { Cookie: hostCookie } });
    assert.equal(claimed.status, 303); await claimed.body?.cancel();
    assert.equal((await accounts.prepare('SELECT owner_account FROM tendrils WHERE id=?').bind(page.id).first()).owner_account, owner);
  });
  adapter = createTendrillerAccountAdapter({ origin: HOST, resource: RESOURCE, bridgeId, bridgeSecret, fetch: fixedFetch,
    applications: [{ id: APP, pageId: page.id, label: 'Contract application', allowedQueries: ['context'], allowedCommands: ['reply'],
      allowedEvents: ['assistance.requested'], allowEventDetails: true }] });
  await phase('validate actual discovery, JWKS, migration and bridge preflight', async () => {
    const discovery = await hostRequest('/.well-known/oauth-authorization-server');
    assert.equal(discovery.status, 200); assert.equal((await discovery.json()).issuer, HOST);
    const status = await adapter.checkHostConfiguration(); assert.equal(status.ready, true); assert.equal(status.liveChatGptVerified, false);
  });
  const authorize = async (cookie = hostCookie) => {
    const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    const params = new URLSearchParams({ response_type: 'code', client_id: 'roundtrip-client', redirect_uri: CALLBACK, resource: RESOURCE,
      scope: 'applications:read applications:write events:subscribe', state, code_challenge: challenge(verifier), code_challenge_method: 'S256' });
    const review = await hostRequest('/oauth/authorize?' + params, { headers: { Cookie: cookie } });
    assert.equal(review.status, 200);
    const intent = /name="intent" value="([^"]+)"/u.exec(await review.text())?.[1]; assert.ok(intent);
    const approved = await form('/oauth/authorize', { intent, decision: 'allow' }, cookie);
    assert.equal(approved.status, 303);
    const result = new URL(approved.headers.get('Location')); assert.equal(result.origin + result.pathname, CALLBACK);
    assert.equal(result.searchParams.get('state'), state); assert.equal(result.searchParams.get('iss'), HOST);
    const tokens = await form('/oauth/token', { grant_type: 'authorization_code', client_id: 'roundtrip-client', resource: RESOURCE,
      redirect_uri: CALLBACK, code: result.searchParams.get('code'), code_verifier: verifier });
    assert.equal(tokens.status, 200); return tokens.json();
  };
  const authenticate = token => adapter.auth.authenticate(new Request(RESOURCE, { headers: { Authorization: 'Bearer ' + token }, signal: t.signal }));
  let issued, principal;
  await phase('exchange real PKCE code and verify JWT plus exact live grant in Node', async () => {
    issued = await authorize(); principal = await authenticate(issued.access_token);
    assert.equal(principal.id, owner); assert.equal(principal.issuer, HOST); assert.match(principal.oauthGrantId, /^og_/u);
    assert.equal(await adapter.authorizeAccountAccess(principal, APP), true);
    assert.equal(await adapter.authorizeOwner(principal, APP), true);
    assert.equal(await adapter.ownerEmailForPrincipal(principal), email);
    assert.equal(await adapter.authorizeAccountAccess(principal, 'ff'.repeat(32)), false);
  });
  report.status = 'passed';
});
