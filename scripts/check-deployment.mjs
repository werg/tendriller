import { readFileSync } from "node:fs";
import { requireService } from "../contract/client.mjs";
// Smoke check the public endpoints after each deployment.
const base = process.argv[2];
const assistant = process.argv[3] === '--assistant';
if (!base || !/^https:\/\/[a-z0-9.-]+$/.test(base) || (process.argv.length > 3 && !assistant)) {
  throw new Error("Usage: node scripts/check-deployment.mjs https://service-host [--assistant]");
}

async function get(path, headers) {
  let error;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(new URL(path, base), { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
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
const status = await (await get("/status")).text();
if (!/Operational|New page creation paused|Read-only or unavailable/.test(status))
  throw new Error("Service status did not read the account database");
// A static health response and D1 read can pass after the account-wide Durable
// Object storage quota is exhausted. Touch one nonexistent, fixed Tendril so
// its SQLite-backed namespace must complete a real read before deployment is
// reported healthy. The missing tendril is the expected result.
const objectResponse = await fetch(new URL("/api/t/aaaaaaaaaaaa", base), { signal: AbortSignal.timeout(15_000) });
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
const onboarding = await (await get('/.well-known/tendriller.json')).json();
if (onboarding.start_here !== `${base}/docs/BUILD_AN_APP.md` ||
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
const runtime = JSON.parse(readFileSync(new URL("../server/src/runtime-release.json",import.meta.url)));
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
      issuer.authorization_endpoint !== `${base}/oauth/authorize` || issuer.token_endpoint !== `${base}/oauth/token` ||
      issuer.authorization_response_iss_parameter_supported !== true || issuer.client_id_metadata_document_supported !== true ||
      !issuer.code_challenge_methods_supported?.includes('S256') || !issuer.token_endpoint_auth_methods_supported?.includes('none') ||
      !keys.keys?.length || keys.keys.some(key => ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(field => field in key)))
    throw new Error('Assistant OAuth discovery does not match this deployment');
  const call = (method, params) => fetch(`${base}/mcp`, { method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const catalog = await call('tools/list');
  if (!catalog.ok || !(await catalog.json()).result?.tools?.some(tool => tool.name === 'get_application_delivery'))
    throw new Error('Assistant tool discovery failed');
  const protectedCall = await call('tools/call', { name: 'get_profile', arguments: {} });
  if (protectedCall.status !== 401 || !protectedCall.headers.get('WWW-Authenticate')?.includes(`${base}/.well-known/oauth-protected-resource/mcp`))
    throw new Error('Assistant tool access did not require an account grant');
  console.log(`Assistant discovery and authorization smoke check passed: ${base}`);
}
console.log(`Matched contract ${descriptor.contract}, runtime ${runtime.id} with the filtered participant transport`);
console.log(`Deployment and agent onboarding smoke check passed: ${base}`);
