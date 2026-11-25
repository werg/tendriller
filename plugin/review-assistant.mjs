import { createHash } from 'node:crypto';
import { superviseParticipant } from './support/participant-lifecycle.mjs';

/** Resume the existing proposal. Never re-propose or dial an adapter before exact owner approval. */
export function retainedReviewProposal(record, key) {
  return typeof record?.proposed === 'string' && /^[a-f0-9]{64}$/.test(record.proposed) && typeof key === 'string' &&
    record.adapterHash === createHash('sha256').update(key).digest('hex') ? record.proposed : undefined;
}
/** Hooks for the participant lifecycle: the exact retained proposal, the approved adapter and fenced event forwarding. */
export function reviewAssistantHooks({ expectedProposalId, startAdapter, onOnline, report }) {
  const proposalId = typeof expectedProposalId === 'string' && /^[a-f0-9]{64}$/.test(expectedProposalId) ? expectedProposalId : undefined;
  if (!proposalId) report?.({ state: 'assistant_proposal_identity_required', participantRunning: true });
  let forwardingBlocked = false;
  return { proposalId, startAdapter,
    onOnline: onOnline ? async (assistant, lifetime) => {
      if (forwardingBlocked) return;
      try { await onOnline(assistant, lifetime); }
      catch (error) {
        if (lifetime.aborted) return;
        // An event cursor needing review must not reconnect a healthy tool provider or reset retained progress.
        forwardingBlocked = true;
        report?.({ state: 'event_forwarding_review_required', reason: error?.code === 'EVENT_FORWARDER_REVIEW_RECOVERY' ? 'recovery' : 'forwarding_failed', participantRunning: true });
      }
    } : undefined,
  };
}
export function superviseReviewAssistant({ session, signal, watch, expectedProposalId, startAdapter, onOnline, report }) {
  return superviseParticipant({ owned: { session }, signal, watch, report,
    ...reviewAssistantHooks({ expectedProposalId, startAdapter, onOnline, report }) });
}
