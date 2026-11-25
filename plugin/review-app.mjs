// Run this public-package consumer from its own private working directory.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAgentClient, registerAgent } from '@tendriller/core';
import { participateNativeApplication } from '@tendriller/core/native-rtc';
import { createNativeSessionSupervisor } from '@tendriller/core/native-owner';
import { connectApplicationAssistant, createAssistantKey, createAssistantEventDelivery, proposeApplicationAssistant } from '@tendriller/core/assistant';
import { bytesDigest, bytesToHex, createScopedApplicationTools, forwardSessionEvents, describeApplication, eventExecutionManifest,
  executionManifestArtifacts, participantGrant, signTransitionRequest, signPublicationManifest, verifyAuthorityBundle } from '@chronolog/peer-session';
import { openNativeApplication, openNativeDevice } from '@chronolog/peer-session/native';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { definition } from './review-domain.mjs';
import { watchApplicationSetup } from '@tendriller/core/setup';
import { superviseReviewAssistant, retainedReviewProposal } from './review-assistant.mjs';

const directory = resolve('.private');
await mkdir(directory, { recursive: true, mode: 0o700 });
async function read(name) {
  try { return JSON.parse(await readFile(resolve(directory, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(name, value) {
  const temporary = resolve(directory, name + '.' + randomUUID());
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, resolve(directory, name));
  return value;
}
const mode = process.argv[2];
if (mode === 'create') {
  const access = JSON.parse(await readFile(process.argv[3], 'utf8'));
  // One synthetic agent owns this fixture page; the owner claims both by signing in.
  const agent = await read('agent.json') ?? await save('agent.json', await registerAgent(access.origin, {
    owner: `${access.accountId}@example.invalid`, name: 'review-fixture',
    publicKey: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x }));
  const handle = await read('handle.json') ?? await save('handle.json', { ...await createAgentClient({ service: access.origin, token: agent.token })
    .pages.create({ name: process.argv[4] ?? 'Review checklist' }), service: access.origin, token: agent.token });
  console.log(JSON.stringify({ pageUrl: handle.page_url }));
  process.exit(0);
}
const handle = await read('handle.json');
if (!handle) throw Error('Run create first');
const host = createAgentClient({ service: handle.service, token: handle.token }).page(handle.id, { applicationId: handle.application.id });
const options = { page: host,
  key: await read('assistant-key.json') ?? await save('assistant-key.json', createAssistantKey()),
  label: handle.name, queries: ['checklist'], commands: ['completeItem'],
  events: [{ name: 'item.completed', description: 'The synthetic checklist item ID that was completed.' }] };
if (mode === 'propose') {
  const proposal = await proposeApplicationAssistant(options);
  await save('assistant-proposal.json', { proposed: proposal.proposed, adapterHash: createHash('sha256').update(options.key).digest('hex') });
  console.log(JSON.stringify({ reviewUrl: proposal.reviewUrl, proposed: proposal.proposed, approved: proposal.approved }));
  process.exit(0);
}
if (!['init', 'run'].includes(mode)) throw Error('Choose create, init, propose, or run');
const existing = await read('initialized.json');
if (mode === 'init' && existing) {
  console.log('Review application already initialized');
  process.exit(0);
}
let device, session, supervisor;
try {
  if (mode === 'init') {
    device = await openNativeDevice({ path: resolve(directory, 'device.sqlite'), create: true });
    const initial = await read('initial.json') ?? await save('initial.json', {
      historyId: `review-${randomUUID()}`, epochKey: randomBytes(32).toString('base64'),
    });
    const epochKey = new Uint8Array(Buffer.from(initial.epochKey, 'base64'));
    const execution = await executionManifestArtifacts(await eventExecutionManifest());
    const authority = await host.peers.configureApplication({ historyId: initial.historyId,
      definition: describeApplication(definition), schema: null, executionManifestDigest: bytesToHex(execution.executionManifestDigest),
      schemaAdministrator: device.identity.publicKey, epoch: 0, keyDigest: await bytesDigest(epochKey),
      members: [{ grant: participantGrant(device.identity.publicKey, { administrator: true, publisher: true }) }] });
    await verifyAuthorityBundle(authority);
    const descriptor = authority.descriptor;
    const transition = await read('transition.json') ?? await save('transition.json', await signTransitionRequest({
      applicationId: handle.application.id, profile: descriptor.payload.profile, policy: descriptor.payload.policy,
      transitionId: randomUUID(), expectedGeneration: null, coordinator: device.identity.publicKey,
      requester: device.identity.publicKey, controlRevision: 0, reason: 'create', base: null,
    }, device.identity));
    await host.peers.selectGeneration(transition);
    session = await openNativeApplication({ device, definition, authority: await host.peers.application(), epochKeys: new Map([[0, epochKey]]) });
    await session.query('checklist', null);
    await save('descriptor.json', descriptor);
    await save('initialized.json', { deviceId: session.deviceId });
    console.log('Review application initialized with two synthetic items');
  } else {
    supervisor = await createNativeSessionSupervisor({ directory: resolve(directory, 'owner'), profileId: 'review', bindings: [],
      openOwner: async () => {
        const authority = await host.peers.application();
        await verifyAuthorityBundle(authority, await read('descriptor.json'));
        device = await openNativeDevice({ path: resolve(directory, 'device.sqlite') });
        session = await openNativeApplication({ device, definition, authority });
        const controlHost = { exchange: (message, options) => host.peers.exchange(message, options) };
        const control = session.connectControlParticipant(controlHost);
        await participateNativeApplication(session, { peers: host.peers, control });
        return createApplicationOwner(session, { host: controlHost });
      } });
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
    const expectedProposalId = retainedReviewProposal(await read('assistant-proposal.json'), options.key);
    const lifecycle = superviseReviewAssistant({ session, signal: stop.signal, expectedProposalId,
      watch: callbacks => watchApplicationSetup({ page: host, ...callbacks }),
      startAdapter: callbacks => connectApplicationAssistant({ ...options, session, tools: createScopedApplicationTools(session, options), ...callbacks }),
      onOnline: (assistant, signal) => forwardSessionEvents({ session, topics: ['completed'], signal,
        deliver: createAssistantEventDelivery({ assistant }),
        checkpoint: { load: async () => (await read('event-cursor.json')) ?? undefined, save: cursor => save('event-cursor.json', cursor) },
        project: event => ({ name: 'item.completed', payload: { id: event.payload.id } }) }),
    });
    let lastHtml;
    const publishView = async () => {
      const { value } = await session.query('checklist', null);
      const html = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Review checklist</title><style>body{font:18px/1.6 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem}li{margin:1rem 0}</style>'
        + '<h1>Review checklist</h1><p>Shared synthetic data for testing Tendriller. Ask the connected assistant to read or complete an item.</p><ul>'
        + value.map(item => `<li>${item.complete ? '✓ Complete' : 'Incomplete'} · ${item.label}</li>`).join('')
        + `</ul><p>This is a signed snapshot. <a href="${handle.page_url}">Open the latest snapshot</a> after changing an item.</p></html>`;
      if (html === lastHtml) return;
      let pending = await read('pending-publication.json');
      if (!pending) {
        const previous = await host.peers.publication(), current = await host.peers.application();
        const bytes = new TextEncoder().encode(html), hash = await bytesDigest(bytes), descriptor = current.descriptor.payload;
        pending = await save('pending-publication.json', { html, publication: await signPublicationManifest({
          applicationId: handle.application.id, historyId: descriptor.historyId, profile: descriptor.profile,
          controlRevision: current.controls.at(-1).payload.revision, author: device.identity.publicKey,
          operationId: randomUUID(), revision: previous ? previous.publication.payload.revision + 1 : 0,
          previous: previous?.publication.id ?? null, definitionDigest: descriptor.definitionDigest,
          executionManifestDigest: descriptor.executionManifestDigest, entry: 'index.html',
          files: [{ path: 'index.html', hash, size: bytes.length, type: 'text/html' }],
        }, device.identity), assets: [{ hash, bytes: Buffer.from(bytes).toString('base64') }] });
      }
      const result = await host.peers.publish(pending.publication, pending.assets);
      if (result.publication.id !== pending.publication.id) throw Error('PUBLICATION_MISMATCH');
      lastHtml = pending.html;
      await save('pending-publication.json', null);
      if (html !== lastHtml) await publishView();
    };
    const updates = (async () => {
      await publishView();
      for await (const _ of session.changes({ signal: stop.signal })) await publishView();
    })();
    console.log('Review participant running; it must remain running for reviewer reads, writes, and signed page updates.');
    try { await Promise.all([updates, lifecycle.done]); }
    catch (error) { if (!stop.signal.aborted) throw error; }
    finally { stop.abort(); await lifecycle.close(); await Promise.allSettled([updates]); }
  }
} finally {
  if (supervisor) await supervisor.close();
  else if (session) await session.close();
  else await device?.close();
}
