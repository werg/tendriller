import type { ApplicationOperation, AppliedApplicationReadView, FinalityApplicationBackend, PeerGenerationApplicationBackend } from '../application.mjs';
const applied: ApplicationOperation = { status: 'applied', operationId: 'edit', attemptId: 'signed-attempt', author: 'device',
  revision: 'observed-revision', generation: 'generation', sequence: 1, outcome: 'accepted', rejectionCode: null };
const abandoned: ApplicationOperation = { status: 'abandoned', operationId: 'edit', attemptId: 'signed-attempt',
  generation: 'generation', selectedGeneration: 'successor', previous: applied };
// @ts-expect-error Generation attempts have their own authenticated identity, not a fake proposal reference.
const missingAttempt: ApplicationOperation = { status: 'saved', operationId: 'edit', proposalId: 'fake', generation: 'generation' };
// @ts-expect-error An applied result must identify its generation and sequence.
const missingGeneration: ApplicationOperation = { status: 'applied', operationId: 'edit', attemptId: 'attempt', outcome: 'accepted' };
// @ts-expect-error A mutable applied result must identify the captured revision, not only its receipt.
const missingRevision: ApplicationOperation = { status: 'applied', operationId: 'edit', attemptId: 'attempt', author: 'device', generation: 'generation', sequence: 1, outcome: 'accepted', rejectionCode: null };
declare const view: AppliedApplicationReadView;
const generation: string = view.generation;
// @ts-expect-error A generation-scoped view has no final revision.
const finalRevision: string = view.finalRevision;
declare const backend: PeerGenerationApplicationBackend;
const profile: 'peer-generation-v1' = backend.profile;
void backend.submit(null, { operationId: 'observed-edit', observedRevision: 'observed-revision' });
// @ts-expect-error An ancestry observation has no legacy compare-and-swap option alias.
void backend.submit(null, { operationId: 'legacy-edit', basedOn: 'legacy-revision' });
for (const notice of backend.inspectRecovery()) { const lost: boolean = notice.unknownLoss; void lost; }
for await (const change of backend.changes()) {
  const currentGeneration: string = change.generation;
  // @ts-expect-error Generation change notifications do not supply finality metadata.
  const finalRevision: string = change.finalRevision;
  void [currentGeneration, finalRevision];
}
declare const live: FinalityApplicationBackend;
const liveView = await live.readView({ view: 'local' });
const liveFinalRevision: string = liveView.finalRevision;
// @ts-expect-error Live finality views do not claim a recovery generation.
const liveGeneration: string = liveView.generation;
// @ts-expect-error A concrete live backend does not expose an applied generation view.
void live.readView({ view: 'applied' });
for await (const change of live.changes()) { const finalRevision: string = change.finalRevision; void finalRevision; }
const liveOperation = await live.submit(null, { operationId: 'live-edit' });
const proposalId: string = liveOperation.proposalId;
void [liveFinalRevision, liveGeneration, proposalId];
void [applied, abandoned, missingAttempt, missingGeneration, missingRevision, generation, finalRevision, profile];
