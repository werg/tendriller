import { readFileSync } from "node:fs";
import { parseArgs } from 'node:util';
import { describeReadiness, requireService, requireServiceOrigin } from "../contract/client.mjs";
import { deploymentConvergence } from './deployment-convergence.mjs';
import { CORE_RELEASE } from '../contract/index.mjs';
// Smoke check the public endpoints after each deployment.
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  assistant: { type: 'boolean' }, 'source-commit': { type: 'string' }, 'composition-id': { type: 'string' },
  'runtime-id': { type: 'string' }, 'core-release': { type: 'string' },
} });
if (positionals.length !== 1) throw Error('Usage: node scripts/check-deployment.mjs https://service-host [--assistant] [--source-commit SHA --composition-id SHA256] [--runtime-id SHA256 --core-release VERSION]');
const base = requireServiceOrigin(positionals[0]), assistant = Boolean(values.assistant);
const runtime = JSON.parse(readFileSync(new URL('../server/src/runtime-release.json', import.meta.url)));
const expected = { coreRelease: values['core-release'] ?? CORE_RELEASE, runtimeId: values['runtime-id'] ?? runtime.id,
  sourceCommit: values['source-commit'], compositionId: values['composition-id'] };
if (Boolean(expected.sourceCommit) !== Boolean(expected.compositionId) ||
    expected.sourceCommit && !/^[a-f0-9]{40}$/.test(expected.sourceCommit) ||
    expected.compositionId && !/^[a-f0-9]{64}$/.test(expected.compositionId))
  throw Error('Supply both an exact source commit and complete composition ID for deployment attestation.');
if (expected.coreRelease !== CORE_RELEASE || expected.runtimeId !== runtime.id)
  throw Error('The smoke checkout does not match the expected release/runtime identity.');
function checkBuild(build, label) {
  if (build?.coreRelease !== expected.coreRelease || build?.runtimeId !== expected.runtimeId ||
      expected.sourceCommit && build?.sourceCommit !== expected.sourceCommit ||
      expected.compositionId && build?.compositionId !== expected.compositionId)
    throw Error(`${label} does not match the expected source/release/runtime/composition identity.`);
}

async function get(path, headers, expectedStatus) {
  let error;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(new URL(path, base), { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok && response.status !== expectedStatus) throw new Error(`${path}: HTTP ${response.status}`);
      return response;
    } catch (cause) {
      error = cause;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw error;
}

const health = await (await get("/health")).json();
if (health?.ok !== true) throw new Error("Health response did not report ok: true");
const readiness = await deploymentConvergence(async () => {
  const value = await describeReadiness(base, { signal: AbortSignal.timeout(15_000) });
  if (value.mode === 'unavailable' || value.environment?.id !== base)
    throw Error('Readiness is unavailable or identifies a different deployment environment.');
  checkBuild(value.build, 'Readiness'); return value;
});
const status = await (await get("/status")).text();
if (!/Operational|New page creation paused|Read-only or unavailable/.test(status))
  throw new Error("Service status did not read the account database");
// A static health response and D1 read can pass after the account-wide Durable
// Object storage quota is exhausted. Touch one nonexistent, fixed Tendril so
// its SQLite-backed namespace must complete a real read before deployment is
// reported healthy. The missing tendril is the expected result.
// A code update can briefly return 500 while the object restarts. Apply the
// same bounded read retries as the other probes; persistent storage failures
// still block deployment, and only the exact missing-object response passes.
const objectResponse = await get("/api/t/aaaaaaaaaaaa", undefined, 404);
const objectResult = await objectResponse.json().catch(() => null);
if (objectResponse.status !== 404 || objectResult?.error?.message !== "No such tendril") {
  throw new Error(`Durable Object storage readiness failed: HTTP ${objectResponse.status}`);
}
const guide = await (await get("/agent.md")).text();
if (!guide.includes("Tendriller")) throw new Error("Agent guide is missing or incomplete");
const landing = await (await get('/')).text();
if (!landing.includes(`${base}/docs/BUILD_AN_APP.md`)) throw new Error('Homepage is missing the first-app entry point');
const descriptor = await (await get('/api/service')).json();
requireService(descriptor);
if (descriptor.core_release !== expected.coreRelease) throw Error('Service descriptor release does not match the expected build.');
const onboarding = await (await get('/.well-known/tendriller.json')).json();
if (onboarding.serviceOrigin !== base || onboarding.interfaces?.readiness !== `${base}/api/readiness` ||
    onboarding.start_here !== `${base}/docs/BUILD_AN_APP.md` ||
    onboarding.starter !== `${base}/downloads/tendriller-first-app.tgz` ||
    onboarding.capabilities !== `${base}/.well-known/tendriller-capabilities.json`)
  throw new Error('Onboarding navigation must target this deployment');
const capabilityResponse = await get('/.well-known/tendriller-capabilities.json');
if (!capabilityResponse.headers.get('content-type')?.includes('application/json'))
  throw new Error('Capability discovery must be readable JSON');
const catalog = await capabilityResponse.json();
if (catalog.schema_version !== 1 || catalog.contract !== descriptor.contract ||
    catalog.core_release !== descriptor.core_release || catalog.device_permissions_probed !== false ||
    catalog.guide !== `${base}/docs/CAPABILITIES.md` || catalog.starter !== onboarding.starter ||
    !Array.isArray(catalog.capabilities))
  throw new Error('Capability discovery must match this deployment without probing device permissions');
const capabilityIds = new Set();
const documents = new Set(['/AGENTS.md', '/llms.txt', '/llms-full.txt', '/docs/BUILD_AN_APP.md',
  '/docs/CAPABILITIES.md', '/docs/SESSION_BOOTSTRAP.md', '/docs/TROUBLESHOOTING.md']);
for (const entry of catalog.capabilities) {
  if (typeof entry.id !== 'string' || capabilityIds.has(entry.id) ||
      typeof entry.owner !== 'string' || !entry.owner || typeof entry.availability !== 'string' ||
      !Array.isArray(entry.imports) || !entry.imports.length ||
      !Array.isArray(entry.api) || !entry.api.length ||
      !Array.isArray(entry.keywords) || !entry.keywords.length ||
      typeof entry.example !== 'string' || !entry.example || typeof entry.boundary !== 'string' || !entry.boundary)
    throw new Error('Capability discovery is missing unique task mappings, APIs or ownership boundaries');
  capabilityIds.add(entry.id);
  const guideUrl = new URL(entry.guide);
  if (guideUrl.origin !== base || guideUrl.username || guideUrl.password || guideUrl.search || guideUrl.hash ||
      !/^\/docs\/(?:tools\/)?[A-Z0-9_-]+\.md$/.test(guideUrl.pathname))
    throw new Error(`Capability ${entry.id} guide must target this deployment`);
  documents.add(guideUrl.pathname);
}
for (const id of ['durable-state', 'sql-transactions', 'reactive-view', 'operation-state', 'signals',
  'reviewed-evidence', 'camera', 'sensor-observation', 'voice', 'preview', 'credential-protected-inference',
  'agent-runtime', 'signed-publication'])
  if (!capabilityIds.has(id)) throw new Error(`Capability discovery is missing ${id}`);
for (const path of documents) {
  const response = await get(path);
  if (!(response.headers.get('content-type') || '').match(/text\/(markdown|plain)/))
    throw new Error(`${path}: expected a readable public guide`);
  if (!(await response.text()).trim()) throw new Error(`${path}: empty onboarding guide`);
}
const starter = await get('/downloads/tendriller-first-app.tgz');
if (!starter.headers.get('content-disposition')?.startsWith('attachment;'))
  throw new Error('The first-app archive must be a download');
const archive = new Uint8Array(await starter.arrayBuffer());
if (archive[0] !== 0x1f || archive[1] !== 0x8b) throw new Error('First-app download is not a gzip archive');

// Browser Integrity Check can reject ordinary automated clients before this
// Worker runs. Keep Python's default urllib user agent in the live smoke test.
const automated = await get("/api/service", { "User-Agent": "Python-urllib/3.12" });
if (!(automated.headers.get("content-type") || "").includes("application/json")) {
  throw new Error("Automated clients are blocked before reaching the API");
}
const automatedGuide = await (await get("/agent.md", { "User-Agent": "Python-urllib/3.12" })).text();
if (!automatedGuide.includes("Tendriller")) throw new Error("Automated clients cannot read the agent guide");
if (!descriptor.limits?.participant) throw new Error('The service must advertise its filtered participant contract');
const manifest = await (await get(`/_tendril/runtime/${runtime.id}/manifest.json`)).json();
if(manifest.id!==runtime.id)throw Error("Runtime artifact mismatch");
if (assistant) {
  const [resource, issuer, keys] = await Promise.all([
    get('/.well-known/oauth-protected-resource/mcp').then(response => response.json()),
    get('/.well-known/oauth-authorization-server').then(response => response.json()),
    get('/oauth/jwks').then(response => response.json()),
  ]);
  if (resource.resource !== `${base}/mcp` || resource.authorization_servers?.length !== 1 ||
      resource.authorization_servers[0] !== base || issuer.issuer !== base ||
      !Array.isArray(resource.scopes_supported) || !resource.scopes_supported.length ||
      resource.scopes_supported.some(scope => !issuer.scopes_supported?.includes(scope)) ||
      issuer.authorization_endpoint !== `${base}/oauth/authorize` || issuer.token_endpoint !== `${base}/oauth/token` ||
      issuer.authorization_response_iss_parameter_supported !== true || issuer.client_id_metadata_document_supported !== true ||
      !issuer.code_challenge_methods_supported?.includes('S256') || !issuer.token_endpoint_auth_methods_supported?.includes('none') ||
      !keys.keys?.length || keys.keys.some(key => ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(field => field in key)))
    throw new Error('Assistant OAuth discovery does not match this deployment');
  const call = (method, params) => fetch(`${base}/mcp`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const catalog = await call('tools/list');
  const tools = (await catalog.json()).result?.tools;
  if (!catalog.ok || !Array.isArray(tools) ||
      ['get_application_delivery', 'tendril_guide'].some(name => !tools.some(tool => tool.name === name)))
    throw new Error('Assistant tool discovery failed: get_application_delivery and tendril_guide must both appear in tools/list');
  await deploymentConvergence(async () => {
    const guideResponse = await call('tools/call', { name: 'tendril_guide', arguments: {} });
    const guide = (await guideResponse.json()).result?.structuredContent;
    if (!guideResponse.ok || guide?.topic !== 'start' || guide.serviceOrigin !== base ||
        guide.readiness?.serviceOrigin !== base ||
        guide.onboarding?.interfaces?.create_page?.url !== `${base}/api/tendrils` ||
        !guide.text?.includes('Node 24'))
      throw new Error('Assistant app-building guidance is unavailable or targets another deployment');
    checkBuild(guide.build, 'Assistant guide');
    checkBuild(guide.readiness.build, 'Assistant guide readiness');
    return guide;
  });
  const templates = await call('resources/templates/list');
  if (!templates.ok || !Array.isArray((await templates.json()).result?.resourceTemplates))
    throw new Error('Assistant resource-template discovery failed');
  const probe = await fetch(`${base}/mcp`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/octet-stream' } });
  if (probe.status !== 401 || !probe.headers.get('WWW-Authenticate')?.includes(`${base}/.well-known/oauth-protected-resource/mcp`))
    throw new Error('Assistant setup probe did not advertise account linking');
  const protectedCall = await call('tools/call', { name: 'get_profile', arguments: {} });
  if (protectedCall.status !== 401 || !protectedCall.headers.get('WWW-Authenticate')?.includes(`${base}/.well-known/oauth-protected-resource/mcp`))
    throw new Error('Assistant tool access did not require an account grant');
  console.log(`Assistant discovery and authorization smoke check passed: ${base}`);
}
console.log(`Matched contract ${descriptor.contract}, runtime ${runtime.id} with the filtered participant transport`);
if (expected.compositionId) console.log(`Matched deployed source ${expected.sourceCommit} and composition ${expected.compositionId}`);
console.log(`Deployment and agent onboarding smoke check passed: ${base}`);
