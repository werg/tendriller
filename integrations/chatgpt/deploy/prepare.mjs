import { randomBytes, generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { absolutePath, httpsUrl, json, fail, within, privateFile } from './common.mjs';

const scopes = new Set(['tendrils:list', 'tendrils:create', 'applications:read', 'applications:write', 'events:subscribe', 'pages:publish']);
const user = value => {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(value ?? '') || ['root', 'nobody'].includes(value)) fail('DEPLOYMENT_NON_ROOT_USER_REQUIRED');
  return value;
};
function service({ account, directory, writable, inaccessible, environment, command, preflight }) {
  return `[Unit]\nDescription=Tendriller retained ${preflight ? 'assistant bridge' : 'kitchen coordinator'}\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nUser=${account}\nGroup=${account}\nWorkingDirectory=${directory}\n${environment ? `EnvironmentFile=${environment}\n` : ''}Environment=NODE_ENV=production\n${preflight ? `ExecStartPre=${preflight}\n` : ''}ExecStart=${command}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nUMask=0077\nNoNewPrivileges=yes\nPrivateTmp=yes\nProtectSystem=strict\nProtectHome=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectKernelLogs=yes\nProtectControlGroups=yes\nLockPersonality=yes\nRestrictSUIDSGID=yes\nCapabilityBoundingSet=\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nReadWritePaths=${writable}\nInaccessiblePaths=-${inaccessible}\nLimitNOFILE=4096\nMemoryMax=1G\n\n[Install]\nWantedBy=multi-user.target\n`;
}

/** Generate reviewable files only. This does not install, start or deploy a service. */
export async function prepareDeployment(settings, output) {
  absolutePath(output);
  const allowed = new Set(['releaseDirectory', 'configurationDirectory', 'stateDirectory', 'coordinatorDirectory', 'sourceKitchenDirectory',
    'nodePath', 'serviceUser', 'coordinatorUser', 'resource', 'hostOrigin', 'bridgeId', 'bridgeSecretFile', 'oauthClient']);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(name => !allowed.has(name))) fail('DEPLOYMENT_SETTINGS_INVALID');
  const release = absolutePath(settings.releaseDirectory), configuration = absolutePath(settings.configurationDirectory);
  const state = absolutePath(settings.stateDirectory), coordinator = absolutePath(settings.coordinatorDirectory);
  const source = absolutePath(settings.sourceKitchenDirectory), node = absolutePath(settings.nodePath);
  const serviceUser = user(settings.serviceUser ?? 'tendriller-chatgpt'), coordinatorUser = user(settings.coordinatorUser ?? 'tendriller-kitchen');
  if (serviceUser === coordinatorUser || within(state, coordinator) || within(coordinator, state) ||
      within(release, state) || within(release, coordinator) || within(release, configuration) || within(release, output) ||
      within(coordinator, configuration) || within(configuration, coordinator) || within(state, configuration) || within(configuration, state) ||
      within(source, output)) fail('DEPLOYMENT_PRIVATE_STORAGE_MUST_BE_SEPARATE');
  const resource = httpsUrl(settings.resource, { resource: true }), hostOrigin = httpsUrl(settings.hostOrigin, { origin: true });
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(settings.bridgeId ?? '')) fail('DEPLOYMENT_BRIDGE_ID_INVALID');
  const client = settings.oauthClient;
  if (client && Object.keys(client).some(name => !['id', 'name', 'redirectUris', 'scopes', 'allowRefresh'].includes(name))) fail('DEPLOYMENT_CLIENT_SETTINGS_INVALID');
  if (!client || typeof client.id !== 'string' || !client.id || client.id.length > 256 || /\s/u.test(client.id) ||
      typeof client.name !== 'string' || !client.name || client.name.length > 160 ||
      !Array.isArray(client.redirectUris) || client.redirectUris.length < 1 || client.redirectUris.length > 8) fail('DEPLOYMENT_EXACT_CLIENT_REDIRECT_REQUIRED');
  const redirectUris = [...new Set(client.redirectUris.map(value => httpsUrl(value, { redirect: true })))];
  if (redirectUris.some(value => /REPLACE|YOUR_|PLACEHOLDER/iu.test(value))) fail('DEPLOYMENT_EXACT_CLIENT_REDIRECT_REQUIRED');
  if (!Array.isArray(client.scopes) || !client.scopes.length || client.scopes.some(value => !scopes.has(value)) ||
      client.allowRefresh !== undefined && typeof client.allowRefresh !== 'boolean') fail('DEPLOYMENT_CLIENT_SCOPES_REQUIRED');
  const handlePath = join(source, '.tendriller', 'handle.json'), descriptorPath = join(source, '.tendriller', 'descriptor.json');
  await privateFile(handlePath); await privateFile(descriptorPath);
  const handle = await json(handlePath), descriptor = await json(descriptorPath);
  const applicationId = descriptor?.payload?.applicationId;
  if (!/^[a-f0-9]{64}$/u.test(applicationId ?? '') || handle.application?.id !== applicationId ||
      typeof handle.id !== 'string' || !handle.id || new URL(handle.api).origin !== hostOrigin) fail('DEPLOYMENT_APPLICATION_SCOPE_MISMATCH');
  let bridgeSecret;
  if (settings.bridgeSecretFile) {
    absolutePath(settings.bridgeSecretFile); await privateFile(settings.bridgeSecretFile);
    bridgeSecret = (await readFile(settings.bridgeSecretFile, 'utf8')).trim();
  } else bridgeSecret = randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{43,256}$/u.test(bridgeSecret)) fail('DEPLOYMENT_BRIDGE_SECRET_INVALID');
  const managementCallback = new URL('/connections/callback', resource).href;
  const oauth = { resource, clients: [{ id: client.id, name: client.name, redirectUris,
    scopes: [...new Set(client.scopes)], tokenEndpointAuthMethod: 'none', allowRefresh: client.allowRefresh === true }],
    bridges: [{ id: settings.bridgeId, name: 'Tendriller retained assistant bridge',
      secretSha256: createHash('sha256').update(bridgeSecret).digest('hex'), applicationIds: [applicationId],
      managementRedirectUris: [managementCallback] }], accessTokenTtlSeconds: 300, grantTtlSeconds: 604800 };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const jwk = { ...privateKey.export({ format: 'jwk' }), kid: `tendriller-${randomUUID()}`, alg: 'RS256', use: 'sig', key_ops: ['sign'] };
  const environment = {
    TENDRILLER_HOST_ORIGIN: hostOrigin, TENDRILLER_BRIDGE_ID: settings.bridgeId, TENDRILLER_BRIDGE_SECRET: bridgeSecret,
    TENDRILLER_MCP_RESOURCE: resource, TENDRILLER_KITCHEN_DIR: join(state, 'kitchen'),
    TENDRILLER_DELIVERY_DB: join(state, 'delivery.sqlite'), TENDRILLER_DELIVERY_KEY: randomBytes(32).toString('base64'),
    TENDRILLER_MANAGEMENT_CSRF_KEY: randomBytes(32).toString('base64'),
    TENDRILLER_RELEASE_MANIFEST: join(release, 'RELEASE.json'),
  };
  // Exclusive output creation prevents a retry from silently rotating keys.
  await mkdir(output, { mode: 0o700 });
  for (const name of ['private', 'systemd']) await mkdir(join(output, name), { mode: 0o700 });
  const put = (name, text) => writeFile(join(output, name), text, { mode: 0o600, flag: 'wx', flush: true });
  await put('private/service.env', Object.entries(environment).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n');
  await put('private/integration.config.mjs', `export { default } from ${JSON.stringify(pathToFileURL(join(release, 'integrations/chatgpt/config.host-account.example.mjs')).href)};\n`);
  await put('private/bridge-secret.txt', bridgeSecret + '\n');
  await put('private/host-oauth-config.json', JSON.stringify(oauth, null, 2) + '\n');
  await put('private/host-signing-jwk.json', JSON.stringify(jwk, null, 2) + '\n');
  const cli = join(release, 'integrations/chatgpt');
  await put('systemd/tendriller-chatgpt.service', service({ account: serviceUser, directory: release, writable: state,
    inaccessible: coordinator, environment: join(configuration, 'service.env'),
    preflight: `${node} ${cli}/deploy/preflight.mjs --config ${configuration}/integration.config.mjs`,
    command: `${node} ${cli}/run.mjs --config ${configuration}/integration.config.mjs` }));
  await put('systemd/tendriller-kitchen.service', service({ account: coordinatorUser, directory: coordinator,
    writable: coordinator, inaccessible: state, command: `${node} ${coordinator}/session.mjs` }));
  await put('Caddyfile', `${new URL(resource).host} {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:8788\n}\n`);
  const deployment = { format: 'tendriller-assistant-deployment/v1', applicationId, pageId: handle.id,
    releaseDirectory: release, configurationDirectory: configuration, stateDirectory: state, coordinatorDirectory: coordinator,
    sourceKitchenDirectory: source, serviceUser, coordinatorUser, nodePath: node, resource, hostOrigin, bridgeId: settings.bridgeId,
    managementCallback, clientId: client.id, clientRedirectUris: redirectUris, liveChatGptVerified: false };
  await put('deployment.json', JSON.stringify(deployment, null, 2) + '\n');
  await put('HANDOFF.md', `# Prepared Tendriller service\n\nThese files are prepared, not deployed. Live ChatGPT and Workspace acceptance remain unverified.\n\nApplication: \`${applicationId}\` · page: \`${handle.id}\`\n\nMCP resource: ${resource}\nHost issuer: ${hostOrigin}\nConnection management: ${new URL('/connections', resource).href}\nManagement callback: ${managementCallback}\nClient ID: \`${client.id}\`\nExact client redirect URIs:\n\n${redirectUris.map(value => '- ' + value).join('\n')}\n\n## Private installation\n\nFollow the deployment README in the release. Install the two services under distinct non-root users: \`${serviceUser}\` and \`${coordinatorUser}\`. Keep the creator project at \`${coordinator}\`, the dedicated bridge project at \`${state}/kitchen\`, and the encrypted delivery database at \`${state}/delivery.sqlite\`. Stop both source participants before moving their stores. Stage only the dedicated bridge store; the assistant service must never receive the creator signer.\n\nInstall the private environment/configuration under \`${configuration}\` with root ownership and read access only for the assistant service group. Preserve these generated keys with the delivery database across restart. Never rerun preparation as a key rotation.\n\nSet the selected host environment's OAUTH_CONFIG_JSON from \`private/host-oauth-config.json\` and OAUTH_SIGNING_JWK from \`private/host-signing-jwk.json\` using its secret manager. Merge other reviewed client/bridge entries deliberately if the host already has OAuth configuration; do not overwrite them blindly. The signing private JWK belongs only in the host's secret store, not on the Node bridge. The actual client callback URIs above must match the intended ChatGPT client.\n\nVerify the Caddy configuration, DNS and HTTPS before linking the resource. Caddy proxies only to loopback port 8788. Enable the coordinator before checking native readiness. Run preflight with \`--online\` while the assistant service is stopped; it briefly owns that same bridge device and closes it. Then start the assistant service. The owner must sign in at the management page and select exact application consent.\n\nRecord an actual subscription challenge, event receipt, assistant turn, signed reply and page read separately. A ready process, valid OAuth configuration or accepted webhook does not prove that journey.\n`);
  await put('READY.json', JSON.stringify({ format: deployment.format, applicationId, resource, prepared: true, deployed: false }) + '\n');
  return { output, applicationId, resource, prepared: true, deployed: false, liveChatGptVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { settings: { type: 'string' }, output: { type: 'string' } } });
    if (!values.settings || !values.output) fail('Usage: prepare.mjs --settings /private/settings.json --output /private/new-bundle');
    absolutePath(values.settings); await privateFile(values.settings);
    console.log(JSON.stringify(await prepareDeployment(await json(values.settings), values.output)));
  } catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
}
