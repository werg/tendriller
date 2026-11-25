// This page's optional native part of the agent program. `tendril agent run` imports it through
// pages/review/agent.mjs for every provisioned page and serves the returned owner on its one attach socket.
// It never starts a process of its own, and the signed page needs none of it for reads or writes.
import { createScopedApplicationTools, forwardSessionEvents } from '@chronolog/peer-session';
import { connectApplicationAssistant, createAssistantEventDelivery } from '@tendriller/core/assistant';
import { definition } from './review-domain.mjs';
import { retainedReviewProposal, reviewAssistantHooks } from './review-assistant.mjs';
import { replacePrivate } from './review-local.mjs';
import { openNativePage } from './support/native-page.mjs';

export { definition };

/** Hooks for the page lifecycle; absent until the owner-reviewed proposal and its adapter key are retained. */
async function assistantIntegration({ context, session }) {
  const key = await context.readPrivate('assistant-key.json', true);
  if (!key) return {};
  const expectedProposalId = retainedReviewProposal(await context.readPrivate('assistant-proposal.json', true), key);
  const options = { queries: ['checklist'], commands: ['completeItem'] };
  return reviewAssistantHooks({ expectedProposalId, report: context.report,
    startAdapter: callbacks => connectApplicationAssistant({ page: context.host, key, session,
      tools: createScopedApplicationTools(session, options), ...callbacks }),
    onOnline: (assistant, signal) => forwardSessionEvents({ session, topics: ['completed'], signal,
      deliver: createAssistantEventDelivery({ assistant }),
      checkpoint: { load: async () => (await context.readPrivate('event-checkpoint.json', true)) ?? undefined,
        save: state => replacePrivate(context, 'event-checkpoint.json', state) },
      project: event => ({ name: 'item.completed', payload: { id: event.payload.id } }) }) });
}

// The page owner opens only a page that was explicitly provisioned by its browser owner; it never creates a root,
// membership or data key. `tendril agent run` skips this page until provisioning writes its initialization record.
export const openPage = context => openNativePage(context, { definition, assistant: assistantIntegration });
