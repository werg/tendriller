// Optional qualification of the ONE native workspace program. The default
// first-app journey never calls this module or depends on a native participant.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { QUALIFICATION_SOCKET_ENV, qualificationSocketPath, connectQualificationPeer, qualificationPageSource } from './first-app-peer.mjs';
import { prepareSignalQualification, createSignalQualification, qualifyFirstAppSignals } from './first-app-signals.mjs';
import {qualifyFirstAppMedia} from './first-app-media.mjs';
import { qualifyFirstAppPublication } from './first-app-publication.mjs';
import { expectConnectionInspector } from './first-app-connections.mjs';

export const EVIDENCE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64');
export async function prepareWorkspaceQualification({ app, slug, feedback, network }) {
  const directory = join(app, 'pages', slug);
  await writeFile(join(directory, 'agent.mjs'), qualificationPageSource({ evidenceBase64: EVIDENCE_PNG.toString('base64'), networkQualification: Boolean(network), qualificationSources: feedback ? [createSignalQualification.toString()] : [] }));
  if (feedback) await prepareSignalQualification(directory);
}
export function startWorkspaceProgram({ app, preload, cli, socketDirectory, events }) {
  const from = events.length;
  const child = spawn(process.execPath, ['--import', preload, cli, 'agent', 'run'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, [QUALIFICATION_SOCKET_ENV]: socketDirectory } });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-6000); });
  const waiters = new Set();
  const exited = once(child, 'exit');
  // Observe spawn failure immediately, including before a caller awaits readiness.
  exited.catch(() => {});
  createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    if (events.length < 4000) events.push(value);
    for (const waiter of waiters) if (waiter.match(value)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(value); }
  });
  return {
    child,
    waitFor(match, label, timeoutMs = 60000) {
      const saved = events.slice(from).find(match); if (saved) return Promise.resolve(saved);
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(Error(`Agent did not report ${label}: ${stderr}`)); }, timeoutMs) };
        waiters.add(waiter);
        exited.then(([code]) => { if (waiters.delete(waiter)) { clearTimeout(waiter.timer); reject(Error(`Agent exited ${code} before ${label}: ${stderr}`)); } }, error => { if (waiters.delete(waiter)) { clearTimeout(waiter.timer); reject(error); } });
      });
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 20000);
      try { const [code, signal] = await exited; return { code, signal }; } finally { clearTimeout(timer); }
    },
  };
}

/** The running agent's page is admitted from its signed host grant by an online browser holder, then holds the keys. */
export function admittedAgent(program, pageId, label) {
  return program.waitFor(value => value.page === pageId && value.canAuthor === true, `${label}: agent admitted with page keys`, 90000);
}

export async function qualifyFirstAppWorkspace({ app, slug, primary, journal, publicKey, first, second, profile, setup, tendril, node, cli, preload, expect, report, screenshot, service, transportCounters, transport, feedback, network, checkpoint, passed, sha256 }) {
  const events = [], socketDirectory = process.platform === 'linux' ? `@first-app-${crypto.randomUUID()}` : join(app, '.tendriller', 'qualification-sockets');
  if (!socketDirectory.startsWith('@')) await mkdir(socketDirectory, { mode: 0o700 });
  let program, peer, journalProfile, lateProfile, failure;
  const start = () => startWorkspaceProgram({ app, preload, cli, socketDirectory, events });
  const running = id => value => value.page === id && value.state === 'running';
  const notes = args => tendril(['--page', slug, ...args]);
  const command = async (target, id, text) => {
    const result = await tendril(['--page', target, 'command', 'putNote', JSON.stringify({ noteId: id, text }), '--operation', id, '--wait', 'materialized']);
    assert.equal(result.materialized?.outcome, 'accepted'); return result;
  };
  const save = async (page, text) => { await page.locator('#new').click(); await page.locator('#note').fill(text); await page.locator('#submit').click(); await expect(page.locator('#operation-status')).toContainText('Stored locally: yes'); await expect(page.locator('#notes')).toContainText(text); return page.locator('#operation-id').inputValue(); };
  const opened = async (item, width = 390) => { const value = await profile({ width, height: 844 }); await value.page.goto(item.page_url); await expect(value.page.locator('#public-key')).toHaveValue(/^[a-f0-9]{64}$/, { timeout: 60000 }); await expect(value.page.locator('#submit')).toBeEnabled({ timeout: 60000 }); return value; };
  try {
    checkpoint('optional workspace: ONE native hub; the browser-created page admits the agent from its signed grant');
    // Other browser data links would invalidate single-link network evidence.
    await second.context.close();
    program = start();
    await program.waitFor(value => value.hub === 'connected', 'one authenticated control hub');
    const primaryOpened = await program.waitFor(running(primary.id), 'primary page opened while awaiting admission');
    assert.equal(primaryOpened.publicKey, publicKey);
    // The owner's online browser verifies the host attestation for the granted agent and signs its admission.
    await admittedAgent(program, primary.id, 'browser-first page');
    // The grant's attestation exists from page creation, so the open browser may admit the agent before it
    // runs; the signed member list (not an ephemeral notice) is the evidence.
    await expect(first.page.locator('#devices .admission-members')).toContainText(`agent · key ${publicKey.slice(0, 8)}…${publicKey.slice(-4)}`, { timeout: 30000 });
    // The agent-first journal page opened with its own creator keys.
    await admittedAgent(program, journal.id, 'agent-first page');
    peer = connectQualificationPeer(qualificationSocketPath(socketDirectory, slug));
    const browserKey = await first.page.locator('#public-key').inputValue(); await peer.request('configure', { browserDeviceId: browserKey });
    await peer.request('setup-ready');
    await expect.poll(async () => (await peer.request('participation-log')).current.peers, { timeout: 60000 }).toContain(browserKey);
    assert.equal((await notes(['self'])).identity.publicKey, publicKey);
    const firstCommand = await command(slug, 'workspace-native-exact', 'Optional native workspace author');
    const retry = await command(slug, 'workspace-native-exact', 'Optional native workspace author');
    assert.equal(retry.proposalId, firstCommand.proposalId); assert.equal(retry.authorTimestampMs, firstCommand.authorTimestampMs);
    await expect(first.page.locator('#notes')).toContainText('Optional native workspace author', { timeout: 30000 });
    passed('one hub, agent admitted automatically from its signed grant, exact native retries keep proposal/time and browser convergence');
    // Browser↔native: the built-in inspector names the agent by @handle with its actual route and data.
    const linkLog = await peer.request('participation-log');
    try { report.agent_connection_inspector = await expectConnectionInspector(first.page, { expect, name: '@first-app', transport, screenshot, label: 'connections-agent' }); }
    catch (error) {
      report.agent_connection_debug = { before: linkLog, after: await peer.request('participation-log').catch(cause => cause.message),
        browser: await first.page.evaluate(() => window.tendril.transport.status()).catch(cause => cause.message) };
      throw error;
    }
    passed('Application connections shows the native agent by @handle, its actual route and non-zero received data');

    checkpoint('optional workspace: agent-first page; the owner browser is admitted by the running agent');
    journalProfile = await opened(journal); await save(journalProfile.page, 'Journal browser operation');
    // The signed membership names the agent as the page creator; the browser joined without any copied artifact.
    await expect(journalProfile.page.locator('#devices .admission-members')).toContainText(`creator · key ${publicKey.slice(0, 8)}…${publicKey.slice(-4)}`, { timeout: 30000 });
    await expect(journalProfile.page.locator('#devices .admission-members')).toContainText('(this device)');
    assert.equal((await tendril(['--page', 'journal', 'self'])).identity.publicKey, publicKey);
    assert.notEqual((await notes(['self'])).applicationId, (await tendril(['--page', 'journal', 'self'])).applicationId);
    await expect.poll(async () => (await tendril(['--page', 'journal', 'query', 'notes', 'null'])).value.map(row => row.text), { timeout: 30000 }).toContain('Journal browser operation');
    await command('journal', 'journal-native-exact', 'Journal native operation');
    await expect(journalProfile.page.locator('#notes')).toContainText('Journal native operation');
    assert.equal((await notes(['query', 'notes', 'null'])).value.some(row => row.text.includes('Journal ')), false);
    await journalProfile.context.close(); journalProfile = undefined;

    checkpoint('optional workspace: a page created and initialized while the agent runs opens without restart');
    const late = await setup(['new', 'late', '--template', 'notes', '--name', 'Created while agent runs']);
    await setup(['init', 'late']); await setup(['deploy', 'late']);
    await admittedAgent(program, late.id, 'late agent-first page');
    lateProfile = await opened(late); await save(lateProfile.page, 'Late browser operation');
    await command('late', 'late-native-exact', 'Late native operation'); await expect(lateProfile.page.locator('#notes')).toContainText('Late native operation');
    await lateProfile.context.close(); lateProfile = undefined;
    passed('second and late pages retain independent histories and keys under the same running agent and signer');

    checkpoint('optional workspace: stop hub, author browser offline, restart same devices');
    assert.deepEqual(await program.stop(), { code: 0, signal: null }); program = undefined;
    const offline = await save(first.page, 'Stored with optional agent stopped');
    const originalOffline = await first.page.evaluate(async id => {
      const operation = await window.tendril.application.backend.operations.get(id);
      if (!operation) throw Error('Original offline operation is missing');
      return operation.inspect();
    }, offline);
    assert.equal(originalOffline.stored, true); assert.equal(originalOffline.author, browserKey);
    await first.page.reload(); await expect(first.page.locator('#public-key')).toHaveValue(browserKey, { timeout: 60000 }); await expect(first.page.locator('#operation-id')).toHaveValue(offline); await expect(first.page.locator('#notes')).toContainText('Stored with optional agent stopped');
    await first.page.locator('#note').fill('Draft survives optional agent restart');
    await first.page.goto('about:blank');
    program = start(); await program.waitFor(value => value.hub === 'connected', 'hub reconnect'); await program.waitFor(running(primary.id), 'same retained primary device');
    assert.equal((await notes(['self'])).identity.publicKey, publicKey);
    await command(slug, 'native-browser-closed', 'Native work while browser closed');
    await first.page.goto(primary.page_url); await expect(first.page.locator('#public-key')).toHaveValue(browserKey, { timeout: 60000 }); await expect(first.page.locator('#note')).toHaveValue('Draft survives optional agent restart');
    await peer.request('configure', { browserDeviceId: browserKey });
    await expect(first.page.locator('#notes')).toContainText('Native work while browser closed', { timeout: 60000 });
    await expect.poll(async () => (await notes(['query', 'notes', 'null'])).value.some(row => row.text === 'Stored with optional agent stopped'), { timeout: 60000 }).toBe(true);
    const importedOffline = await peer.request('operation', { operationId: originalOffline.proposalId });
    assert.ok(importedOffline, 'The native replica must retain the exact browser-authored proposal, not resolve a foreign author-local alias');
    assert.equal(importedOffline.stored, true); assert.equal(importedOffline.proposalId, originalOffline.proposalId);
    assert.equal(importedOffline.operationId, offline); assert.equal(importedOffline.authorTimestampMs, originalOffline.authorTimestampMs);
    await expect.poll(async () => first.page.evaluate(async ({ id, proposalId, authorTimestampMs, peerKey }) => {
      const operation = await window.tendril.application.backend.operations.get(id);
      if (!operation) throw Error('Original browser operation disappeared');
      const inspection = await operation.inspect();
      if (inspection.proposalId !== proposalId || inspection.authorTimestampMs !== authorTimestampMs) throw Error('Original signed intent changed');
      // Retention is observed by the authoring browser: the native replica must
      // not count its own retained copy as evidence from another peer.
      return inspection.retained.filter(row => row.payload.peer === peerKey).length;
    }, { id: offline, proposalId: originalOffline.proposalId, authorTimestampMs: originalOffline.authorTimestampMs, peerKey: publicKey }), { timeout: 30000 }).toBeGreaterThan(0);
    passed('native program/hub shutdown is clean, saved local work and draft survive, automatic peer convergence needs no replacement intent');

    if (network) {
      checkpoint('optional network lab: real packet faults, hidden/frozen lifecycle and signed work');
      const { qualifyFirstAppNetwork } = await import('../test/e2e/network-qualification/first-app.mjs');
      const { NETWORK_PROFILES } = await import('../test/e2e/network-qualification/scenarios.mjs');
      report.network_qualification = { profiles: [], success: false };
      for (const selected of network === 'suite' ? NETWORK_PROFILES : [network]) {
        try { report.network_qualification.profiles.push(await qualifyFirstAppNetwork({ page: first.page, context: first.context, peer, expect, transportCounters, evidencePng: EVIDENCE_PNG, browserDevice: browserKey, sha256, profile: selected })); }
        catch (error) { if (error.networkReport) report.network_qualification.profiles.push(error.networkReport); throw error; }
      }
      report.network_qualification.success = true;
    }
    if (feedback) {
      report.media_qualification=await qualifyFirstAppMedia({page:first.page,peer,expect,evidencePng:EVIDENCE_PNG,publicKey:browserKey,sha256});
      checkpoint('optional feedback: resident signed publication, authentic freshness rejects, live durable continuity');
      report.publication_qualification = await qualifyFirstAppPublication({ page: first.page, pageUrl: primary.page_url, peer, expect, workspace: app, slug, pageDirectory: join(app, 'pages', slug, 'dist'), preload, cli, node, publicationGateUrl: new URL('/__first_app_publication', service).href });
      report.signal_qualification = await qualifyFirstAppSignals({ page: first.page, peer, expect, transportCounters, transport });
    }
    report.optional_workspace = { passed: true, sharedSigner: publicKey, pages: [primary.id, journal.id], latePageOpenedWithoutRestart: true, browserSavedWithProgramStopped: offline, exactRetryProposal: firstCommand.proposalId, events };
    report.native_checks = 'passed';
  } catch(error){failure=error;throw error;} finally {
    const results = await Promise.allSettled([journalProfile?.context.close(), lateProfile?.context.close(), program?.stop()]);
    const errors = results.filter(value => value.status === 'rejected').map(value => value.reason);
    const stopped = results[2]; if (stopped.status === 'fulfilled' && stopped.value) { report.optional_workspace_shutdown = stopped.value; if (stopped.value.code !== 0 || stopped.value.signal !== null) errors.push(Error('Optional native workspace did not shut down cleanly')); }
    if (errors.length) throw new AggregateError(failure?[failure,...errors]:errors, 'Optional workspace cleanup failed', { cause: failure??errors[0] });
  }
}

// Full native SQL capability is optional and explicit. Tables, grants and rows
// are ordinary operations already authored by the browser, never setup DDL.
export async function qualifyFirstAppSqlWorkspace({app,slug,primary,publicKey,first,second,setup,tendril,cli,preload,expect,report,checkpoint,passed}) {
 let program,failure;const events=[];
 const query=()=>tendril(['--page',slug,'query','inventory','null']);
 const command=(name,input,id)=>tendril(['--page',slug,'command',name,JSON.stringify(input),'--operation',id,'--wait','materialized']);
 try {
  checkpoint('optional full native SQL: automatic agent admission and independent SQL grants');
  await second.context.close();
  await first.page.locator('#sql-grantee').fill(publicKey);await first.page.locator('#sql-grant').click();
  await expect(first.page.locator('#result')).toContainText('accepted',{timeout:30000});
  const start=()=>startWorkspaceProgram({app,cli,preload,socketDirectory:'unused-sql-qualification',events});
  program=start();await program.waitFor(value=>value.hub==='connected','SQL workspace hub');await admittedAgent(program,primary.id,'full SQL page');
  await expect.poll(async()=>{try{return(await query()).value.catalog.map(row=>row.name);}catch{return[];}},{timeout:60000}).toContain('inventory');
  for(const[id,units]of[['native-source',10],['native-destination',0]])assert.equal((await command('addBin',{id,units},'sql-'+id)).materialized?.outcome,'accepted');
  const input={transferId:'native-transfer',from:'native-source',to:'native-destination',units:3,expectedSource:10,expectedDestination:0};
  const accepted=await command('transfer',input,'sql-native-transfer');assert.equal(accepted.materialized?.outcome,'accepted');
  const retry=await command('transfer',input,'sql-native-transfer');assert.equal(retry.proposalId,accepted.proposalId);assert.equal(retry.authorTimestampMs,accepted.authorTimestampMs);
  const before=(await query()).value;
  const rejected=await command('transfer',{transferId:'native-rejected',from:'native-source',to:'native-destination',units:8,expectedSource:7,expectedDestination:3},'sql-native-rejected');assert.equal(rejected.materialized?.outcome,'rejected');
  assert.deepEqual((await query()).value,before,'Rejected transfer changes no balances, receipts or schema');
  assert.equal(before.transfers.filter(row=>row.id==='native-transfer').length,1,'Exact retry creates one transfer receipt');
  assert.deepEqual(Object.fromEntries(before.stock.filter(row=>row.id.startsWith('native-')).map(row=>[row.id,row.units])),{'native-destination':3,'native-source':7});
  assert.deepEqual(await program.stop(),{code:0,signal:null});program=start();await program.waitFor(value=>value.page===primary.id&&value.state==='running','same native SQL page reopened');
  assert.equal((await tendril(['--page',slug,'self'])).identity.publicKey,publicKey);assert.deepEqual((await query()).value,before);
  const original=await tendril(['--page',slug,'operation','sql-native-rejected']);assert.equal(original.proposalId,rejected.proposalId);assert.equal(original.materialized?.outcome,'rejected');
  report.optional_native_sql={passed:true,accepted:accepted.proposalId,rejected:rejected.proposalId,exactRetry:true,reopened:true};report.native_checks='passed';
  passed('actual optional full native SQL guarded transfer, rejected rollback, exact retry and same-state restart');
 }catch(error){failure=error;throw error;}
 finally{if(program){try{const stopped=await program.stop();report.optional_workspace_shutdown=stopped;assert.deepEqual(stopped,{code:0,signal:null});}catch(error){if(failure)throw new AggregateError([failure,error],'Native SQL qualification and shutdown failed',{cause:failure});throw error;}}}
}
