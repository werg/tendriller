import { readFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { absolutePath, httpsUrl, json, privateFile, writablePrivateDirectory, loadEnvironment, within, fail, CHRONOLOG_SOURCE } from './common.mjs';

function secret(value, length, code) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').length !== length || Buffer.from(value, 'base64').toString('base64') !== value) fail(code);
}
export async function verifyRelease(manifestPath, { signal } = {}) {
  absolutePath(manifestPath);
  const root = dirname(manifestPath), manifest = await json(manifestPath);
  if (manifest.format !== 'tendriller-assistant-release/v1' || !/^[a-f0-9]{40}$/u.test(manifest.core?.source ?? '') ||
      manifest.core.dirty !== false || manifest.chronolog?.source !== CHRONOLOG_SOURCE || manifest.chronolog.dirty !== false ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || !Object.keys(manifest.files).length ||
      Object.keys(manifest.files).length > 25000) fail('DEPLOYMENT_RELEASE_PROVENANCE_INVALID');
  for (const [name, expected] of Object.entries(manifest.files)) {
    signal?.throwIfAborted();
    const path = resolve(root, name);
    if (!within(root, path) || path === root || name.includes('..') || !/^[a-f0-9]{64}$/u.test(expected)) fail('DEPLOYMENT_RELEASE_PROVENANCE_INVALID');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || createHash('sha256').update(await readFile(path)).digest('hex') !== expected) fail('DEPLOYMENT_RELEASE_BYTES_CHANGED');
  }
  for (const required of ['integrations/chatgpt/run.mjs', 'integrations/chatgpt/integration.mjs', 'integrations/chatgpt/config.host-account.example.mjs',
    'bridge-template/session.mjs', 'bridge-template/bridge-session.mjs']) {
    if (!Object.hasOwn(manifest.files, required)) fail('DEPLOYMENT_RELEASE_INCOMPLETE');
  }
  return { coreSource: manifest.core.source, chronologSource: manifest.chronolog.source, files: Object.keys(manifest.files).length };
}

/** Readiness only: no command, consent, subscription, callback or provider trigger. */
export async function preflightConfig(config, { online = false, timeoutMs = 60000,
  kitchenDirectory = process.env.TENDRILLER_KITCHEN_DIR, manifestPath = process.env.TENDRILLER_RELEASE_MANIFEST,
  runtime = { node: process.versions.node, platform: process.platform, uid: process.getuid?.() },
  createIntegration = async value => (await import('../integration.mjs')).createIntegration(value) } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) fail('DEPLOYMENT_PREFLIGHT_DEADLINE_INVALID');
  const started = performance.now(), checks = [], controller = new AbortController(); let integration, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(Object.assign(Error('DEPLOYMENT_PREFLIGHT_DEADLINE'), { code: 'DEPLOYMENT_PREFLIGHT_DEADLINE' }));
  }, timeoutMs - Math.min(5000, Math.floor(timeoutMs / 4))); });
  const check = async (name, action) => {
    controller.signal.throwIfAborted();
    const details = await action(); controller.signal.throwIfAborted();
    checks.push({ name, status: 'passed', ...(details === undefined ? {} : { details }) });
  };
  const work = async () => {
    await check('runtime', () => {
      if (Number(runtime.node.split('.')[0]) < 24 || runtime.platform !== 'linux' || runtime.uid === 0 || runtime.uid === undefined) fail('DEPLOYMENT_LINUX_NODE24_NON_ROOT_REQUIRED');
      return { node: runtime.node, platform: runtime.platform, nonRoot: true };
    });
    await check('release', () => verifyRelease(manifestPath, { signal: controller.signal }));
    await check('configuration', () => {
      httpsUrl(config.resource, { resource: true });
      if (!['127.0.0.1', '::1'].includes(config.host ?? '127.0.0.1') || (config.port ?? 8788) !== 8788) fail('DEPLOYMENT_LOOPBACK_PORT_REQUIRED');
      if (!config.hostAccount || config.authorizeAccountAccess || config.authorizeOwner || config.auth || config.bridge || config.store) fail('DEPLOYMENT_HOST_ACCOUNT_CONFIGURATION_REQUIRED');
      httpsUrl(config.hostAccount.origin, { origin: true });
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(config.hostAccount.bridgeId ?? '') ||
          !/^[A-Za-z0-9_-]{43,256}$/u.test(config.hostAccount.bridgeSecret ?? '') ||
          !ArrayBuffer.isView(config.hostAccount.csrfKey) || config.hostAccount.csrfKey.byteLength < 32) fail('DEPLOYMENT_HOST_ACCOUNT_CONFIGURATION_REQUIRED');
      secret(config.storeKey, 32, 'DEPLOYMENT_DELIVERY_KEY_INVALID');
      if (!Array.isArray(config.applications) || !config.applications.length) fail('DEPLOYMENT_APPLICATIONS_REQUIRED');
      const ids = new Set();
      for (const app of config.applications) {
        if (!/^[a-f0-9]{64}$/u.test(app.id ?? '') || ids.has(app.id) || typeof app.pageId !== 'string' || !app.pageId ||
            typeof app.openSession !== 'function' || !['allowedQueries', 'allowedCommands', 'allowedEvents'].every(name =>
              Array.isArray(app[name]) && app[name].every(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(value)))) fail('DEPLOYMENT_APPLICATION_ALLOWLIST_INVALID');
        ids.add(app.id);
      }
    });
    await check('private-storage', async () => {
      absolutePath(config.storePath); await writablePrivateDirectory(dirname(config.storePath));
      absolutePath(kitchenDirectory); const directory = join(kitchenDirectory, '.tendriller');
      await writablePrivateDirectory(directory);
      for (const name of ['handle.json', 'descriptor.json', 'bridge-device.sqlite']) await privateFile(join(directory, name));
      try { await lstat(join(directory, 'device.sqlite')); fail('DEPLOYMENT_CREATOR_STORE_PRESENT'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const handle = await json(join(directory, 'handle.json')), descriptor = await json(join(directory, 'descriptor.json'));
      const app = config.applications.find(value => value.id === descriptor.payload?.applicationId);
      if (!app || handle.application?.id !== app.id || handle.id !== app.pageId ||
          new URL(handle.api).origin !== new URL(config.hostAccount.origin).origin) fail('DEPLOYMENT_APPLICATION_SCOPE_MISMATCH');
      return { dedicatedBridgeStore: true, applicationId: app.id };
    });
    if (online) {
      // The service must be stopped: this briefly owns the same native store.
      // Never start delivery observers or manufacture a test domain command.
      const creating = Promise.resolve(createIntegration({ ...config,
        applications: config.applications.map(app => ({ ...app, openSession: options => app.openSession({ ...options,
          signal: AbortSignal.any([controller.signal, ...[options?.signal].filter(Boolean)]) }) })) }));
      creating.then(value => { if (controller.signal.aborted) void value.close().catch(() => {}); }, () => {});
      integration = await creating;
      await check('host-account', async () => {
        if (typeof integration.account?.checkHostConfiguration !== 'function') fail('DEPLOYMENT_HOST_PREFLIGHT_UNAVAILABLE');
        const result = await integration.account.checkHostConfiguration({ signal: controller.signal });
        if (result?.authorizationServerReady !== true) fail('DEPLOYMENT_AUTHORIZATION_SERVER_NOT_READY');
        return { authorizationServerReady: true };
      });
      for (const app of config.applications) await check(`native:${app.id}`, async () => {
        const revision = await integration.bridge.readRevision(app.id);
        const result = await integration.bridge.getStatus(app.id), grant = result.grant;
        if (!grant?.reader || app.allowedCommands.length > 0 && !grant.writer ||
            ['coordinator', 'recovery', 'administrator', 'publisher'].some(name => grant[name])) fail('DEPLOYMENT_DEDICATED_BRIDGE_GRANT_REQUIRED');
        if (result.status?.phase !== 'ready') fail('DEPLOYMENT_NATIVE_PEER_NOT_READY');
        integration.bridge.assertSelection(app.id, revision);
        return { applicationId: app.id, deviceId: result.deviceId, generation: revision.generation, phase: result.status.phase,
          reader: true, writer: grant.writer === true, privileged: false };
      });
    }
    return { ready: true, scope: online ? 'host-and-native-readiness' : 'local-configuration', checks,
      humanAccountLinked: 'not-tested', liveChatGptVerified: false, liveWorkspaceAgentVerified: false };
  };
  try { return await Promise.race([work(), deadline]); }
  finally {
    controller.abort(); clearTimeout(timer);
    if (integration) {
      let closeTimer;
      try { await Promise.race([integration.close(), new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(Object.assign(Error('DEPLOYMENT_PREFLIGHT_CLOSE_TIMEOUT'), { code: 'DEPLOYMENT_PREFLIGHT_CLOSE_TIMEOUT' })), Math.max(1, Math.min(5000, timeoutMs - (performance.now() - started))));
      })]); } finally { clearTimeout(closeTimer); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A trusted configuration module may itself await I/O before its export is
  // available. The CLI has one hard one-minute boundary including cleanup.
  const hardDeadline = setTimeout(() => { console.error('DEPLOYMENT_PREFLIGHT_DEADLINE'); process.exit(1); }, 60000);
  let completed = false;
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, env: { type: 'string' }, online: { type: 'boolean', default: false } } });
    absolutePath(values.config); await privateFile(values.config);
    if (values.env) { absolutePath(values.env); await loadEnvironment(values.env); }
    const { default: config } = await import(pathToFileURL(values.config).href);
    console.log(JSON.stringify(await preflightConfig(config, { online: values.online, timeoutMs: 50000 })));
    completed = true;
  } catch (error) { console.error(JSON.stringify({ ready: false, code: error.code ?? 'DEPLOYMENT_PREFLIGHT_FAILED', liveChatGptVerified: false })); process.exitCode = 1; }
  finally { if (completed) clearTimeout(hardDeadline); else hardDeadline.unref(); }
}
