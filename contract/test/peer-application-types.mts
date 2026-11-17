import type { ApplicationOperation, AppliedApplicationReadView, PeerGenerationApplicationBackend } from '../application.mjs';
import type { PeerApplicationMember, PeerControlsClient } from '../peer-controls.mjs';
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
const phase: 'ready' | 'waiting' | 'recovering' | 'closed' = backend.status.phase;
const unsubscribe = backend.onStatus(status => { const connections: number = status.connectedPeers; void connections; });
for (const notice of backend.inspectRecovery()) { const lost: boolean = notice.unknownLoss; void lost; }
void [applied, abandoned, missingAttempt, missingGeneration, generation, finalRevision, profile, phase, unsubscribe];
const member: PeerApplicationMember = { publicKey: 'device', dataRole: 'member' };
// @ts-expect-error Explicit grants include data authority instead of inventing a compatibility default.
const incompleteGrant: PeerApplicationMember = { grant: { publicKey: 'device', reader: true, writer: true, coordinator: true, recovery: true, administrator: false } };
declare const controls: PeerControlsClient;
void controls.administerGeneration({ transitionId: 'owner-recovery', expectedGeneration: 'current', coordinator: 'real-peer',
  controlRevision: 1, reason: 'takeover', base: { point: { generation: 'current', sequence: 0, root: 'root' }, receipt: null, bridge: [] } });
void [member, incompleteGrant];
