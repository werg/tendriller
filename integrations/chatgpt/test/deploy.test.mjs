import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPrivateKey } from 'node:crypto';
import { prepareDeployment } from '../deploy/prepare.mjs';

const applicationId = 'a'.repeat(64);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-deploy-'));
  const source = join(directory, 'source'); await mkdir(join(source, '.tendriller'), { recursive: true, mode: 0o700 });
  await writeFile(join(source, '.tendriller', 'handle.json'), JSON.stringify({ id: 'page-one', api: 'https://host.test/api/tendrils/page-one',
    token: 'PRIVATE_PAGE_HANDLE', page_url: 'https://pages.host.test/p/page-one', application: { id: applicationId } }), { mode: 0o600 });
  await writeFile(join(source, '.tendriller', 'descriptor.json'), JSON.stringify({ payload: { applicationId } }), { mode: 0o600 });
  const settings = { sourceKitchenDirectory: source, releaseDirectory: '/opt/tendriller-chatgpt/releases/exact',
    configurationDirectory: '/etc/tendriller-chatgpt', stateDirectory: '/var/lib/tendriller-chatgpt',
    coordinatorDirectory: '/var/lib/tendriller-kitchen/project', nodePath: process.execPath,
    resource: 'https://assistant.test/mcp', hostOrigin: 'https://host.test', bridgeId: 'kitchen-one',
    oauthClient: { id: 'configured-chatgpt-client', name: 'ChatGPT', redirectUris: ['https://chatgpt.com/aip/example/oauth/callback'],
      scopes: ['tendrils:list', 'applications:read', 'applications:write', 'events:subscribe'], allowRefresh: true } };
  return { directory, source, settings, output: join(directory, 'prepared'), close: () => rm(directory, { recursive: true, force: true }) };
}

test('deployment preparation generates private exact-scope credentials and distinct non-root services', async () => {
  const f = await fixture();
  try {
    const result = await prepareDeployment(f.settings, f.output);
    assert.equal(result.prepared, true); assert.equal(result.deployed, false); assert.equal(result.liveChatGptVerified, false);
    const secret = (await readFile(join(f.output, 'private/bridge-secret.txt'), 'utf8')).trim();
    const oauth = JSON.parse(await readFile(join(f.output, 'private/host-oauth-config.json'), 'utf8'));
    assert.equal(oauth.bridges[0].secretSha256, createHash('sha256').update(secret).digest('hex'));
    assert.deepEqual(oauth.bridges[0].applicationIds, [applicationId]);
    assert.deepEqual(oauth.bridges[0].managementRedirectUris, ['https://assistant.test/connections/callback']);
    assert.deepEqual(oauth.clients[0].redirectUris, f.settings.oauthClient.redirectUris);
    assert.equal(oauth.clients[0].tokenEndpointAuthMethod, 'none');
    const jwk = JSON.parse(await readFile(join(f.output, 'private/host-signing-jwk.json'), 'utf8'));
    assert.equal(jwk.alg, 'RS256'); assert.equal(createPrivateKey({ key: jwk, format: 'jwk' }).asymmetricKeyDetails.modulusLength, 3072);
    const environment = await readFile(join(f.output, 'private/service.env'), 'utf8');
    assert.match(environment, /TENDRILLER_BRIDGE_SECRET=/); assert.doesNotMatch(environment, /PRIVATE_PAGE_HANDLE|"d"/);
    assert.equal((await stat(join(f.output, 'private/service.env'))).mode & 0o777, 0o600);
    const bridge = await readFile(join(f.output, 'systemd/tendriller-chatgpt.service'), 'utf8');
    const coordinator = await readFile(join(f.output, 'systemd/tendriller-kitchen.service'), 'utf8');
    assert.match(bridge, /User=tendriller-chatgpt\n/); assert.match(coordinator, /User=tendriller-kitchen\n/);
    assert.match(bridge, /ProtectSystem=strict/); assert.match(bridge, /InaccessiblePaths=-\/var\/lib\/tendriller-kitchen\/project/);
    assert.match(coordinator, /InaccessiblePaths=-\/var\/lib\/tendriller-chatgpt/);
    const handoff = await readFile(join(f.output, 'HANDOFF.md'), 'utf8');
    assert.ok(!handoff.includes(secret)); assert.ok(!handoff.includes(jwk.d)); assert.ok(!JSON.stringify(result).includes(secret));
    await assert.rejects(prepareDeployment(f.settings, f.output), { code: 'EEXIST' });
    assert.equal(await readFile(join(f.output, 'private/service.env'), 'utf8'), environment);
  } finally { await f.close(); }
});

test('preparation refuses guessed redirects, permissive scopes, root runtime and unsafe paths', async () => {
  const f = await fixture();
  try {
    for (const settings of [
      { ...f.settings, oauthClient: { ...f.settings.oauthClient, redirectUris: [] } },
      { ...f.settings, oauthClient: { ...f.settings.oauthClient, redirectUris: ['https://REPLACE_WITH_ACTUAL_CALLBACK/'] } },
      { ...f.settings, oauthClient: { ...f.settings.oauthClient, redirectUris: ['https://client.test/*'] } },
      { ...f.settings, oauthClient: { ...f.settings.oauthClient, scopes: ['*'] } },
      { ...f.settings, serviceUser: 'root' },
      { ...f.settings, coordinatorDirectory: '/var/lib/tendriller-chatgpt/creator' },
      { ...f.settings, configurationDirectory: '/etc/injected\nExecStart=/bin/sh' },
      { ...f.settings, hostOrigin: 'https://other.test' },
    ]) await assert.rejects(prepareDeployment(settings, f.output), /DEPLOYMENT_/);
    await assert.rejects(stat(f.output), { code: 'ENOENT' });
  } finally { await f.close(); }
});
