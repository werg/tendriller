import assert from 'node:assert/strict';

/** Serialized into the independent public-package native fixture. */
export async function createRecoveryQualification(owned) {
  const { default: assert } = await import('node:assert/strict');
  const { mkdtemp, readFile, writeFile, rename } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const { forwardSessionEvents } = await import('@chronolog/peer-session');
  const { session } = owned;
  const stop = new AbortController();
  const operationId = 'first-app-recovery-pending';
  const topics = ['note'];
  let active, closing;
  const evidence = error => ({ code: error?.code ?? error?.message,
    revision: error?.revision ?? null, recovery: error?.recovery ?? null });
  const wait = async (predicate, message, timeoutMs = 25_000) => {
    const deadline = performance.now() + timeoutMs;
    while (!predicate()) {
      if (performance.now() >= deadline) throw Error(message);
      stop.signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const scan = async () => {
    const view = await session.readView();
    try {
      let cursor, batch;
      const events = [];
      do {
        batch = await view.readEvents({ topics, limit: 128, ...(cursor === undefined ? {} : { cursor }) });
        assert.ok(batch.cursor !== cursor || !batch.hasMore, 'Recovery rescan must make progress.');
        events.push(...batch.events); cursor = batch.cursor;
      } while (batch.hasMore);
      return { events, cursor, revision: batch.revision };
    } finally { await view.release(); }
  };
  const close = () => closing ??= (async () => {
    stop.abort(Error('RECOVERY_QUALIFICATION_CLOSED'));
    if (!active) return;
    if (active.watch.exitCode === null && active.watch.signalCode === null) active.watch.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([Promise.all([active.directTask, active.forwardTask, active.watchEnded]),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error('Recovery observers did not close.')), 5_000); })]);
    } finally {
      clearTimeout(timer);
      if (active.watch.exitCode === null && active.watch.signalCode === null) active.watch.kill('SIGKILL');
    }
  })();
  return {
    actions: {
      async 'recovery-arm'() {
        assert.equal(active, undefined, 'Recovery qualification has one explicit lifetime.');
        const initial = await scan();
        const directory = await mkdtemp(join(process.cwd(), '.recovery-qualification-'));
        const checkpointFile = join(directory, 'handled.json');
        const readCheckpoint = async () => JSON.parse(await readFile(checkpointFile, 'utf8'));
        const saveCheckpoint = async checkpoint => {
          await writeFile(checkpointFile + '.pending', JSON.stringify(checkpoint), { mode: 0o600 });
          await rename(checkpointFile + '.pending', checkpointFile);
        };
        await saveCheckpoint({ cursor: initial.cursor, receipts: {} });
        const state = active = { initial, checkpointFile, readCheckpoint, saveCheckpoint,
          directReady: false, forwardReady: false, deliveryEntered: false, deliveryAborted: false,
          directCursor: initial.cursor, directOperations: [], watchBatches: [], checkpointSaves: 0 };

        // This is an actual separate CLI process attached to the resident owner.
        // Starting without a cursor observes its initial batch; that observation
        // is explicitly distinct from our durable handled checkpoint above.
        const cli = join(process.cwd(), 'node_modules/@tendriller/tools/bin/tendril.mjs');
        state.watch = spawn(process.execPath, [...process.execArgv, cli, '--session', join(process.cwd(), 'session.mjs'),
          '--mode', 'attach', 'watch', '--events', '--topics', JSON.stringify(topics)],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        state.watch.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-32_768); });
        createInterface({ input: state.watch.stdout }).on('line', line => {
          try {
            const batch = JSON.parse(line);
            if (batch.cursor && Array.isArray(batch.events)) {
              if (state.watchBatches.length >= 32) throw Error('Recovery watch exceeded its fixture bound.');
              state.watchBatches.push(batch);
            }
          } catch (error) { state.watchParseFailure = error; }
        });
        state.watchEnded = new Promise(resolve => {
          state.watch.once('error', error => { state.watchFailure = error; resolve(); });
          state.watch.once('close', (code, signal) => {
            state.watchExit = { code, signal };
            for (const line of stderr.trim().split('\n')) {
              try { const value = JSON.parse(line); if (value.error) state.watchFailure = value; } catch {}
            }
            resolve();
          });
        });

        state.directTask = (async () => {
          for await (const _change of session.changes({ signal: stop.signal })) {
            const view = await session.readView();
            try {
              let batch;
              do {
                batch = await view.readEvents({ topics, cursor: state.directCursor });
                state.directOperations.push(...batch.events.map(event => event.operationId));
                state.directCursor = batch.cursor;
              } while (batch.hasMore);
              state.directReady = true;
            } finally { await view.release(); }
          }
        })().catch(error => { state.directFailure = error; });

        state.forwardTask = forwardSessionEvents({
          session: { signal: session.signal, changes: options => session.changes(options),
            readView: async () => { const view = await session.readView(); state.forwardReady = true; return view; } },
          topics, signal: stop.signal,
          checkpoint: {
            load: async () => (await readCheckpoint()).cursor,
            save: async cursor => {
              state.checkpointSaves++;
              const checkpoint = await readCheckpoint(); checkpoint.cursor = cursor;
              await saveCheckpoint(checkpoint);
            },
          },
          project: event => event.operationId === operationId ? event : null,
          deliver: async (event, _original, _batch, signal) => {
            assert.equal(event.author, session.deviceId);
            const reference = `${session.applicationId}:${event.author}:${event.operationId}`;
            const checkpoint = await readCheckpoint();
            assert.equal(checkpoint.receipts[reference], undefined);
            // A durable receipt precedes checkpoint advancement. If enrollment
            // interrupts this callback, replay reconciles this same work reference.
            checkpoint.receipts[reference] = { state: 'reconciled', effects: 1 };
            await saveCheckpoint(checkpoint);
            state.reference = reference; state.deliveryEntered = true;
            await new Promise((_resolve, reject) => {
              const aborted = () => { state.deliveryAborted = true; reject(signal.reason); };
              if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
            });
          },
        }).catch(error => { state.forwardFailure = error; });

        await wait(() => state.directReady && state.forwardReady && state.watchBatches.length > 0,
          'The direct reader, attached CLI watch and forwarder must be active before enrollment.');
        assert.equal(state.watchBatches.at(-1).cursor, initial.cursor);
        const command = await session.command('addNote', { text: 'Pending recovery qualification work' }, { operationId });
        await command.applied({ signal: AbortSignal.timeout(25_000) });
        await wait(() => state.deliveryEntered && state.directOperations.includes(operationId) &&
          state.watchBatches.some(batch => batch.events.some(event => event.operationId === operationId)),
        'All three consumers must observe pending work before browser enrollment.');
        assert.equal(state.directFailure, undefined); assert.equal(state.forwardFailure, undefined);
        assert.equal(state.watchFailure, undefined); assert.equal(state.watchParseFailure, undefined);
        assert.equal((await readCheckpoint()).cursor, initial.cursor);
        state.pendingCursor = state.directCursor;
        return { armed: true, deliveryPending: true, generation: initial.revision.generation,
          ownerInstanceId: owned.supervisor.ownerInstanceId };
      },

      async 'recovery-verify'() {
        const state = active; assert.ok(state?.deliveryEntered);
        await wait(() => state.directFailure && state.forwardFailure && state.watchExit,
          'Enrollment must stop every old-generation consumer with explicit evidence.');
        const direct = evidence(state.directFailure), forwarded = evidence(state.forwardFailure);
        const watched = { code: state.watchFailure?.error?.code,
          revision: state.watchFailure?.revision, recovery: state.watchFailure?.recovery };
        assert.equal(direct.code, 'APPLICATION_VIEW_RECOVERED');
        assert.equal(forwarded.code, 'EVENT_FORWARDER_REVIEW_RECOVERY');
        assert.equal(watched.code, 'APPLICATION_VIEW_RECOVERED');
        assert.deepEqual(watched.revision, direct.revision); assert.deepEqual(forwarded.revision, direct.revision);
        assert.deepEqual(watched.recovery, direct.recovery); assert.deepEqual(forwarded.recovery, direct.recovery);
        assert.equal(direct.recovery.reason, 'control-change'); assert.equal(direct.recovery.unknownLoss, true);
        assert.ok(direct.recovery.adopted); assert.notEqual(direct.revision.generation, state.initial.revision.generation);
        assert.deepEqual(state.watchExit, { code: 1, signal: null });
        assert.equal(state.watchFailure.watch.cursor, state.pendingCursor);
        assert.equal(state.deliveryAborted, true); assert.equal(state.checkpointSaves, 0);
        assert.equal((await state.readCheckpoint()).cursor, state.initial.cursor,
          'An observed cursor must never become a handled checkpoint after interrupted delivery.');

        const view = await session.readView();
        let selected;
        try {
          await assert.rejects(async () => view.readEvents({ topics, cursor: state.initial.cursor }),
            error => error.code === 'APPLICATION_VIEW_RECOVERED' && error.recovery?.unknownLoss === true);
          selected = await view.readEvents({ topics });
          assert.throws(() => view.readEvents({ topics: ['different'], cursor: selected.cursor }), /APPLICATION_EVENT_CURSOR_INVALID/);
          // Deliberately corrupt opaque cursors only for rejection qualification;
          // the recovery recipe never rewrites or translates an issued cursor.
          const decoded = JSON.parse(selected.cursor);
          assert.throws(() => view.readEvents({ topics, cursor: JSON.stringify({ ...decoded, anchor: '0'.repeat(64) }) }),
            /APPLICATION_EVENT_CURSOR_INVALID/);
          assert.throws(() => view.readEvents({ topics, cursor: JSON.stringify({ ...decoded, historyId: 'unknown-history' }) }),
            error => error.code === 'APPLICATION_VIEW_RECOVERED' && error.recovery === null);
        } finally { await view.release(); }

        // Reopen the durable work records on each pass, as a restarted consumer
        // does. Deliberate rescans may redeliver; a reconciled receipt is reused.
        let redelivered = 0;
        for (let restart = 0; restart < 2; restart++) {
          const selected = await scan(), checkpoint = await state.readCheckpoint();
          const pending = selected.events.filter(event => event.operationId === operationId);
          assert.equal(pending.length, 1, 'The verified selected history must retain the pending operation.');
          for (const event of pending) {
            const reference = `${session.applicationId}:${event.author}:${event.operationId}`;
            assert.equal(reference, state.reference);
            assert.deepEqual(checkpoint.receipts[reference], { state: 'reconciled', effects: 1 });
            redelivered++;
          }
          checkpoint.cursor = selected.cursor; await state.saveCheckpoint(checkpoint);
        }
        const durable = await state.readCheckpoint();
        assert.deepEqual(durable.receipts[state.reference], { state: 'reconciled', effects: 1 });
        assert.notEqual(durable.cursor, state.initial.cursor);
        return { status: 'passed', direct, attachedWatch: watched, forwarder: forwarded,
          deliveryInterrupted: state.deliveryAborted, oldCheckpointPreserved: state.checkpointSaves === 0,
          deliberateRescans: redelivered, reconciledEffects: durable.receipts[state.reference].effects,
          invalidTopicsRejected: true, invalidAnchorRejected: true, missingEvidenceStops: true,
          ownerInstanceId: owned.supervisor.ownerInstanceId };
      },
      async 'recovery-close'() { await close(); return { closed: true }; },
    },
    close,
  };
}

/** Enroll a genuinely new browser device while all three native consumers run. */
export async function qualifyFirstAppRecovery({ browser, page, pageUrl, peer, expect }) {
  const before = await peer.request('recovery-arm', {}, 60_000);
  assert.equal(before.armed, true); assert.equal(before.deliveryPending, true);
  const originalDevice = await page.locator('#device-key').inputValue();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    storageState: { cookies: await page.context().cookies(), origins: [] } });
  try {
    const fresh = await context.newPage();
    await fresh.goto(pageUrl);
    await expect(fresh.locator('#device-key')).toHaveValue(/^[a-f0-9]{64}$/, { timeout: 30_000 });
    const newDevice = await fresh.locator('#device-key').inputValue();
    assert.notEqual(newDevice, originalDevice, 'A fresh browser must enroll a new signing identity.');
    await expect(fresh.locator('#app-content')).toBeVisible({ timeout: 60_000 });
    await expect(fresh.locator('#connection-card')).toBeHidden();
    await expect(fresh.locator('#data-status')).toContainText('Data: ready; application: ready', { timeout: 60_000 });
    const result = await peer.request('recovery-verify', {}, 45_000);
    assert.equal(result.ownerInstanceId, before.ownerInstanceId, 'Enrollment must preserve the resident owner.');
    await fresh.locator('#note').fill('Browser command after reviewed recovery');
    await fresh.locator('#submit').click();
    await expect(fresh.locator('#result')).toContainText('Applied: accepted', { timeout: 30_000 });
    await expect.poll(async () => (await peer.request('query')).value.some(note =>
      note.author === newDevice && note.text === 'Browser command after reviewed recovery'), { timeout: 30_000 }).toBe(true);
    return { ...result, newBrowserEnrolled: true, subsequentBrowserCommand: true,
      limits: ['Local Chromium and native session with a synthetic owner; no live OAuth or physical-device claim.',
        'The durable receipt fixture qualifies explicit rescan/reconciliation, not exactly-once external effects.',
        'Actual history truncation and missing/unknown wire evidence are separately covered by the pinned kernel recovery tests.'] };
  } finally {
    await context.close();
    await peer.request('recovery-close');
  }
}
