import { createHash } from 'node:crypto';
import { superviseParticipant } from './support/participant-lifecycle.mjs';

/** Resume the existing proposal. Never re-propose or dial an adapter before exact owner approval. */
export function retainedReviewProposal(record, key) {
  return typeof record?.proposed === 'string' && /^[a-f0-9]{64}$/.test(record.proposed) && typeof key === 'string' &&
    record.adapterHash === createHash('sha256').update(key).digest('hex') ? record.proposed : undefined;
}
export function superviseReviewAssistant({ session, signal, watch, expectedProposalId, processPairings, startAdapter, onOnline, report }) {
  const proposalId = typeof expectedProposalId === 'string' && /^[a-f0-9]{64}$/.test(expectedProposalId) ? expectedProposalId : undefined;
  if (!proposalId) report?.({ state: 'assistant_proposal_identity_required', participantRunning: true });
  let forwardingBlocked = false;
  return superviseParticipant({ owned: { session, processPairings }, signal, proposalId, watch,
    startAdapter, report,
    onOnline: onOnline ? async (assistant, lifetime) => {
      if (forwardingBlocked) return;
      try { await onOnline(assistant, lifetime); }
      catch (error) {
        if (lifetime.aborted) return;
        // An event cursor needing review must not reconnect a healthy tool provider or reset retained progress.
        forwardingBlocked = true;
        report?.({ state: 'event_forwarding_review_required', reason: error?.code === 'APPLICATION_ASSISTANT_REVIEW_RECOVERY' ? 'recovery' : 'forwarding_failed', participantRunning: true });
      }
    } : undefined,
  });
}
