// Run this public-package consumer from its own private working directory. It adapts the current starter:
// account-linked setup, independent publisher policy, a complete signed browser page published before any
// browser key exists, explicit native provisioning, and an OPTIONAL native assistant participant. The
// signed page reads and writes with its own browser identity; the native process is never a prerequisite.
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rm, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareTendrilSetup, createSetupIntent, completeSetupIntent } from '@tendriller/core/setup';
import { connectApplicationAssistant, createAssistantKey, createAssistantEventDelivery, proposeApplicationAssistant } from '@tendriller/core/assistant';
import { bytesToHex, createScopedApplicationTools, forwardSessionEvents, describeApplication, eventExecutionManifest,
  executionManifestArtifacts, importSigningIdentity, signPublicationManifest } from '@chronolog/peer-session';
import { definition } from './review-domain.mjs';
import * as local from './review-local.mjs';
import { createNativeBootstrap } from './support/native-session.mjs';
import { prepareHost } from './support/prepare-host.mjs';
import { superviseReviewAssistant, retainedReviewProposal } from './review-assistant.mjs';

const { readPrivate, savePrivate, replacePrivate, project } = local;
const mode = process.argv[2], root = fileURLToPath(new URL('.', import.meta.url));
const nativeModes = new Set(['init-device', 'status', 'diagnostics', 'sign-enrollment', 'provisioning-request', 'import-provisioning']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = { html: 'text/html; charset=utf-8', mjs: 'text/javascript', js: 'text/javascript', json: 'application/json', css: 'text/css' };

if (mode === 'setup') {
  // The linked account's OAuth grant (tendrils:create) names the owner; no owner identity is supplied here.
  const [origin, name = 'Review checklist'] = process.argv.slice(3), accessToken = process.env.REVIEW_ACCESS_TOKEN;
  if (!origin || !accessToken) throw Error('Use: REVIEW_ACCESS_TOKEN=<linked account OAuth token with tendrils:create> node review-app.mjs setup SERVICE_ORIGIN [NAME]');
  let handle = await readPrivate('handle.json', true);
  if (!handle) {
    const retained = await readPrivate('account-setup.json', true);
    const store = { load: async id => retained?.operationId === id ? retained : null, save: (_id, intent) => savePrivate('account-setup.json', intent) };
    const intent = await createSetupIntent(origin, { operationId: retained?.operationId ?? `review-setup-${randomUUID()}`, name }, { store });
    handle = await savePrivate('handle.json', await completeSetupIntent(intent, await prepareTendrilSetup(intent, { accessToken })));
  }
  console.log(JSON.stringify({ pageUrl: handle.page_url, applicationId: handle.application.id }));
  process.exit(0);
}
if (mode === 'init') {
  const { handle, host } = await project();
  const executionManifestDigest = bytesToHex((await executionManifestArtifacts(await eventExecutionManifest())).executionManifestDigest);
  console.log(JSON.stringify(await prepareHost({ handle, host, readPrivate, savePrivate, definition, describeApplication, executionManifestDigest, executionProfile: 'events' })));
  process.exit(0);
}
if (mode === 'build') {
  // The bundler is a build-time tool, not a runtime dependency of the signed page or the native participant.
  const { build } = await import(process.env.REVIEW_ESBUILD_MODULE ?? 'esbuild');
  const { handle } = await project(), configuration = await readPrivate('host-configuration.json'), output = new URL('./page/', import.meta.url);
  await rm(output, { recursive: true, force: true });
  try {
    await mkdir(output);
    await writeFile(new URL('configuration.json', output), JSON.stringify({ applicationId: handle.application.id, page_url: handle.page_url,
      serviceOrigin: new URL(handle.api).origin, pageId: handle.id, executionManifestDigest: configuration.executionManifestDigest }, null, 2) + '\n');
    await copyFile(new URL('./review-index.html', import.meta.url), new URL('index.html', output));
    await build({ absWorkingDir: root, entryPoints: { page: 'review-page.mjs', worker: 'review-worker.mjs' }, outdir: fileURLToPath(output),
      bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]' });
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  console.log('Built the complete page/ graph. Publish it before the owner browser key exists.');
  process.exit(0);
}
if (mode === 'publish') {
  const { handle, host } = await project(), files = [], assets = new Map(), base = new URL('./page/', import.meta.url);
  async function visit(directory, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + item.name;
      if (item.isSymbolicLink()) throw Error('Publication must not contain symbolic links');
      if (item.isDirectory()) await visit(new URL(item.name + '/', directory), path + '/');
      else if (item.isFile()) {
        const bytes = await readFile(new URL(item.name, directory)), digest = hash(bytes);
        files.push({ path, hash: digest, size: bytes.length, type: types[path.split('.').at(-1)] ?? 'application/octet-stream' });
        assets.set(digest, { hash: digest, bytes: bytes.toString('base64') });
      }
    }
  }
  await visit(base); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const graph = hash(JSON.stringify(files)), recordName = `publication-${graph}.json`;
  let publication = await readPrivate(recordName, true);
  if (!publication) {
    const [metadata, previous] = await Promise.all([host.peers.application(), host.peers.publication()]), scope = metadata.publicationAuthority;
    if (!scope) throw Error('Run init before publishing');
    const publisher = await importSigningIdentity(await readPrivate('publisher.json'));
    publication = await savePrivate(recordName, await signPublicationManifest({ applicationId: handle.application.id, membershipId: scope.grantId, author: publisher.publicKey,
      operationId: `publish-${graph}`, revision: previous === null ? 0 : previous.publication.payload.revision + 1, previous: previous?.publication.id ?? null,
      executionManifestDigest: scope.executionManifestDigest, entry: 'index.html', files }, publisher));
  }
  const receipt = await host.peers.publish(publication, [...assets.values()]);
  if (receipt.publication.id !== publication.id) throw Error('PUBLICATION_MISMATCH');
  console.log(JSON.stringify({ pageUrl: handle.page_url, publicationId: publication.id, version: receipt.version }));
  process.exit(0);
}

const native = createNativeBootstrap({ definition, local });
if (nativeModes.has(mode)) {
  const result = await native.main(process.argv.slice(2));
  if (result) console.log(JSON.stringify(result));
  process.exit(process.exitCode ?? 0);
}
const { handle } = await project();
const options = { api: handle.api, token: handle.token,
  key: await readPrivate('assistant-key.json', true) ?? await savePrivate('assistant-key.json', createAssistantKey()),
  label: handle.name ?? 'Review checklist', queries: ['checklist'], commands: ['completeItem'],
  events: [{ name: 'item.completed', description: 'The synthetic checklist item ID that was completed.' }] };
if (mode === 'propose') {
  const proposal = await proposeApplicationAssistant(options);
  await savePrivate('assistant-proposal.json', { proposed: proposal.proposed, adapterHash: createHash('sha256').update(options.key).digest('hex') });
  console.log(JSON.stringify({ reviewUrl: proposal.reviewUrl, proposed: proposal.proposed, approved: proposal.approved }));
  process.exit(0);
}
if (mode !== 'run') throw Error('Choose setup, init, build, publish, init-device, sign-enrollment, provisioning-request, import-provisioning, status, diagnostics, propose, or run');

// Optional native participant: it opens its own cached, explicitly provisioned store and serves the reviewed MCP adapter.
const stop = new AbortController();
process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
const owned = await native.openSession({ signal: stop.signal });
let lifecycle;
try {
  const { session } = owned, expectedProposalId = retainedReviewProposal(await readPrivate('assistant-proposal.json', true), options.key);
  lifecycle = superviseReviewAssistant({ session, signal: stop.signal, expectedProposalId, watch: owned.watchSetup,
    startAdapter: callbacks => connectApplicationAssistant({ ...options, session, tools: createScopedApplicationTools(session, options), ...callbacks }),
    onOnline: (assistant, signal) => forwardSessionEvents({ session, topics: ['completed'], signal,
      deliver: createAssistantEventDelivery({ assistant }),
      checkpoint: { load: async () => (await readPrivate('event-checkpoint.json', true)) ?? undefined, save: state => replacePrivate('event-checkpoint.json', state) },
      project: event => ({ name: 'item.completed', payload: { id: event.payload.id } }) }),
    report: value => console.log(JSON.stringify(value)),
  });
  console.log(JSON.stringify({ state: 'participant_running', applicationId: session.applicationId, publicKey: session.identity.publicKey,
    optional: true, note: 'Optional MCP participant. The signed page needs no native process; it must stay running only for reviewed assistant reads and writes.' }));
  await lifecycle.done;
} finally { try { await lifecycle?.close(); } finally { await owned.close(); } }
