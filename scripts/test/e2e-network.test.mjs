import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('local Worker port is explicit, consistent and rejects invalid values', () => {
  const moduleUrl = new URL('../e2e-network.mjs', import.meta.url).href;
  for (const [port, expected] of [[undefined, 8790], ['18891', 18891], ['0', null], ['65536', null], ['not-a-port', null]]) {
    const env = { ...process.env };
    if (port === undefined) delete env.TENDRILLER_E2E_PORT;
    else env.TENDRILLER_E2E_PORT = port;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {LOCAL_WORKER_PORT, LOCAL_WORKER_SERVICE} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify({port:LOCAL_WORKER_PORT,service:LOCAL_WORKER_SERVICE}));`], { env, encoding: 'utf8' });
    if (expected === null) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /TENDRILLER_E2E_PORT must be an integer port/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { port: expected, service: `https://service.localhost:${expected}` });
    }
  }
});

test('local Worker DNS retains host routing for Playwright readiness and API clients', { timeout: 45_000 }, async t => {
  // Process/compiler startup can compete with the full Node suite. The actual
  // HTTP readiness deadline remains five seconds below.
  const directory = await mkdtemp(join(tmpdir(), 'tendriller-e2e-network-'));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ host: request.headers.host, path: request.url });
    const hostname = request.headers.host?.split(':')[0];
    const valid = (hostname === 'service.localhost' && request.url === '/health') ||
      (hostname === 'aaaaaaaaaaaa.pages.localhost' && request.url === '/page');
    response.writeHead(valid ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ hostname, path: request.url }));
  });
  let child;
  t.after(async () => {
    child?.kill('SIGTERM');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const config = new URL('../../test/e2e/playwright.config.ts', import.meta.url).href;
  await writeFile(join(directory, 'probe.config.mjs'), `
import config from ${JSON.stringify(config)};
export default { ...config, testDir: ${JSON.stringify(directory)}, testMatch: 'probe.spec.mjs',
  use: {}, reporter: 'line', outputDir: ${JSON.stringify(join(directory, 'results'))},
  webServer: { ...config.webServer, cwd: ${JSON.stringify(directory)},
    url: 'http://service.localhost:${port}/health', reuseExistingServer: true, timeout: 5_000,
    // A ready server is already listening; failure to reach its actual HTTP
    // health endpoint must fail, rather than pass on a TCP-only port check.
    command: ${JSON.stringify(`"${process.execPath}" -e "process.exit(23)"`)} } };
`);
  await writeFile(join(directory, 'probe.spec.mjs'), `
import { test, expect } from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
test('retains service and page origins in Node API requests', async ({ request }) => {
  const service = await request.get('http://service.localhost:${port}/health');
  expect(service.status()).toBe(200);
  expect(await service.json()).toEqual({ hostname: 'service.localhost', path: '/health' });
  const page = await request.get('http://aaaaaaaaaaaa.pages.localhost:${port}/page');
  expect(page.status()).toBe(200);
  expect(await page.json()).toEqual({ hostname: 'aaaaaaaaaaaa.pages.localhost', path: '/page' });
});
`);
  const cli = fileURLToPath(new URL('../../node_modules/@playwright/test/cli.js', import.meta.url));
  const noProxy = [process.env.no_proxy, process.env.NO_PROXY, '.localhost', '127.0.0.1'].filter(Boolean).join(',');
  child = spawn(process.execPath, [cli, 'test', '--config', join(directory, 'probe.config.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy },
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', resolve);
  });
  child = undefined;
  assert.equal(code, 0, output);
  // One health request comes from the runner, another from the test worker.
  assert.ok(requests.filter(request => request.path === '/health').length >= 2);
  assert.ok(requests.some(request => request.host === `aaaaaaaaaaaa.pages.localhost:${port}` && request.path === '/page'));
});
