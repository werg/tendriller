import { canonicalJson, CollaborationError, identifier } from './protocol.mjs';
export { createViewStore } from '@chronolog/peer-session';

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
        const record = { effectId, idempotencyKey: journal.idempotencyKey?.(effectId) ?? effectId, payload, fence, status: 'dispatching' };
        return { record, value: { existing: false, record } };
      });
      if (admitted.existing) {
        if (admitted.record.status === 'completed') return admitted.record;
        const receipt = reconcile ? await reconcile(effectId, admitted.record) : null;
        if (receipt) return journal.transact(effectId, previous => {
          const record = previous.status === 'completed' ? previous : { ...previous, status: 'completed', receipt };
          return { record, value: record };
        });
        return { ...admitted.record, status: 'outcomeUnknown', nextAction: actionsForUnknown };
      }
      // Recheck after journaling. A failed check remains uncertain and never redispatches automatically.
      try {
        await authorize(fence);
        const receipt = await dispatch({ effectId, idempotencyKey: admitted.record.idempotencyKey, fence, input });
        return await journal.transact(effectId, previous => {
          const record = previous.status === 'completed' ? previous : { ...previous, status: 'completed', receipt };
          return { record, value: record };
        });
      } catch (error) {
        const retained = await journal.transact(effectId, previous => {
          const record = previous.status === 'completed' ? previous : { ...previous, status: 'outcomeUnknown', reason: String(error.code ?? error.name) };
          return { record, value: record };
        });
        if (retained.status === 'completed') return retained;
        throw new CollaborationError('EFFECT_OUTCOME_UNKNOWN', 'Inspect the retained effect before any further dispatch', { effectId });
      }
    },
  });
}
const actionsForUnknown = 'Reconcile the original provider effect identity; do not create another dispatch.';
