// One optional page inside the workspace's single agent program.
// Chronolog v2: zero native C/C++ builds, built-in QuickJS-NG + sqlite-cas.wasm,
// and atomic `$permissions` + `$keys` admission.
import { bytesToHex, createApplicationSession, describeApplication, encodeSignedOperation, genesisLogId, hexToBytes, verifySignedOperation } from '@chronolog/peer-session';
import { createApplicationOwner } from '@chronolog/peer-session/worker';
import { authorityRecord, authorityRecordBytes } from '@tendriller/core/authority';
import { createAdmission, openPageGenesis } from '@tendriller/core/admission';
import { participateNativeApplication } from '@tendriller/core/native-rtc';
import { watchApplicationSetup } from '@tendriller/core/setup';
import { createHash } from 'node:crypto';
import { superviseParticipant } from './participant-lifecycle.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');

export function publicationControl(context, definition) {
  return Object.freeze({
    definition: async () => ({ definition: describeApplication(definition) }),
    publication: () => context.host.peers.publication(),
    async publicationOperation(id) {
      const saved = await context.readPrivate(`pub-v2-${digest(id)}.json`, true);
      return saved ? {
        op: saved.op,
        opId: saved.opId,
        operationId: saved.operationId,
        receipt: await context.host.peers.publication(saved.opId),
      } : null;
    },
    async preparePublication({ operationId, entry = 'index.html', files }) {
      const name = `pub-v2-${digest(operationId)}.json`;
      const saved = await context.readPrivate(name, true);
      if (saved) {
        if (saved.entry !== entry || JSON.stringify(saved.files) !== JSON.stringify(files)) {
          throw Object.assign(Error('Publication operation ID already binds another graph'), { code: 'PEER_PUBLICATION_OPERATION_REUSED' });
        }
        return saved.op;
      }
      const metadata = await context.host.peers.application();
      const targetLogId = metadata.genesis
        ? bytesToHex(genesisLogId(authorityRecordBytes(metadata.genesis, 1024 * 1024)))
        : metadata.selection.id;
      const previous = await context.host.peers.publication();
      const { signOperationCore } = await import('@chronolog/peer-session/kernel');
      const signed = await signOperationCore({
        version: 1,
        logId: hexToBytes(targetLogId),
        author: hexToBytes(context.signer.publicKey),
        operationId,
        authorTimestampMs: BigInt(Date.now()),
        nonce: crypto.getRandomValues(new Uint8Array(16)),
        visibility: 'public',
        updates: [{
          topic: '$publications',
          input: {
            action: 'publish',
            entry,
            files,
            ...(previous ? { previous: previous.opId, expectedRevision: previous.revision } : {}),
          },
        }],
      }, context.signer.privateKey);
      const { opId: opIdBytes } = await verifySignedOperation(signed);
      const opId = bytesToHex(opIdBytes);
      const op = authorityRecord(encodeSignedOperation(signed));
      await context.savePrivate(name, { entry, files, op, opId, operationId });
      return op;
    },
    publish: (op, assets) => context.host.peers.publish(op, assets),
  });
}

export async function openNativePage(context, { definition, imports, topics, assistant, onEpochRotated } = {}) {
  context.signal?.throwIfAborted();
  const initialized = await context.readPrivate('initialized.json', true);
  if (initialized?.applicationId !== context.page.applicationId || initialized.publicKey !== context.signer.publicKey) {
    throw Object.assign(Error(`Run npm run init -- ${context.page.slug} first; browser reads and Save never require the agent`), { code: 'native_page_init_required' });
  }
  const device = await context.openDevice({ create: true });
  let session, participation, lifecycle, admission;
  try {
    const opened = await openPageGenesis({
      store: device.store,
      identity: device.identity,
      wrapKey: context.wrapKey,
      peers: context.host.peers,
      applicationId: context.page.applicationId,
      imports,
      topics,
      create: false,
      signal: context.signal,
    });
    const epochKeys = opened.epoch0Key ? new Map([[0, opened.epoch0Key]]) : undefined;
    session = await createApplicationSession({
      device,
      applicationId: context.page.applicationId,
      genesis: opened.genesisBytes,
      casNodes: opened.casNodes,
      ...(epochKeys ? { epochKeys } : {}),
      definition,
    });
    if (opened.publicOps.length > 0) {
      await session.mergeFacts({
        publicOps: opened.publicOps,
        encryptedEnvelopes: [],
        casNodes: opened.casNodes,
        retentions: [],
        checkpoints: [],
      });
    }
    admission = createAdmission(session, {
      peers: context.host.peers,
      wrapKey: context.wrapKey,
      store: device.store,
      subject: 'agent',
      ...(onEpochRotated ? { onEpochRotated } : {}),
      onEvent: notice => context.report({ admission: notice.kind, publicKey: notice.publicKey, label: notice.label ?? null, ...(notice.reason ? { reason: notice.reason } : {}), ...(notice.error ? { error: notice.error } : {}) }),
    });
    let phase;
    admission.subscribe(state => { if (state.phase !== phase) { phase = state.phase; context.report({ admission: 'phase', phase }); } });
    participation = participateNativeApplication(session, { peers: context.host.peers, onNotification: () => void admission.refresh() });
    let optional = {};
    try { if (assistant) optional = await assistant({ context, session }); }
    catch (error) { context.report({ state: 'optional_assistant_unavailable', code: /^[A-Za-z0-9_]{1,96}$/.test(error?.code ?? '') ? error.code : 'assistant_configuration_unavailable', participantRunning: true }); }
    const owned = { session, participation };
    lifecycle = superviseParticipant({ owned, signal: context.signal, report: context.report, watch: callbacks => watchApplicationSetup({ page: context.host, ...callbacks }), ...optional });
    const owner = createApplicationOwner(session, { extensions: admission.extensions });
    const close = owner.close.bind(owner);
    let closing;
    return Object.assign(owner, {
      control: publicationControl(context, definition),
      participation,
      admission,
      close: () => closing ??= (async () => {
        const errors = [];
        for (const finish of [() => admission.close(), () => lifecycle.close(), () => participation.close(), close]) {
          try { await finish(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Native page cleanup failed', { cause: errors[0] });
      })(),
    });
  } catch (error) {
    const errors = [error];
    for (const finish of [() => admission?.close(), () => lifecycle?.close(), () => participation?.close(), () => session ? session.close() : device.close()]) {
      try { await finish(); } catch (cleanup) { errors.push(cleanup); }
    }
    if (errors.length > 1) throw new AggregateError(errors, 'Native page opening and cleanup failed', { cause: error });
    throw error;
  }
}
