// Run this public-package consumer from its own private working directory. The directory is one agent
// workspace: one account-level agent credential, one shared signing key and this one explicitly granted
// page. It adapts the current starter: a complete signed browser page is published BEFORE any browser
// key exists, explicit native provisioning follows the owner's browser initialization, and the native MCP
// participant is OPTIONAL (`tendril agent run`). The signed page reads and writes with its own browser
// identity; no native process is a prerequisite.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistantKey, proposeApplicationAssistant } from '@tendriller/core/assistant';
import { bytesToHex, eventExecutionManifest, executionManifestArtifacts } from '@chronolog/peer-session';
import { adoptWorkspace, workspaceKey } from '@tendriller/tools/workspace';
import { definition } from './review-domain.mjs';
import { createReviewPage, registerAgentThroughMcp } from './review-setup.mjs';
import * as local from './review-local.mjs';
import { provisionPage } from './support/page-provisioning.mjs';
import { prepareHost } from './support/prepare-host.mjs';
import { publishPage } from './support/publish.mjs';

const mode = process.argv[2], root = fileURLToPath(new URL('.', import.meta.url));
const modes = ['setup', 'init', 'build', 'publish', 'signer-key', 'sign-enrollment', 'provisioning-request', 'import-provisioning', 'propose'];
if (!modes.includes(mode)) throw Error('Choose ' + modes.join(', ') + '. Run the optional participant with: tendril agent run');

if (mode === 'setup') {
  const [origin, name = 'Review checklist'] = process.argv.slice(3), accessToken = process.env.REVIEW_ACCESS_TOKEN;
  if (!origin || !accessToken) throw Error('Use: REVIEW_ACCESS_TOKEN=<linked account OAuth token with tendrils:create> node review-app.mjs setup SERVICE_ORIGIN [NAME]');
  if (!existsSync(join(root, 'tendriller.json'))) {
    const { register_agent } = await workspaceKey(root, { service: origin, name: 'review-fixture' });
    const result = await registerAgentThroughMcp(origin, accessToken, register_agent);
    const file = join(root, '.tendriller', 'register-agent-result.json');
    await mkdir(join(root, '.tendriller'), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(result), { mode: 0o600, flag: 'w' });
    try { await adoptWorkspace(root, { service: origin, credential: file }); } finally { await rm(file, { force: true }); }
  }
  // The central helper retains the exact creation intent first and resumes only that application ID; a lost reply never mints a second page.
  await createReviewPage(await local.workspace(), name);
  const context = await local.pageContext();
  // The agent program imports this page's module; it stays a thin entry over the copied consumer sources.
  await mkdir(context.page.source, { recursive: true });
  const entry = join(context.page.source, 'agent.mjs');
  if (!existsSync(entry)) await writeFile(entry, "export { definition, openPage } from '../../review-agent.mjs';\n", { flag: 'wx' });
  console.log(JSON.stringify({ pageUrl: context.page.pageUrl, applicationId: context.page.applicationId }));
  process.exit(0);
}

const context = await local.pageContext();
const print = value => console.log(JSON.stringify(value));

if (mode === 'init') {
  const executionManifestDigest = bytesToHex((await executionManifestArtifacts(await eventExecutionManifest())).executionManifestDigest);
  print(await prepareHost(context, { definition, executionManifestDigest, executionProfile: 'events' }));
  process.exit(0);
}
if (mode === 'build') {
  // The bundler is a build-time tool, not a runtime dependency of the signed page or the native participant.
  const { build } = await import(process.env.REVIEW_ESBUILD_MODULE ?? 'esbuild');
  const configuration = await context.readPrivate('host-configuration.json'), output = new URL('./page/', import.meta.url);
  await rm(output, { recursive: true, force: true });
  try {
    await mkdir(output);
    await writeFile(new URL('configuration.json', output), JSON.stringify({ applicationId: context.page.applicationId, page_url: context.page.pageUrl,
      serviceOrigin: context.service, pageId: context.page.id, executionManifestDigest: configuration.executionManifestDigest }, null, 2) + '\n');
    await copyFile(new URL('./review-index.html', import.meta.url), new URL('index.html', output));
    await build({ absWorkingDir: root, entryPoints: { page: 'review-page.mjs', worker: 'review-worker.mjs' }, outdir: fileURLToPath(output),
      bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]' });
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  console.log('Built the complete page/ graph. Publish it before the owner browser key exists.');
  process.exit(0);
}
if (mode === 'publish') {
  // Signed with the workspace's shared signer under the page's explicit publication grant; no separate page publisher exists.
  print(await publishPage(context, { root: new URL('./page/', import.meta.url) }));
  process.exit(0);
}

// Explicit, optional native provisioning. The browser owner never receives the native private key.
if (mode === 'signer-key') {
  // The page device signs with the workspace's one shared agent key; the browser owner grants exactly this public key.
  print({ publicKey: context.signer.publicKey,
    next: 'In the owner browser, create an account-bound challenge for this public key. Sign it here with sign-enrollment CHALLENGE.json, then record that proof in the browser.' });
  process.exit(0);
}
if (['sign-enrollment', 'provisioning-request', 'import-provisioning'].includes(mode)) { print(await provisionPage(context, mode, process.argv[3])); process.exit(0); }

// propose: the exact owner-reviewed capability subset. Native participation is optional and connects only after approval.
const options = { page: context.host,
  key: await context.readPrivate('assistant-key.json', true) ?? await context.savePrivate('assistant-key.json', createAssistantKey()),
  label: context.page.name ?? 'Review checklist', queries: ['checklist'], commands: ['completeItem'],
  events: [{ name: 'item.completed', description: 'The synthetic checklist item ID that was completed.' }] };
const proposal = await proposeApplicationAssistant(options);
await context.savePrivate('assistant-proposal.json', { proposed: proposal.proposed, adapterHash: createHash('sha256').update(options.key).digest('hex') });
print({ reviewUrl: proposal.reviewUrl, proposed: proposal.proposed, approved: proposal.approved });
