import { canonicalJson, CollaborationError, identifier, signerId } from './protocol.mjs';

/** Per-key writes avoid a shared read/modify/write list that loses sibling references. */
export function createViewStore({ storage, applicationId, profileId, viewId }) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new CollaborationError('LOCAL_STORAGE_UNAVAILABLE');
  [applicationId, profileId, viewId].forEach(value => identifier(value));
  const prefix = `tendriller:collaboration:v1:${applicationId}:${profileId}:`;
  const viewPrefix = `${prefix}view:${viewId}:`;
  function read(key) {
    const value = storage.getItem(key);
    if (value === null) return null;
    try { return JSON.parse(value); } catch { throw new CollaborationError('LOCAL_REFERENCE_CORRUPT', 'Preserve and inspect the local record before replacing it'); }
  }
  function write(key, value) {
    try { storage.setItem(key, canonicalJson(value, 65536)); }
    catch (error) { throw new CollaborationError('LOCAL_STORAGE_UNAVAILABLE', `Could not retain the local record: ${error.message}`); }
  }
  function operationKey(reference) {
    if (reference.applicationId !== applicationId) throw new CollaborationError('OPERATION_SCOPE_MISMATCH');
    return `${prefix}operation:${signerId(reference.author)}:${identifier(reference.operationId)}:view:${viewId}`;
  }
  return Object.freeze({ viewId,
    readDraft(draftId = 'main') { return read(`${viewPrefix}draft:${identifier(draftId)}`); },
    writeDraft(value, draftId = 'main') { write(`${viewPrefix}draft:${identifier(draftId)}`, value); },
    removeDraft(draftId = 'main') { storage.removeItem(`${viewPrefix}draft:${identifier(draftId)}`); },
    retainOperation(reference, context = {}) {
      const key = operationKey(reference), existing = read(key);
      const value = { reference, viewId, context };
      if (existing && canonicalJson(existing.context, 65536) !== canonicalJson(context, 65536))
        throw new CollaborationError('OPERATION_REFERENCE_CONFLICT', 'The original operation input must remain unchanged');
      write(key, existing ?? value); return existing ?? value;
    },
    inspectOperation(reference) { return read(operationKey(reference)); },
    removeOperation(reference) { storage.removeItem(operationKey(reference)); },
    pending({ allViews = false } = {}) {
      const values = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(`${prefix}operation:`)) { const value = read(key); if (value && (allViews || value.viewId === viewId)) values.push(value); }
      }
      return values.sort((a, b) => a.reference.operationId.localeCompare(b.reference.operationId));
    },
  });
}

/** A provider effect journal belongs to durable local storage, outside recoverable app history. */
export function createEffectDispatcher({ journal, dispatch, reconcile, authorize }) {
  if (![journal?.transact, dispatch, authorize].every(value => typeof value === 'function')) throw new CollaborationError('EFFECT_JOURNAL_REQUIRED');
  return Object.freeze({
    async execute({ effectId, fence, input }) {
      identifier(effectId, 'effect'); const payload = canonicalJson(input);
      await authorize(fence);
      const admitted = await journal.transact(effectId, previous => {
        if (previous) {
          if (previous.payload !== payload || canonicalJson(previous.fence) !== canonicalJson(fence)) throw new CollaborationError('EFFECT_ID_CONFLICT');
          return { record: previous, value: { existing: true, record: previous } };
        }
        const record = { effectId, payload, fence, status: 'dispatching' };
        return { record, value: { existing: false, record } };
      });
      if (admitted.existing) {
        if (admitted.record.status === 'completed') return admitted.record;
        const receipt = reconcile ? await reconcile(effectId, admitted.record) : null;
        if (receipt) return journal.transact(effectId, previous => ({ record: { ...previous, status: 'completed', receipt }, value: { ...previous, status: 'completed', receipt } }));
        return { ...admitted.record, status: 'outcomeUnknown', nextAction: actionsForUnknown };
      }
      // Recheck after journaling. A failed check remains uncertain and never redispatches automatically.
      try {
        await authorize(fence);
        const receipt = await dispatch({ effectId, idempotencyKey: effectId, fence, input });
        return await journal.transact(effectId, previous => ({ record: { ...previous, status: 'completed', receipt }, value: { ...previous, status: 'completed', receipt } }));
      } catch (error) {
        await journal.transact(effectId, previous => ({ record: { ...previous, status: 'outcomeUnknown', reason: String(error.code ?? error.name) }, value: null }));
        throw new CollaborationError('EFFECT_OUTCOME_UNKNOWN', 'Inspect the retained effect before any further dispatch', { effectId });
      }
    },
  });
}
const actionsForUnknown = 'Reconcile the original provider effect identity; do not create another dispatch.';
