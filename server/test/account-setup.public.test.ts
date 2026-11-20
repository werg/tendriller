import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/env';
import { route } from '../src/router';
import { accountSetupPageId } from '../src/account-setup';
import { oauthConfig, signAccessToken } from '../src/accounts/oauth-support';
import { sha256Hex } from '../src/ids';
import { advance, inDO, runAlarm, stub } from './helpers';
import { createSetupIntent, setupRequest, completeSetupIntent, type SetupIntent, type SetupResult } from '../../contract/setup.mjs';

const ORIGIN = 'https://tendriller.dev';
let signing: string;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']) as CryptoKeyPair;
  signing = JSON.stringify({ ...await crypto.subtle.exportKey('jwk', pair.privateKey), alg: 'ES256', kid: 'setup-test' });
});
async function fixture(options: { verified?: boolean; scope?: string; account?: string; client?: string; email?: string } = {}) {
  const account = options.account ?? crypto.randomUUID(), client = options.client ?? 'setup-client', email = options.email ?? account + '@example.test';
  const now = Date.now(), grant = crypto.randomUUID(), scope = options.scope ?? 'tendrils:create', ip = `198.18.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  const settings: Env = { ...env, OAUTH_SIGNING_JWK: signing, OAUTH_CONFIG_JSON: JSON.stringify({ resource: ORIGIN + '/mcp', clients: [
    { id: client, name: 'Setup client', redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'], scopes: ['tendrils:create','tendrils:list'] },
  ] }) };
  await env.ACCOUNTS.prepare('INSERT OR IGNORE INTO accounts(id,created_at,email) VALUES(?,?,?)').bind(account, now, email).run();
  await env.ACCOUNTS.prepare("INSERT OR IGNORE INTO identities(provider,subject,account_id,login,email,created_at) VALUES('google',?,?,?,?,?)").bind(account, account, 'setup-owner', email, now).run();
  if (options.verified !== false) await env.ACCOUNTS.prepare("INSERT OR IGNORE INTO identity_emails(provider,subject,email) VALUES('google',?,?)").bind(account, email).run();
  const config = (await oauthConfig(settings))!, jti = crypto.randomUUID();
  const token = await signAccessToken(config, { iss: ORIGIN, aud: ORIGIN + '/mcp', sub: account, client_id: client, sid: grant, jti, scope, exp: Math.floor((now+300000)/1000) });
  await env.ACCOUNTS.batch([
    env.ACCOUNTS.prepare('INSERT INTO integration_oauth_grants(id,account_id,client_id,resource,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(grant, account, client, ORIGIN+'/mcp', scope, now, now+600000),
    env.ACCOUNTS.prepare('INSERT INTO integration_oauth_access(hash,grant_id,jti,scope,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(await sha256Hex(token),grant,jti,scope,now,now+300000),
  ]);
  const transport = env.TENDRIL;
  let loseInitializationReply = false, pauseAfterAdmission = false, loseInitializationRequest = false, failReservationAlarm = false, removeIdentityBeforeClaim = false;
  settings.TENDRIL = { idFromName: name => transport.idFromName(name), get(id) {
    const object = transport.get(id);
    return { async fetch(request: Request) {
      const pageId = request.headers.get('x-tendril-id');
      if (pageId) await inDO(pageId, t => { t.env.OAUTH_CONFIG_JSON = settings.OAUTH_CONFIG_JSON; t.env.OAUTH_SIGNING_JWK = signing; });
      if (loseInitializationRequest && new URL(request.url).pathname === '/setup/initialize') { loseInitializationRequest = false; throw new Error('LOST_INITIALIZATION_REQUEST'); }
      if (removeIdentityBeforeClaim && new URL(request.url).pathname === '/claim/owner') {
        removeIdentityBeforeClaim = false;
        await env.ACCOUNTS.prepare('DELETE FROM identity_emails WHERE subject=?').bind(account).run();
      }
      if (pageId && failReservationAlarm && new URL(request.url).pathname === '/setup/reserve') {
        failReservationAlarm = false;
        await inDO(pageId, t => {
          const ensure = t.ensureSetupExpiry;
          t.ensureSetupExpiry = async () => { t.ensureSetupExpiry = ensure; throw new Error('SETUP_ALARM_UNAVAILABLE'); };
        });
      }
      const response = await object.fetch(request);
      if (loseInitializationReply && new URL(request.url).pathname === '/setup/initialize') { loseInitializationReply = false; await response.body?.cancel(); throw new Error('LOST_INITIALIZATION_REPLY'); }
      return response;
    } } as DurableObjectStub;
  } } as DurableObjectNamespace;
  const admission = env.ADMISSION;
  settings.ADMISSION = { idFromName: name => admission.idFromName(name), get(id) {
    const object = admission.get(id);
    return { async fetch(request: Request) {
      const response = await object.fetch(request);
      if (pauseAfterAdmission && new URL(request.url).pathname === '/reserve') { pauseAfterAdmission = false; await env.ACCOUNTS.prepare("UPDATE service_state SET mode='creation_paused' WHERE id=1").run(); }
      return response;
    } } as DurableObjectStub;
  } } as DurableObjectNamespace;
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('Authorization')) headers.set('Authorization','Bearer '+token);
    headers.set('CF-Connecting-IP',ip); headers.set('Content-Type','application/json');
    return route(new Request(ORIGIN+path,{...init,headers}),settings);
  };
  const intent = async (operationId = crypto.randomUUID()) => {
    let saved: SetupIntent | null = null;
    return createSetupIntent(ORIGIN, { operationId, name: 'Account page' }, { store: { load: async () => saved, save: async (_id, value) => { saved ??= value; } } });
  };
  const prepare = async (value: SetupIntent | object) => {
    const response = await request('/api/setup', { method:'POST', body:JSON.stringify('credential' in value ? setupRequest(value as SetupIntent) : value) });
    return { response, body: await response.json() as SetupResult & { error?: { code: string } } };
  };
  return { account, client, grant, email, settings, token, ip, request, intent, prepare,
    loseReply: () => { loseInitializationReply = true; }, loseRequest: () => { loseInitializationRequest = true; },
    removeIdentityBeforeClaim: () => { removeIdentityBeforeClaim = true; },
    failReservationAlarm: () => { failReservationAlarm = true; }, pauseAfterAdmission: () => { pauseAfterAdmission = true; } };
}

// Inject a change on the real D1 boundary without replacing the query result or
// the allocation trigger. This exposes revocation between its two auth checks.
function atDatabaseBoundary(f: Awaited<ReturnType<typeof fixture>>, matches: (sql: string) => boolean,
  method: 'all' | 'first' | 'run', timing: 'before' | 'after', effect: () => Promise<unknown>) {
  const database = f.settings.ACCOUNTS;
  let fired = false;
  const statement = (value: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(value, {
    get(target, key) {
      if (key === 'bind') return (...args: unknown[]) => statement(target.bind(...args), sql);
      if (key === method && matches(sql)) return async (...args: unknown[]) => {
        if (!fired && timing === 'before') { fired = true; await effect(); }
        const result = await (target[method] as (...args: unknown[]) => Promise<unknown>)(...args);
        if (!fired && timing === 'after') { fired = true; await effect(); }
        return result;
      };
      const member = Reflect.get(target, key);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  f.settings.ACCOUNTS = new Proxy(database, { get(target, key) {
    if (key === 'prepare') return (sql: string) => statement(target.prepare(sql), sql);
    const member = Reflect.get(target, key);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
}

it('rechecks the grant before exposing a list or a retained allocation after its D1 read', async () => {
  for (const view of ['list', 'inspect-missing-journal', 'prepare-missing-journal'] as const) {
    const f = await fixture(), intent = await f.intent(), ready = await f.prepare(intent);
    if (view !== 'list') await env.ACCOUNTS.prepare('DELETE FROM account_setups WHERE page_id=?').bind(ready.body.pageId).run();
    atDatabaseBoundary(f, sql => view === 'list' ? sql.startsWith('SELECT a.*') : sql.startsWith('SELECT * FROM account_setup_allocations WHERE service_origin='),
      view === 'list' ? 'all' : 'first', 'after', () => env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=? WHERE id=?').bind(Date.now(), f.grant).run());
    const response = view === 'prepare-missing-journal' ? (await f.prepare(intent)).response
      : await f.request('/api/setup' + (view === 'list' ? '' : '?operationId=' + intent.operationId));
    expect(response.status).toBe(401);
    if (view !== 'prepare-missing-journal') {
      const denied = await response.json();
      expect(denied).toMatchObject({ error: { code: 'invalid_token' } });
      expect(JSON.stringify(denied)).not.toContain(ready.body.pageId);
    }
  }
});

it('preserves precise trigger refusal codes when account readiness changes at allocation', async () => {
  for (const reason of ['creation_paused', 'owner_verification_required', 'setup_binding_inactive'] as const) {
    const f = await fixture(), intent = await f.intent();
    atDatabaseBoundary(f, sql => sql.startsWith('INSERT OR IGNORE INTO account_setups'), 'run', 'before', async () => {
      if (reason === 'creation_paused') await env.ACCOUNTS.prepare("UPDATE service_state SET mode='creation_paused' WHERE id=1").run();
      else if (reason === 'owner_verification_required') await env.ACCOUNTS.prepare("DELETE FROM identity_emails WHERE provider='google' AND subject=?").bind(f.account).run();
      else await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=? WHERE id=?').bind(Date.now(), f.grant).run();
    });
    try {
      const denied = await f.prepare(intent);
      expect(denied.response.status).toBe(reason === 'creation_paused' ? 503 : 403);
      expect(denied.body.error?.code).toBe(reason);
      expect(JSON.stringify(denied.body)).not.toContain('capacity is full');
      expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind(f.account).first()).toEqual({ n: 0 });
      expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toBeNull();
    } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
  }
});

it('prepares and inspects one account-bound page with a retained credential and no returned secret', async () => {
  const f = await fixture(), intent = await f.intent(), prepared = await f.prepare(intent);
  expect(prepared.response.status).toBe(200); expect(prepared.body.state).toBe('ready');
  expect(JSON.stringify(prepared.body)).not.toContain(intent.credential); expect(prepared.body.page).not.toHaveProperty('token');
  const handle = await completeSetupIntent(intent, prepared.body);
  expect((await f.request('/api/t/'+handle.id, { headers:{ Authorization:'Bearer '+handle.token } })).status).toBe(200);
  expect(await inDO(handle.id, t => t.db.get('agent_binding:setup', null))).toMatchObject({ scopes:['host:read','participants:connect','control:write','publication:write','assistant:manage'] });
  expect(await inDO(handle.id, t => t.db.get('intended_owner_account', null))).toBe(f.account);
  const again = await f.prepare(intent); expect(again.body).toEqual(prepared.body);
  expect(await (await f.request('/api/setup?operationId='+intent.operationId)).json()).toEqual(prepared.body);
  const listing = await (await f.request('/api/setup')).json() as any;
  expect(listing.setups).toHaveLength(1); expect(listing.setups[0].operationId).toBe(intent.operationId);
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({ count:1 });
});

it('converges concurrent duplicates and refuses changed names, identities or commitments', async () => {
  const f = await fixture(), intent = await f.intent(), responses = await Promise.all([f.prepare(intent),f.prepare(intent),f.prepare(intent)]);
  const ids = new Set(responses.map(r => r.body.pageId)); expect(ids.size).toBe(1);
  expect((await f.prepare(intent)).body.state).toBe('ready');
  const input = setupRequest(intent);
  for (const change of [{ name:'different' },{ applicationId:'c'.repeat(64) },{ credentialCommitment:'d'.repeat(64) }]) {
    const rejected = await f.prepare({ ...input,...change });
    expect(rejected.response.status).toBe(409); expect(rejected.body.error?.code).toBe('setup_operation_conflict');
  }
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind(f.account).first()).toEqual({ n:1 });
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({ count:1 });
});

it('reconciles a lost page-initialization reply after eviction without minting another credential or quota charge', async () => {
  const f = await fixture(), intent = await f.intent(); f.loseReply();
  const uncertain = await f.prepare(intent); expect(uncertain.body.state).toBe('provisioning');
  await evictDurableObject(stub(uncertain.body.pageId));
  const recovered = await f.prepare(intent); expect(recovered.body.state).toBe('ready'); expect(recovered.body.pageId).toBe(uncertain.body.pageId);
  const handle = await completeSetupIntent(intent, recovered.body);
  expect(await inDO(handle.id, t => t.db.one('SELECT COUNT(*) AS n FROM tokens'))).toEqual({ n:1 });
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({ count:1 });
  const admissions = env.ADMISSION.get(env.ADMISSION.idFromName('global'));
  expect(await runInDurableObject(admissions, (_instance, state) => state.storage.sql.exec('SELECT COUNT(*) AS n FROM creations WHERE id=?', handle.id).one())).toEqual({ n:1 });
});

it('retries exact initialization after transport loses the request before delivery', async () => {
  const f = await fixture(), intent = await f.intent(); f.loseRequest();
  const uncertain = await f.prepare(intent); expect(uncertain.body.state).toBe('provisioning');
  expect(await inDO(uncertain.body.pageId, t => t.exists())).toBe(false);
  expect(await env.ACCOUNTS.prepare('SELECT initialization_started FROM account_setups WHERE page_id=?').bind(uncertain.body.pageId).first()).toEqual({ initialization_started:1 });
  await evictDurableObject(stub(uncertain.body.pageId));
  const recovered = await f.prepare(intent); expect(recovered.body.state).toBe('ready'); expect(recovered.body.pageId).toBe(uncertain.body.pageId);
  expect(await inDO(recovered.body.pageId, t => t.db.one('SELECT COUNT(*) AS n FROM tokens'))).toEqual({ n:1 });
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({ count:1 });
});

it('retains a durable alarm before admission and releases abandoned pre-page capacity', async () => {
  const f = await fixture(), intent = await f.intent(); f.pauseAfterAdmission();
  const paused = await f.prepare(intent), pageId = paused.body.pageId;
  try {
    expect(paused.body.state).toBe('blocked'); expect(await inDO(pageId, t => t.exists())).toBe(false);
    expect(await inDO(pageId, t => t.ctx.storage.getAlarm())).toBeGreaterThan(Date.now());
    const admissions = env.ADMISSION.get(env.ADMISSION.idFromName('global'));
    const reservation = () => runInDurableObject(admissions, (_instance, state) => state.storage.sql.exec('SELECT released FROM creations WHERE id=?', pageId).one());
    expect(await reservation()).toEqual({ released:0 });
    await advance(pageId, 86_400_001); expect(await runAlarm(pageId)).toBe(true);
    expect(await reservation()).toEqual({ released:1 });
    expect(await inDO(pageId, t => t.db.get('account_setup_reservation', null))).toMatchObject({ state:'retired', page:pageId });
    expect(await env.ACCOUNTS.prepare('SELECT state FROM account_setups WHERE page_id=?').bind(pageId).first()).toEqual({ state:'expired' });
    expect(await env.ACCOUNTS.prepare('SELECT id FROM tendrils WHERE id=?').bind(pageId).first()).toBeNull();
    const late = await admissions.fetch(new Request('https://admission.internal/reserve', { method:'POST', headers:{'x-tendril-id':pageId,'x-setup-expires-at':String(Date.now()-1)} }));
    expect(late.status).toBe(410); expect(await reservation()).toEqual({ released:1 });
    expect((await f.prepare(intent)).body.state).toBe('expired');
  } finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
});

it('does not consume global admission when the required reservation alarm fails', async () => {
  const f = await fixture(), intent = await f.intent(); f.failReservationAlarm();
  const uncertain = await f.prepare(intent); expect(uncertain.body.state).toBe('provisioning');
  const admissions = env.ADMISSION.get(env.ADMISSION.idFromName('global'));
  expect(await runInDurableObject(admissions, (_instance, state) => state.storage.sql.exec('SELECT COUNT(*) AS n FROM creations WHERE id=?', uncertain.body.pageId).one())).toEqual({ n:0 });
  expect((await f.prepare(intent)).body.state).toBe('ready');
});

it('fails closed when an allocated page loses its pre-initialization reservation journal', async () => {
  const f = await fixture(), intent = await f.intent(); f.loseRequest();
  const uncertain = await f.prepare(intent);
  await inDO(uncertain.body.pageId, t => t.db.del('account_setup_reservation'));
  const stopped = await f.prepare(intent); expect(stopped.body.state).toBe('reconciliation_required');
  expect(await inDO(uncertain.body.pageId, t => t.exists())).toBe(false);
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({ count:1 });
});

it('rejects coerced request identifiers before any operation or quota is allocated', async () => {
  const f = await fixture(), input = setupRequest(await f.intent());
  for (const key of ['operationId','applicationId','credentialCommitment'] as const) {
    for (const value of [123,[input[key]]]) {
      const denied = await f.prepare({ ...input, [key]:value });
      expect(denied.response.status).toBe(400); expect(denied.body.error?.code).toBe('invalid_setup_request');
    }
  }
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setup_allocations WHERE account_id=?').bind(f.account).first()).toEqual({n:0});
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toBeNull();
});

it('retains the original allocation when its D1 journal is missing and never charges or replaces it', async () => {
  const f = await fixture(), intent = await f.intent(), ready = await f.prepare(intent);
  await env.ACCOUNTS.prepare('DELETE FROM account_setups WHERE page_id=?').bind(ready.body.pageId).run();
  for (const resumed of [(await f.prepare(intent)).body, await (await f.request('/api/setup?operationId='+intent.operationId)).json() as SetupResult]) {
    expect(resumed.state).toBe('reconciliation_required'); expect(resumed.code).toBe('setup_journal_missing'); expect(resumed.pageId).toBe(ready.body.pageId);
  }
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind(f.account).first()).toEqual({n:0});
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setup_allocations WHERE account_id=?').bind(f.account).first()).toEqual({n:1});
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({ count:1 });
  const listed = await (await f.request('/api/setup')).json() as { setups:SetupResult[] };
  expect(listed.setups[0]).toMatchObject({ pageId:ready.body.pageId, state:'reconciliation_required' });
});

it('does not revive a locally revoked setup credential during prepare or inspection', async () => {
  const f = await fixture(), intent = await f.intent(), ready = await f.prepare(intent);
  await inDO(ready.body.pageId, t => t.db.run("DELETE FROM tokens WHERE name='setup'"));
  const retry = await f.prepare(intent), inspected = await (await f.request('/api/setup?operationId='+intent.operationId)).json() as SetupResult;
  expect(retry.body.state).toBe('blocked'); expect(inspected.state).toBe('blocked'); expect(retry.body.code).toBe('setup_binding_inactive');
  expect(await inDO(ready.body.pageId, t => t.db.one("SELECT hash FROM tokens WHERE name='setup'"))).toBeNull();
  await expect(completeSetupIntent(intent,retry.body)).rejects.toMatchObject({code:'setup_binding_inactive'});
});

it('reports a damaged scoped binding as blocked without returning a ready reconstruction receipt', async () => {
  for (const fault of ['missing','widened'] as const) {
    const f = await fixture(), intent = await f.intent(), ready = await f.prepare(intent);
    await inDO(ready.body.pageId, t => {
      if (fault === 'missing') t.db.del('agent_binding:setup');
      else {
        const binding = t.db.get<{id:string;scopes:string[];revision:number}>('agent_binding:setup', {id:'',scopes:[],revision:1});
        t.db.set('agent_binding:setup', {...binding,scopes:[...binding.scopes,'agents:delegate']});
      }
    });
    const replay = await f.prepare(intent), inspected = await (await f.request('/api/setup?operationId='+intent.operationId)).json() as SetupResult;
    expect(replay.body).toMatchObject({ state:'blocked', code:'setup_binding_inactive', pageId:ready.body.pageId });
    expect(inspected).toMatchObject({ state:'blocked', code:'setup_binding_inactive', pageId:ready.body.pageId });
    expect((await f.request('/api/t/'+ready.body.pageId,{headers:{Authorization:'Bearer '+intent.credential}})).status).toBe(401);
  }
});

it('atomically enforces the last daily creation slot across concurrent operations', async () => {
  const f = await fixture(), first = await f.intent(), second = await f.intent();
  await env.ACCOUNTS.prepare('INSERT INTO creation_ip(ip,day,count) VALUES(?,?,29)').bind(f.ip,new Date().toISOString().slice(0,10)).run();
  const outcomes = await Promise.all([f.prepare(first),f.prepare(second)]);
  expect(outcomes.map(value=>value.response.status).sort()).toEqual([200,429]);
  expect(outcomes.find(value=>value.response.status===429)?.body.error?.code).toBe('setup_creation_rate_limited');
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setup_allocations WHERE account_id=?').bind(f.account).first()).toEqual({n:1});
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({count:30});
});

it('counts retained allocation fences toward finite account ledger capacity', async () => {
  const f = await fixture(), ready = await f.prepare(await f.intent());
  const statements = Array.from({length:99},(_,i) => env.ACCOUNTS.prepare(`INSERT INTO account_setup_allocations
    SELECT service_origin,account_id,client_id,?,request_digest,credential_commitment,grant_id,intended_email,?,application_id,creator_ip,creation_day,created_at,created_at+1
    FROM account_setup_allocations WHERE page_id=?`).bind('retained-'+i,'a'.repeat(10)+String.fromCharCode(97+Math.floor(i/26),97+i%26),ready.body.pageId));
  await env.ACCOUNTS.batch(statements);
  const denied = await f.prepare(await f.intent()); expect(denied.response.status).toBe(429); expect(denied.body.error?.code).toBe('setup_ledger_full');
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({count:1});
  const listed = await (await f.request('/api/setup')).json() as {setups:SetupResult[]}; expect(listed.setups).toHaveLength(100);
});

it('fails closed on an incompatible account setup schema without synthesizing storage', async () => {
  const f = await fixture();
  await env.ACCOUNTS.prepare('UPDATE account_setup_schema SET revision=1').run();
  try {
    const denied = await f.prepare(await f.intent()); expect(denied.response.status).toBe(503); expect(denied.body.error?.code).toBe('setup_storage_unavailable');
    expect(await env.ACCOUNTS.prepare('SELECT revision FROM account_setup_schema').first()).toEqual({revision:1});
    expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toBeNull();
  } finally { await env.ACCOUNTS.prepare('UPDATE account_setup_schema SET revision=3').run(); }
});

it('requires verified identity before allocating and selects only currently verified email evidence', async () => {
  const f = await fixture({ verified:false }), intent = await f.intent(), denied = await f.prepare(intent);
  expect(denied.response.status).toBe(403); expect(denied.body.error?.code).toBe('owner_verification_required');
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind(f.account).first()).toEqual({ n:0 });
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toBeNull();
  await env.ACCOUNTS.prepare("INSERT INTO identity_emails(provider,subject,email) VALUES('google',?,?)").bind(f.account,'verified@example.test').run();
  const ready = await f.prepare(intent); expect(ready.body.state).toBe('ready');
  expect(await inDO(ready.body.pageId,t=>t.db.get('intended_owner',null))).toBe('verified@example.test');
});

it('separates OAuth account/client namespaces and preserves the anonymous creation boundary', async () => {
  const f = await fixture(), intent = await f.intent(), ready = await f.prepare(intent);
  const anotherAccount = await fixture(), anotherClient = await fixture({ account:f.account, client:'different-client', email:f.email });
  for (const caller of [anotherAccount,anotherClient]) expect((await caller.request('/api/setup?operationId='+intent.operationId)).status).toBe(404);
  expect((await f.request('/api/tendrils', { method:'POST',body:JSON.stringify({ owner:f.email }) })).status).toBe(400);
  const wrongOrigin = await f.request('/api/setup', { method:'POST',headers:{Origin:'https://evil.example'},body:JSON.stringify(setupRequest(intent)) });
  expect(wrongOrigin.status).toBe(403);
  expect((await f.prepare(intent)).body.pageId).toBe(ready.body.pageId);
});

it('requires existing configured and granted create scope; revocation, expiry and suspended/deleting accounts fail closed', async () => {
  const missing = await fixture({ scope:'tendrils:list' }); expect((await missing.prepare(await missing.intent())).response.status).toBe(403);
  for (const policy of ['revoked','expired','suspended','deleting'] as const) {
    const f = await fixture(), intent = await f.intent();
    if (policy === 'revoked') await env.ACCOUNTS.prepare('UPDATE integration_oauth_grants SET revoked_at=? WHERE id=?').bind(Date.now(),f.grant).run();
    if (policy === 'expired') await env.ACCOUNTS.prepare('UPDATE integration_oauth_access SET expires_at=0 WHERE grant_id=?').bind(f.grant).run();
    if (policy === 'suspended') await env.ACCOUNTS.prepare('UPDATE accounts SET suspended_at=? WHERE id=?').bind(Date.now(),f.account).run();
    if (policy === 'deleting') await env.ACCOUNTS.prepare('UPDATE accounts SET deleting_at=? WHERE id=?').bind(Date.now(),f.account).run();
    expect((await f.prepare(intent)).response.status).toBe(401);
    expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind(f.account).first()).toEqual({n:0});
  }
});

it('checks pause before allocation and a create-after-preflight race while retaining the original allocation', async () => {
  const f = await fixture(), intent = await f.intent();
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='creation_paused' WHERE id=1").run();
  try { expect((await f.prepare(intent)).response.status).toBe(503); }
  finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
  expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind(f.account).first()).toEqual({n:0});
  f.pauseAfterAdmission(); const paused = await f.prepare(intent); expect(paused.body.state).toBe('blocked');
  try { expect((await f.request('/api/setup?operationId='+intent.operationId)).status).toBe(200); }
  finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
  const ready = await f.prepare(intent); expect(ready.body.state).toBe('ready'); expect(ready.body.pageId).toBe(paused.body.pageId);
  await env.ACCOUNTS.prepare("UPDATE service_state SET mode='read_only' WHERE id=1").run();
  try { expect((await f.prepare(intent)).body.state).toBe('ready'); }
  finally { await env.ACCOUNTS.prepare("UPDATE service_state SET mode='open' WHERE id=1").run(); }
});

it('binds owner claim to the original account even when another account verifies the same email', async () => {
  const f = await fixture(), other = await fixture({ email:f.email }), ready = await f.prepare(await f.intent());
  const key = new URL(ready.body.page!.page_url).pathname.split('/')[2];
  const claim = (account: string) => stub(ready.body.pageId).fetch(new Request('https://tendril.internal/claim/owner',{
    method:'POST',headers:{'Content-Type':'application/json','x-tendril-key':key},body:JSON.stringify({ account_id:account,identities:[{provider:'google',login:'owner',emails:[f.email]}] }),
  }));
  expect((await claim(other.account)).status).toBe(403); expect((await claim(f.account)).status).toBe(200);
  expect(await inDO(ready.body.pageId,t=>t.db.get('owner_account',null))).toBe(f.account);
});

it('never recreates an expired, deleted, missing-journal or corrupt setup', async () => {
  for (const fault of ['expired','deleted','missing','corrupt'] as const) {
    const f = await fixture(), intent = await f.intent(), ready = await f.prepare(intent);
    if (fault==='expired') await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare('UPDATE account_setups SET expires_at=created_at+1 WHERE account_id=?').bind(f.account),
      env.ACCOUNTS.prepare('UPDATE account_setup_allocations SET expires_at=created_at+1 WHERE account_id=?').bind(f.account),
    ]);
    if (fault==='deleted') await inDO(ready.body.pageId, t=>t.destroy());
    if (fault==='missing') await inDO(ready.body.pageId,t=>t.db.del('account_setup'));
    if (fault==='corrupt') await env.ACCOUNTS.prepare("UPDATE account_setups SET request_json='{}' WHERE account_id=?").bind(f.account).run();
    const resumed = await f.prepare(intent);
    if(fault==='corrupt') { expect(resumed.response.status).toBe(409); expect(resumed.body.error?.code).toBe('reconciliation_required'); }
    else expect(resumed.body.state).toBe(fault==='expired'?'expired':'reconciliation_required');
    expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind(f.account).first()).toEqual({n:1});
  }
});

it('advertises and exercises MCP setup tools only for the existing create permission', async () => {
  const f = await fixture(), intent = await f.intent();
  const call = async (method: string, params: object = {}) => (await f.request('/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json() as Promise<any>;
  const catalog = (await call('tools/list')).result.tools;
  expect(catalog.find((tool:any)=>tool.name==='prepare_tendril_setup').inputSchema.properties).not.toHaveProperty('bindingToken');
  const reply = (await call('tools/call',{name:'prepare_tendril_setup',arguments:setupRequest(intent)})).result;
  expect(reply.isError).not.toBe(true); expect(reply.structuredContent.state).toBe('ready');
  expect((await call('tools/call',{name:'inspect_tendril_setup',arguments:{operationId:intent.operationId}})).result.structuredContent.pageId).toBe(reply.structuredContent.pageId);
});


it('does not allocate a second page when a committed setup loses its D1 operation row', async () => {
  for (const deleted of [false,true]) {
    const f = await fixture(), intent = await f.intent(), ready = await f.prepare(intent);
    if (deleted) {
      await inDO(ready.body.pageId,t=>t.destroy());
      // Released admission rows are eventually pruned; the independent witness must still fence reuse.
      await runInDurableObject(env.ADMISSION.get(env.ADMISSION.idFromName('global')),(_instance,state)=>
        state.storage.sql.exec('DELETE FROM creations WHERE id=?',ready.body.pageId).toArray());
    }
    await env.ACCOUNTS.prepare('DELETE FROM account_setups WHERE account_id=?').bind(f.account).run();
    const resumed = await f.prepare(intent);
    expect(resumed.body.error?.code ?? resumed.body.state).toBe('reconciliation_required');
    const pages = await env.ACCOUNTS.prepare('SELECT id FROM tendrils WHERE creator_ip=?').bind(f.ip).all();
    expect(pages.results).toEqual(deleted?[]:[{ id: ready.body.pageId }]);
    expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({ count:1 });
    expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setup_allocations WHERE account_id=?').bind(f.account).first()).toEqual({n:1});
  }
});

it('fences a missing allocation witness and detects retained page identity after journal/index loss',async()=>{
  for(const journalLost of [false,true]) {
    const f=await fixture(),intent=await f.intent(),ready=await f.prepare(intent);
    await env.ACCOUNTS.prepare('DELETE FROM account_setup_allocations WHERE account_id=?').bind(f.account).run();
    if(journalLost) await env.ACCOUNTS.batch([
      env.ACCOUNTS.prepare('DELETE FROM account_setups WHERE account_id=?').bind(f.account),
      env.ACCOUNTS.prepare('DELETE FROM tendrils WHERE id=?').bind(ready.body.pageId),
    ]);
    const resumed=await f.prepare(intent);
    expect(resumed.body.error?.code??resumed.body.state).toBe('reconciliation_required');
    expect(await inDO(ready.body.pageId,t=>t.db.one('SELECT COUNT(*) AS n FROM tokens'))).toEqual({n:1});
    expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({count:1});
  }
});

it('refuses deterministic allocation collisions and retired admission without charging setup quota',async()=>{
  for(const collision of ['page','admission']) {
    const f=await fixture(),intent=await f.intent(),pageId=await accountSetupPageId(ORIGIN,f.account,f.client,intent.operationId);
    if(collision==='page') {
      const response=await stub(pageId).fetch(new Request('https://tendril.internal/create',{method:'POST',headers:{'x-tendril-id':pageId,'Content-Type':'application/json'},body:JSON.stringify({owner:f.email,name:'Existing different page'})}));
      expect(response.status).toBe(201); await response.body?.cancel();
    } else {
      const admission=env.ADMISSION.get(env.ADMISSION.idFromName('global'));
      for(const action of ['reserve','release']) await (await admission.fetch(new Request('https://admission.internal/'+action,{method:'POST',headers:{'x-tendril-id':pageId}}))).body?.cancel();
    }
    const resumed=await f.prepare(intent);
    expect(resumed.body.error?.code).toBe('reconciliation_required');
    expect(await env.ACCOUNTS.prepare('SELECT COUNT(*) AS n FROM account_setups WHERE account_id=?').bind(f.account).first()).toEqual({n:0});
    expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toBeNull();
  }
});

it('does not reactivate admission retired during an incomplete setup',async()=>{
  const f=await fixture(),intent=await f.intent(); f.loseRequest();
  const pending=await f.prepare(intent);
  const admission=env.ADMISSION.get(env.ADMISSION.idFromName('global'));
  await (await admission.fetch(new Request('https://admission.internal/release',{method:'POST',headers:{'x-tendril-id':pending.body.pageId}}))).body?.cancel();
  const resumed=await f.prepare(intent);
  expect(resumed.body.state).toBe('reconciliation_required'); expect(resumed.body.code).toBe('setup_admission_retired');
  expect(await inDO(pending.body.pageId,t=>t.exists())).toBe(false);
  expect(await env.ACCOUNTS.prepare('SELECT count FROM creation_ip WHERE ip=?').bind(f.ip).first()).toEqual({count:1});
});

it('rechecks verified identity when owner sign-in races removal of the previously verified email', async () => {
  const f = await fixture(), ready = await f.prepare(await f.intent()), session = crypto.randomUUID();
  await env.ACCOUNTS.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)')
    .bind(await sha256Hex(session), f.account, Date.now(), Date.now()+60000).run();
  const key = new URL(ready.body.page!.page_url).pathname.split('/')[2];
  f.removeIdentityBeforeClaim();
  const response = await f.request('/auth/page?' + new URLSearchParams({ tendril: ready.body.pageId, key }),
    { headers: { Cookie: '__Host-tendriller=' + session } });
  expect(response.status).toBe(403);
  expect(await inDO(ready.body.pageId, t => t.db.get('owner_account', null))).toBeNull();
  expect(await env.ACCOUNTS.prepare('SELECT owner_account FROM tendrils WHERE id=?').bind(ready.body.pageId).first()).toEqual({ owner_account: null });
});
