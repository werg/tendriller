import type { ApplicationOperation, AppliedApplicationReadView, PeerGenerationApplicationBackend } from '../application.mjs';
const applied: ApplicationOperation = { status: 'applied', operationId: 'edit', attemptId: 'signed-attempt', author: 'device',
  generation: 'generation', sequence: 1, outcome: 'accepted', rejectionCode: null };
const abandoned: ApplicationOperation = { status: 'abandoned', operationId: 'edit', attemptId: 'signed-attempt',
  generation: 'generation', selectedGeneration: 'successor', previous: applied };
// @ts-expect-error Generation attempts have their own authenticated identity, not a fake proposal reference.
const missingAttempt: ApplicationOperation = { status: 'saved', operationId: 'edit', proposalId: 'fake', generation: 'generation' };
// @ts-expect-error An applied result must identify its generation and sequence.
const missingGeneration: ApplicationOperation = { status: 'applied', operationId: 'edit', attemptId: 'attempt', outcome: 'accepted' };
declare const view: AppliedApplicationReadView;
const generation: string = view.generation;
// @ts-expect-error A generation-scoped view has no final revision.
const finalRevision: string = view.finalRevision;
declare const backend: PeerGenerationApplicationBackend;
const profile: 'peer-generation-v1' = backend.profile;
for (const notice of backend.inspectRecovery()) { const lost: boolean = notice.unknownLoss; void lost; }
void [applied, abandoned, missingAttempt, missingGeneration, generation, finalRevision, profile];
