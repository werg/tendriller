import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** The actual packed CLI attaches while another CLI consumer and browser stay live. */
export async function qualifyFirstAppPublication({ page, pageUrl, peer, expect, app, project, preload, cli, node }) {
  const args = ['--session', join(project, 'session.mjs'), '--mode', 'attach'];
  const attached = async command => JSON.parse(await node([cli, ...args, ...command]));
  const ownerBefore = await attached(['self']);
  assert.equal(ownerBefore.endpoint.ownerInstanceId, peer.metadata.ownerInstanceId);
  const browserDevice = await page.locator('#device-key').inputValue();
  // The preceding scenario reloads the browser; retained local notes alone do
  // not prove that its replacement authenticated transport has reconnected.
  await expect.poll(async () => (await peer.request('participation-log')).current.peers,
    { timeout: 30_000 }).toContain(browserDevice);
  const diagnosticsBefore = await peer.request('diagnostics');
  const publicationBefore = await attached(['publication']);
  const pageDirectory = join(app, 'page'), indexPath = join(pageDirectory, 'index.html');
  const proofPath = join(pageDirectory, 'resident-publication-proof.txt');
  const original = await readFile(indexPath, 'utf8');
  const firstHtml = original + '\n<!-- resident-owner-publication-one -->\n';
  const secondHtml = original + '\n<!-- resident-owner-publication-two -->\n';
  const proof = Buffer.from('attached-publication-proof\n' + 'p'.repeat(900_000));
  const proofHash = createHash('sha256').update(proof).digest('hex');
  const child = spawn(process.execPath, ['--import', preload, cli, ...args,
    'watch', '--events', '--topics', '["note"]'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  const batches = [];
  let stderr = '', consumerFailure, consumerExit;
  const closed = new Promise(resolve => {
    child.once('error', error => { consumerFailure = error; });
    child.once('close', (code, signal) => { consumerExit = { code, signal }; resolve(consumerExit); });
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-6_000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const batch = JSON.parse(line);
      assert.ok(Array.isArray(batch.events) && typeof batch.cursor === 'string');
      if (batches.length >= 64) throw Error('PUBLICATION_CONSUMER_BATCH_LIMIT');
      batches.push(batch);
    } catch (error) { consumerFailure = error; child.kill('SIGTERM'); }
  });
  const alive = () => {
    if (consumerFailure) throw consumerFailure;
    assert.equal(consumerExit, undefined, 'The independent event consumer exited: ' + stderr);
  };
  const observed = text => batches.some(batch => batch.events.some(event => event.payload?.text === text));
  let result, primaryFailure, diagnosticsAfter;
  try {
    await expect.poll(() => { alive(); return batches.length; }, { timeout: 30_000 }).toBeGreaterThan(0);
    await writeFile(indexPath, firstHtml);
    await writeFile(proofPath, proof);
    const browserText = 'Browser work while the resident owner publishes';
    const publish = attached(['publish', pageDirectory, '--operation', 'resident-publication-one']);
    const browserCommand = (async () => {
      await page.locator('#note').fill(browserText);
      await page.locator('#submit').click();
      await expect(page.locator('#notes')).toContainText(browserText, { timeout: 30_000 });
    })();
    const [first] = await Promise.all([publish, browserCommand]);
    assert.notEqual(first.publication.id, publicationBefore.publication.id);
    assert.equal(first.publication.payload.author, ownerBefore.deviceId);
    const signedProof = first.publication.payload.files.find(file => file.path === 'resident-publication-proof.txt');
    assert.equal(signedProof?.hash, proofHash);
    assert.equal(signedProof?.size, proof.length);
    assert.equal((await attached(['publication'])).publication.id, first.publication.id);
    const retained = await attached(['publication-operation', 'resident-publication-one']);
    assert.deepEqual(retained, { publication: first.publication, receipt: first });
    assert.deepEqual(await attached(['publish', pageDirectory, '--operation', 'resident-publication-one']), first);
    await expect.poll(() => { alive(); return observed(browserText); }, { timeout: 30_000 }).toBe(true);

    await writeFile(indexPath, secondHtml);
    await assert.rejects(() => attached(['publish', pageDirectory, '--operation', 'resident-publication-one']),
      error => /PEER_PUBLICATION_OPERATION_REUSED/u.test([error.message, error.stdout, error.stderr].join('\n')),
      'Changed bytes must not reuse the first signed publication identity.');
    const second = await attached(['publish', pageDirectory, '--operation', 'resident-publication-two']);
    assert.notEqual(second.publication.id, first.publication.id);
    assert.equal(second.publication.payload.previous, first.publication.id);
    await writeFile(indexPath, firstHtml);
    assert.deepEqual(await attached(['publish', pageDirectory, '--operation', 'resident-publication-one']), first,
      'A stale exact retry returns its retained receipt.');
    assert.equal((await attached(['publication'])).publication.id, second.publication.id,
      'A stale retry must not move the selected signed head backwards.');
    await writeFile(indexPath, secondHtml);
    assert.equal(new URL(pageUrl).origin, new URL(page.url()).origin,
      'Use the canonical browser origin; the loopback transport port is not an application origin.');
    const served = await page.evaluate(async pageUrl => {
      const selected = await fetch(pageUrl, { cache: 'no-store' });
      const selectedHtml = await selected.text();
      const proof = await fetch(new URL('resident-publication-proof.txt', selected.url), { cache: 'no-store' });
      const digest = await crypto.subtle.digest('SHA-256', await proof.arrayBuffer());
      return { status: selected.status, marker: selectedHtml.includes('resident-owner-publication-two'),
        proofStatus: proof.status, proofHash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
    }, pageUrl);
    assert.equal(served.status, 200); assert.equal(served.marker, true);
    assert.equal(served.proofStatus, 200); assert.equal(served.proofHash, proofHash);

    const nativeText = 'Native work after the publisher attachment disconnects';
    const native = await peer.request('command', { text: nativeText, operationId: 'resident-publication-after-disconnect' });
    assert.equal(native.outcome, 'accepted');
    await expect(page.locator('#notes')).toContainText(nativeText, { timeout: 30_000 });
    await expect.poll(() => { alive(); return observed(nativeText); }, { timeout: 30_000 }).toBe(true);
    const ownerAfter = await attached(['self']);
    assert.equal(ownerAfter.endpoint.ownerInstanceId, ownerBefore.endpoint.ownerInstanceId);
    assert.equal(ownerAfter.deviceId, ownerBefore.deviceId);
    diagnosticsAfter = await peer.request('diagnostics');
    assert.equal(diagnosticsAfter.participation.connectionRevision, diagnosticsBefore.participation.connectionRevision,
      'Signed publication must leave the browser transport connected.');
    alive();
    result = { passed: true, ownerInstanceId: ownerBefore.endpoint.ownerInstanceId,
      publications: [first.publication.id, second.publication.id], selectedPublication: second.publication.id,
      stagedAssetBytes: proof.length, stagedAssetHash: proofHash, exactRetry: true, changedBytesRejected: true,
      staleRetryPreservedHead: true, consumerProcessStayedAlive: true, consumerBatches: batches.length,
      browserCommandObserved: true, nativeCommandObservedAfterPublisherDetach: true,
      unchangedConnectionRevision: diagnosticsAfter.participation.connectionRevision };
  } catch (error) {
    primaryFailure = error;
    error.publicationQualification = { status: 'failed',
      connectionRevisionBefore: diagnosticsBefore.participation.connectionRevision,
      connectionRevisionAfter: diagnosticsAfter?.participation.connectionRevision ?? null,
      consumerBatches: batches.length, consumerExit: consumerExit ?? null };
  }
  finally {
    let timer;
    try {
      if (!consumerExit) child.kill('SIGTERM');
      const exit = await Promise.race([closed, new Promise((_resolve, reject) => {
        timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Event consumer did not detach within five seconds.')); }, 5_000);
      })]);
      assert.deepEqual(exit, { code: 0, signal: null }, 'Event consumer must detach gracefully: ' + stderr);
    } catch (error) {
      primaryFailure = primaryFailure ? new AggregateError([primaryFailure, error], primaryFailure.message + '; event consumer cleanup failed') : error;
    } finally {
      clearTimeout(timer); lines.close();
      await writeFile(indexPath, original); await rm(proofPath, { force: true });
    }
  }
  if (primaryFailure) throw primaryFailure;
  return result;
}
