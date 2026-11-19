import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPrivateKey } from 'node:crypto';
import { prepareDeployment } from '../deploy/prepare.mjs';
import { preflightConfig, verifyRelease } from '../deploy/preflight.mjs';
import { CHRONOLOG_SOURCE } from '../deploy/common.mjs';
import { stageBridge } from '../deploy/stage-bridge.mjs';

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

async function preflightFixture() {
  const f = await fixture(), release = join(f.directory, 'release'), files = {};
  for (const name of ['integrations/chatgpt/run.mjs', 'integrations/chatgpt/integration.mjs', 'integrations/chatgpt/config.host-account.example.mjs',
    'bridge-template/session.mjs', 'bridge-template/bridge-session.mjs']) {
    const path = join(release, name); await mkdir(join(path, '..'), { recursive: true });
    const text = '// synthetic release file for preflight contract test\n';
    await writeFile(path, text); files[name] = createHash('sha256').update(text).digest('hex');
  }
  const manifestPath = join(release, 'RELEASE.json');
  await writeFile(manifestPath, JSON.stringify({ format: 'tendriller-assistant-release/v1',
    core: { source: 'b'.repeat(40), dirty: false }, chronolog: { source: CHRONOLOG_SOURCE, dirty: false }, files }));
  for (const name of ['session.mjs', 'bridge-session.mjs']) await writeFile(join(f.source, name), await readFile(join(release, 'bridge-template', name)));
  await writeFile(join(f.source, 'STAGED.json'), JSON.stringify({ format: 'tendriller-bridge-stage/v1', staged: true,
    applicationId, publicKey: 'c'.repeat(64), coreSource: 'b'.repeat(40), chronologSource: CHRONOLOG_SOURCE }), { mode: 0o600 });
  await writeFile(join(f.source, '.tendriller/bridge-device.sqlite'), 'synthetic local-only store marker', { mode: 0o600 });
  const state = join(f.directory, 'state'); await mkdir(state, { mode: 0o700 });
  const config = { resource: f.settings.resource, host: '127.0.0.1', port: 8788,
    hostAccount: { origin: f.settings.hostOrigin, bridgeId: 'kitchen-one', bridgeSecret: 'b'.repeat(43), csrfKey: Buffer.alloc(32, 1) },
    storePath: join(state, 'delivery.sqlite'), storeKey: Buffer.alloc(32, 2).toString('base64'),
    applications: [{ id: applicationId, pageId: 'page-one', openSession: async () => { throw Error('not used by test adapter'); },
      allowedQueries: ['assistanceStatus'], allowedCommands: ['replyToAssistance'], allowedEvents: ['assistant.help_requested'] }] };
  const options = { manifestPath, kitchenDirectory: f.source, runtime: { node: '24.0.0', platform: 'linux', uid: 1000 } };
  return { ...f, release, config, options };
}

test('offline preflight verifies exact release bytes and private paths without account or native I/O', async () => {
  const f = await preflightFixture(); let opened = 0;
  try {
    const createIntegration = async () => { opened++; throw Error('unexpected online operation'); };
    const result = await preflightConfig(f.config, { ...f.options, createIntegration });
    assert.equal(result.ready, true); assert.equal(result.scope, 'local-configuration');
    assert.equal(result.liveChatGptVerified, false); assert.equal(result.humanAccountLinked, 'not-tested'); assert.equal(opened, 0);
    await writeFile(join(f.source, 'session.mjs'), 'changed staged application');
    await assert.rejects(preflightConfig(f.config, { ...f.options, createIntegration }), /STAGED_RUNTIME_BYTES_CHANGED/);
    await writeFile(join(f.release, 'integrations/chatgpt/run.mjs'), 'changed');
    await assert.rejects(verifyRelease(f.options.manifestPath), /RELEASE_BYTES_CHANGED/);
    await assert.rejects(preflightConfig(f.config, { ...f.options, runtime: { ...f.options.runtime, uid: 0 } }), /NON_ROOT_REQUIRED/);
  } finally { await f.close(); }
});

test('online preflight checks current host and least-privilege native readiness and always closes', async () => {
  const f = await preflightFixture(); let closed = 0, reads = 0;
  const revision = { applicationId, generation: 'selected' };
  const integration = { account: { checkHostConfiguration: async () => ({ authorizationServerReady: true }) },
    bridge: { readRevision: async () => { reads++; return revision; }, getStatus: async () => ({ deviceId: 'c'.repeat(64), status: { phase: 'ready' },
      grant: { reader: true, writer: true, coordinator: false, recovery: false, administrator: false, publisher: false } }),
      assertSelection: (id, value) => { assert.equal(id, applicationId); assert.equal(value, revision); } },
    start() { throw Error('Preflight must not start delivery'); }, close: async () => { closed++; } };
  try {
    const options = { ...f.options, online: true, createIntegration: async () => integration };
    const result = await preflightConfig(f.config, options);
    assert.equal(result.scope, 'host-and-native-readiness'); assert.equal(result.liveWorkspaceAgentVerified, false);
    assert.equal(closed, 1); assert.equal(reads, 1);
    integration.bridge.getStatus = async () => ({ status: { phase: 'ready' }, grant: { reader: true, writer: true, publisher: true } });
    await assert.rejects(preflightConfig(f.config, options), /DEDICATED_BRIDGE_GRANT_REQUIRED/);
    assert.equal(closed, 2);
    integration.account.checkHostConfiguration = async () => ({ authorizationServerReady: false });
    await assert.rejects(preflightConfig(f.config, options), /AUTHORIZATION_SERVER_NOT_READY/);
    assert.equal(closed, 3); assert.equal(reads, 2);
  } finally { await f.close(); }
});

test('online preflight has a bounded cancellation path and does not leave the integration open', async () => {
  const f = await preflightFixture(); let closed = false, aborted = false;
  try {
    await assert.rejects(preflightConfig(f.config, { ...f.options, online: true, timeoutMs: 1000,
      createIntegration: async () => ({ account: { checkHostConfiguration: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(Error('stopped')); }, { once: true });
      }) }, close: async () => { closed = true; } }) }), /PREFLIGHT_DEADLINE/);
    assert.equal(aborted, true); assert.equal(closed, true);
  } finally { await f.close(); }
});

test('staging snapshots the verified native bridge identity without creator or bootstrap secrets',
  { skip: !process.env.CHRONOLOG_SESSION_PACKAGE, timeout: 60000 }, async () => {
    const { loadNativePackage } = await import('./native-fixture.mjs');
    const { cp, chmod, readdir } = await import('node:fs/promises');
    const { native, packagePath } = await loadNativePackage();
    const f = await preflightFixture();
    try {
      const privateDirectory = join(f.source, '.tendriller'), sourceDatabase = join(privateDirectory, 'bridge-device.sqlite');
      await rm(sourceDatabase);
      const device = await native.openNativeDevice({ path: sourceDatabase, create: true });
      const publicKey = device.identity.publicKey; await device.close(); await chmod(sourceDatabase, 0o600);
      await writeFile(join(privateDirectory, 'device.sqlite'), 'CREATOR SIGNER MUST NOT BE COPIED', { mode: 0o600 });
      await writeFile(join(privateDirectory, 'initial-input.json'), '{"epochKey":"BOOTSTRAP KEY MUST NOT BE COPIED"}', { mode: 0o600 });
      const template = join(f.release, 'bridge-template');
      for (const name of ['domain.mjs', 'projection.mjs', 'local.mjs', 'private-records.mjs']) await writeFile(join(template, name), '// synthetic runtime fixture\n');
      await writeFile(join(template, 'package.json'), '{"type":"module"}\n');
      const scope = join(template, 'node_modules/@chronolog'); await mkdir(scope, { recursive: true });
      await cp(packagePath, join(scope, 'peer-session'), { recursive: true });
      await mkdir(join(template, 'node_modules/@tendriller/core'), { recursive: true });
      await writeFile(join(template, 'node_modules/@tendriller/core/package.json'), '{"name":"@tendriller/core","type":"module"}\n');
      const manifest = JSON.parse(await readFile(f.options.manifestPath, 'utf8'));
      async function inventory(directory, prefix = '') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name), name = prefix + entry.name;
          if (entry.isDirectory()) await inventory(path, name + '/');
          else if (entry.isFile() && name !== 'RELEASE.json') manifest.files[name] = createHash('sha256').update(await readFile(path)).digest('hex');
        }
      }
      await inventory(f.release); await writeFile(f.options.manifestPath, JSON.stringify(manifest));
      const destination = join(f.directory, 'bridge');
      await assert.rejects(stageBridge({ source: f.source, release: f.release, destination, expectedBridgeKey: publicKey }), /STOP_SOURCE_DEVICE_FIRST/);
      const result = await stageBridge({ source: f.source, release: f.release, destination, expectedBridgeKey: publicKey, sourceStopped: true });
      assert.equal(result.publicKey, publicKey); assert.equal(result.staged, true); assert.equal(result.deployed, false);
      const copied = await native.openNativeDevice({ path: join(destination, '.tendriller/bridge-device.sqlite') });
      assert.equal(copied.identity.publicKey, publicKey); await copied.close();
      assert.deepEqual((await readdir(join(destination, '.tendriller'))).filter(name => !name.startsWith('bridge-device.sqlite')).sort(), ['descriptor.json', 'handle.json']);
      await assert.rejects(stat(join(destination, '.tendriller/device.sqlite')), { code: 'ENOENT' });
      await assert.rejects(stat(join(destination, '.tendriller/initial-input.json')), { code: 'ENOENT' });
      await assert.rejects(stageBridge({ source: f.source, release: f.release, destination: join(f.directory, 'wrong'),
        expectedBridgeKey: '0'.repeat(64), sourceStopped: true }), /BRIDGE_IDENTITY_MISMATCH/);
      await assert.rejects(stat(join(f.directory, 'wrong/STAGED.json')), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
