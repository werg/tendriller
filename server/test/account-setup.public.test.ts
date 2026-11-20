import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/env';
import { route } from '../src/router';
import { oauthConfig, signAccessToken } from '../src/accounts/oauth-support';
import { sha256Hex } from '../src/ids';
import { inDO, stub } from './helpers';
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
  let loseInitializationReply = false, pauseAfterAdmission = false;
  settings.TENDRIL = { idFromName: name => transport.idFromName(name), get(id) {
    const object = transport.get(id);
    return { async fetch(request: Request) {
      const pageId = request.headers.get('x-tendril-id');
      if (pageId) await inDO(pageId, t => { t.env.OAUTH_CONFIG_JSON = settings.OAUTH_CONFIG_JSON; t.env.OAUTH_SIGNING_JWK = signing; });
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
      if (pauseAfterAdmission) { pauseAfterAdmission = false; await env.ACCOUNTS.prepare("UPDATE service_state SET mode='creation_paused' WHERE id=1").run(); }
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
    loseReply: () => { loseInitializationReply = true; }, pauseAfterAdmission: () => { pauseAfterAdmission = true; } };
}

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
    if (fault==='expired') await env.ACCOUNTS.prepare('UPDATE account_setups SET expires_at=created_at+1 WHERE account_id=?').bind(f.account).run();
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
