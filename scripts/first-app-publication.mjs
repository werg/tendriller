import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Reset-aware view of the independent `watch --events` consumer's JSON lines. The stream carries `status` lines (no events),
 * `snapshot` batches read from the current materialized projection, and `reset` markers: an earlier-authored operation
 * revised the projection, so the cursor restarts from null and the current events are re-delivered by the following
 * snapshots. Observed events therefore always mean "present in the current projection since the last reset"; a historical
 * event that the revised projection no longer contains is never counted as observed. No legacy line shape is accepted. */
export function createWatchConsumerView({ limit = 64 } = {}) {
  const batches = [];
  let current = [], resets = 0;
  return {
    accept(line) {
      const value = typeof line === 'string' ? JSON.parse(line) : line;
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'The watch consumer emitted a non-object line');
      if (value.kind === 'status') return null;
      assert.ok(value.revision && typeof value.revision.digest === 'string', 'Every event line names its materialized revision');
      if (value.kind === 'reset') {
        assert.equal(value.reason, 'materialization-revised');
        assert.ok(Array.isArray(value.events) && value.events.length === 0 && value.cursor === null, 'A reset carries no events and restarts at a null cursor');
        current = []; resets++;
      } else if (value.kind === 'snapshot') {
        assert.ok(Array.isArray(value.events) && typeof value.cursor === 'string', 'A snapshot carries current events and an opaque cursor');
        current.push(...value.events);
      } else throw Error('PUBLICATION_CONSUMER_UNKNOWN_LINE_KIND');
      if (batches.length >= limit) throw Error('PUBLICATION_CONSUMER_BATCH_LIMIT');
      batches.push(value);
      return value;
    },
    observed: text => current.some(event => event.payload?.text === text),
    get batches() { return batches; },
    get resets() { return resets; },
  };
}

/** The actual packed CLI attaches to the page owner inside the running agent program
 * while another CLI consumer and the browser stay live. `pageDirectory` is the page's
 * built output (pages/<slug>/dist); `workspace` is the workspace root. */
export async function qualifyFirstAppPublication({ page, pageUrl, publicationGateUrl, peer, expect, workspace, slug, pageDirectory, preload, cli, node }) {
  const args = ['--page', slug];
  const attached = async command => JSON.parse(await node([cli, ...args, ...command]));
  const ownerBefore = await attached(['self']);
  assert.equal(ownerBefore.endpoint.ownerInstanceId, (await peer.request('self')).ownerInstanceId);
  const browserDevice = await page.locator('#public-key').inputValue();
  // The preceding scenario reloads the browser; retained local notes alone do
  // not prove that its replacement authenticated transport has reconnected.
  await expect.poll(async () => (await peer.request('participation-log')).current.peers,
    { timeout: 30_000 }).toContain(browserDevice);
  const diagnosticsBefore = await peer.request('diagnostics');
  const publicationBefore = await attached(['publication']);
  const indexPath = join(pageDirectory, 'index.html');
  const proofPath = join(pageDirectory, 'resident-publication-proof.txt');
  const original = await readFile(indexPath, 'utf8');
  const firstHtml = original + '\n<!-- resident-owner-publication-one -->\n';
  const secondHtml = original + '\n<!-- resident-owner-publication-two -->\n';
  const proof = Buffer.from('attached-publication-proof\n' + 'p'.repeat(900_000));
  const proofHash = createHash('sha256').update(proof).digest('hex');
  const child = spawn(process.execPath, ['--import', preload, cli, ...args,
    'watch', '--events', '--topics', '["note.put","note.deleted"]'], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  const consumer = createWatchConsumerView(), batches = consumer.batches;
  let stderr = '', consumerFailure, consumerExit;
  const closed = new Promise(resolve => {
    child.once('error', error => { consumerFailure = error; });
    child.once('close', (code, signal) => { consumerExit = { code, signal }; resolve(consumerExit); });
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-6_000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { consumer.accept(line); }
    catch (error) { consumerFailure = error; child.kill('SIGTERM'); }
  });
  const alive = () => {
    if (consumerFailure) throw consumerFailure;
    assert.equal(consumerExit, undefined, 'The independent event consumer exited: ' + stderr);
  };
  const observed = text => consumer.observed(text);
  let result, primaryFailure, primaryEvidence, diagnosticsAfter, heldDocument, gateStarted = false, progress;
  const cleanupErrors = [], gateId = crypto.randomUUID();
  const gate = async action => {
    const response = await fetch(publicationGateUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, id: gateId, author: ownerBefore.identity.publicKey,
        previous: publicationBefore.publication.id, proofHash }),
      signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw Error('Publication gate ' + action + ' failed: ' + response.status);
    return response.json();
  };
  const evidence = () => ({ status: 'failed',
    connectionRevisionBefore: diagnosticsBefore.status.connectionRevision,
    connectionRevisionAfter: diagnosticsAfter?.status.connectionRevision ?? null,
    consumerBatches: batches.length, consumerExit: consumerExit ?? null,
    publicationProgress: progress ?? null });
  try {
    await expect.poll(() => { alive(); return batches.length; }, { timeout: 30_000 }).toBeGreaterThan(0);
    heldDocument = await page.evaluate(() => {
      const publication = window.tendril.publication, releaseHold = publication.hold();
      let offUpdate = () => {};
      const state = { id: crypto.randomUUID(), released: false, versions: [] };
      const release = () => {
        if (state.released) return;
        state.released = true;
        window.removeEventListener('pagehide', release);
        offUpdate(); releaseHold();
      };
      state.release = release;
      window.__firstAppPublicationHold = state;
      window.addEventListener('pagehide', release, { once: true });
      offUpdate = publication.onUpdate(({ version }) => state.versions.push(version));
      return state.id;
    });
    await writeFile(indexPath, firstHtml);
    await writeFile(proofPath, proof);
    const browserText = 'Browser work while the resident owner publishes';
    gateStarted = true;
    assert.equal((await gate('arm')).phase, 'armed');
    let publicationSettled = false, firstFailure;
    const failures = [];
    const retain = error => { firstFailure ??= error; if (!failures.includes(error)) failures.push(error); };
    const publish = attached(['publish', pageDirectory, '--operation', 'resident-publication-one'])
      .then(value => { publicationSettled = true; return value; },
        error => { publicationSettled = true; retain(error); throw error; });
    const browserCommand = (async () => {
      try {
        await expect.poll(async () => {
          if (publicationSettled) throw firstFailure ?? Error('Publication finished before browser progress.');
          progress = await gate('status');
          return progress.phase;
        }, { timeout: 30_000 }).toBe('held');
        assert.equal(progress.id, gateId); assert.equal(progress.matched, 1);
        await page.locator('#new').click(); await page.locator('#note').fill(browserText);
        await page.locator('#submit').click();
        await expect(page.locator('#operation-status')).toContainText('Materialized locally: accepted', { timeout: 30_000 });
        await expect(page.locator('#notes')).toContainText(browserText, { timeout: 30_000 });
        await expect.poll(() => { alive(); return observed(browserText); }, { timeout: 30_000 }).toBe(true);
        progress = await gate('status');
        assert.equal(progress.phase, 'held', 'Browser work must finish while the publication request is held.');
        assert.equal(publicationSettled, false, 'The resident publication must still be pending.');
        progress.browserCommandObservedWhileHeld = true;
      } catch (error) { retain(error); }
      finally {
        // Release even on browser failure, before joining the publisher behind this gate.
        try {
          const released = await gate('release');
          assert.equal(released.phase, 'released', 'The publication gate expired before release.');
        } catch (error) { retain(error); }
      }
      if (firstFailure) throw firstFailure;
    })();
    // Install both rejection handlers immediately; neither operation may outlive restoration.
    const settled = await Promise.allSettled([publish, browserCommand]);
    if (failures.length) throw failures.length === 1 ? failures[0]
      : new AggregateError(failures, firstFailure.message, { cause: firstFailure });
    const first = settled[0].value;
    assert.equal(progress.operationId, first.publication.payload.operationId,
      'The held request must be this exact signed publication operation.');
    assert.notEqual(first.publication.id, publicationBefore.publication.id);
    assert.equal(first.publication.payload.author, ownerBefore.identity.publicKey);
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
      error => /PEER_PUBLICATION_OPERATION_REUSED|Publication operation ID already binds another graph/u.test([error.message, error.stdout, error.stderr].join('\n')),
      'Changed bytes must not reuse the first signed publication identity.');
    const second = await attached(['publish', pageDirectory, '--operation', 'resident-publication-two']);
    assert.notEqual(second.publication.id, first.publication.id);
    assert.equal(second.publication.payload.previous, first.publication.id);
    await writeFile(indexPath, firstHtml);
    assert.deepEqual(await attached(['publish', pageDirectory, '--operation', 'resident-publication-one']), first,
      'A stale exact retry returns its retained receipt.');
    const selected = await attached(['publication']);
    assert.equal(selected.publication.id, second.publication.id,
      'A stale retry must not move the selected signed head backwards.');
    assert.ok(Number.isSafeInteger(selected.version) && selected.version > 0);
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
    assert.equal(ownerAfter.identity.publicKey, ownerBefore.identity.publicKey);
    diagnosticsAfter = await peer.request('diagnostics');
    assert.equal(diagnosticsAfter.status.connectionRevision, diagnosticsBefore.status.connectionRevision,
      'Signed publication must leave the held browser transport connected.');
    await expect.poll(() => page.evaluate(() => window.__firstAppPublicationHold?.versions.at(-1)),
      { timeout: 30_000 }).toBe(selected.version);
    const held = await page.evaluate(() => ({ id: window.__firstAppPublicationHold.id,
      released: window.__firstAppPublicationHold.released, versions: window.__firstAppPublicationHold.versions,
      updateAvailable: window.tendril.publication.updateAvailable }));
    assert.equal(held.id, heldDocument, 'The explicitly held document must survive publication.');
    assert.equal(held.released, false); assert.equal(held.updateAvailable, true);
    assert.equal(await page.locator('#public-key').inputValue(), browserDevice);
    alive();
    const [, holdReleased] = await Promise.all([
      page.waitForEvent('domcontentloaded', { timeout: 30_000 }),
      page.evaluate(() => {
        const held = window.__firstAppPublicationHold;
        if (!held || held.released) throw Error('Publication hold must stay active until the explicit switch.');
        // update() marks switching before release() rechecks automatic safety.
        window.tendril.publication.update();
        held.release();
        return held.released;
      }),
    ]);
    assert.equal(holdReleased, true);
    assert.equal(await page.evaluate(() => {
      const comments = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
      while (comments.nextNode()) if (comments.currentNode.textContent.trim() === 'resident-owner-publication-two') return true;
      return false;
    }), true, 'The explicit switch must load the selected signed document.');
    await expect(page.locator('#public-key')).toHaveValue(browserDevice, { timeout: 30_000 });
    await expect(page.locator('#connection-status')).toContainText('Local signing and storage ready', { timeout: 60_000 });
    await expect.poll(async () => (await peer.request('participation-log')).current.peers,
      { timeout: 30_000 }).toContain(browserDevice);
    await expect(page.locator('#notes')).toContainText(nativeText, { timeout: 30_000 });
    assert.equal((await attached(['self'])).endpoint.ownerInstanceId, ownerBefore.endpoint.ownerInstanceId);
    alive();
    result = { passed: true, ownerInstanceId: ownerBefore.endpoint.ownerInstanceId,
      publications: [first.publication.id, second.publication.id], selectedPublication: second.publication.id,
      stagedAssetBytes: proof.length, stagedAssetHash: proofHash, exactRetry: true, changedBytesRejected: true,
      staleRetryPreservedHead: true, consumerProcessStayedAlive: true, consumerBatches: batches.length,
      browserCommandObserved: true, publicationProgress: progress, nativeCommandObservedAfterPublisherDetach: true,
      unchangedConnectionRevision: diagnosticsAfter.status.connectionRevision,
      browserUpdatePolicy: { hold: 'public publication.hold()', observedVersions: held.versions,
        connectionCheckedWhileHeld: true, switch: 'explicit public publication.update()', holdReleased,
        selectedVersion: selected.version, selectedDocumentObserved: true, authenticatedSessionAfterUpdate: true } };
  } catch (error) {
    primaryFailure = error;
    primaryEvidence = error.publicationQualification ?? evidence();
    error.publicationQualification = primaryEvidence;
  } finally {
    const clean = async action => { try { await action(); } catch (error) { cleanupErrors.push(error); } };
    if (gateStarted) await clean(() => gate('reset'));
    await clean(async () => {
      if (!page.isClosed()) await page.evaluate(() => window.__firstAppPublicationHold?.release());
    });
    await clean(async () => {
      let timer;
      try {
        if (!consumerExit) child.kill('SIGTERM');
        const exit = await Promise.race([closed, new Promise((_resolve, reject) => {
          timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Event consumer did not detach within five seconds.')); }, 5_000);
        })]);
        assert.deepEqual(exit, { code: 0, signal: null }, 'Event consumer must detach gracefully: ' + stderr);
      } finally { clearTimeout(timer); }
    });
    await clean(() => lines.close());
    await clean(() => writeFile(indexPath, original));
    await clean(() => rm(proofPath, { force: true }));
  }
  const failures = [...(primaryFailure ? [primaryFailure] : []), ...cleanupErrors];
  if (failures.length) {
    const error = failures.length === 1 ? failures[0] : new AggregateError(failures,
      (primaryFailure?.message ?? 'Publication cleanup failed') + '; additional cleanup failures',
      { cause: primaryFailure ?? failures[0] });
    error.publicationQualification = primaryEvidence ?? evidence();
    throw error;
  }
  return result;
}
