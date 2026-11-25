import { canonicalJson, CollaborationError, identifier } from './protocol.mjs';
export { createViewStore } from '@chronolog/peer-session';

/** A provider effect journal belongs to durable local storage, outside recoverable app history. */
export function createEffectDispatcher({ journal, dispatch, reconcile, authorize, session, allowProvisionalEffects = false }) {
  if (![journal?.transact, dispatch, authorize].every(value => typeof value === 'function')) throw new CollaborationError('EFFECT_JOURNAL_REQUIRED');
  if (typeof allowProvisionalEffects !== 'boolean') throw new CollaborationError('INVALID_EFFECT_POLICY');
  if (!allowProvisionalEffects && typeof session?.operations?.get !== 'function') throw new CollaborationError('EFFECT_FINALITY_SESSION_REQUIRED');
  return Object.freeze({
    async execute({ effectId, fence, input }) {
      identifier(effectId, 'effect'); const payload = canonicalJson(input);
      await authorize(fence);
      // authorize() is an application permission check, not a finality oracle.
      // Default irreversible dispatch requires the kernel's independently verified fact.
      let inspection = null;
      if (!allowProvisionalEffects) {
        const proposalId = fence?.claimProposalId;
        if (typeof proposalId !== 'string' || !/^[a-f0-9]{64}$/u.test(proposalId)) throw new CollaborationError('INVALID_EFFECT_FENCE');
        const operation = await session.operations.get(proposalId);
        inspection = operation ? await operation.inspect() : null;
        if (inspection && (inspection.proposalId !== proposalId || inspection.applicationId !== session.applicationId)) throw new CollaborationError('OPERATION_REFERENCE_CONFLICT');
      }
      const admitted = await journal.transact(effectId, previous => {
        if (previous) {
          if (previous.payload !== payload || canonicalJson(previous.fence) !== canonicalJson(fence)) throw new CollaborationError('EFFECT_ID_CONFLICT');
          return { record: previous, value: { existing: true, record: previous } };
        }
        if (!allowProvisionalEffects && (!inspection?.finalized || inspection.excluded || inspection.materialized?.outcome !== 'accepted'))
          throw new CollaborationError('EFFECT_FINALITY_PENDING', 'Current provisional claims do not authorize irreversible effects', { proposalId: fence.claimProposalId, observation: inspection });
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
