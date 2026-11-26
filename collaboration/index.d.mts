import type { ApplicationDefinition, ApplicationSession, MaterializedRevision,
  OperationInspection, MaterializedOperation, RetentionEvidence, ChainTopicSeed, ViewStore, WaitOptions } from '@chronolog/peer-session';
export type { ViewStore } from '@chronolog/peer-session';
import type { WorkerApplicationSession } from '@chronolog/peer-session/browser';
import type { CollaborationTaskPageOptions, CollaborationResultPageOptions, CollaborationMessagePageOptions,
  CollaborationThreadPageOptions, CollaborationTaskPage, CollaborationResultPage, CollaborationMessagePage,
  CollaborationPage, CollaborationAcceptedResult, CapturedCollaborationReader } from './paging.mjs';

export declare const COLLABORATION_PROTOCOL: 'tendriller.collaboration.v1';
export declare const COLLABORATION_LIMITS: Readonly<{slots:number;activeClaimsPerSigner:number;payloadBytes:number;resultsPerSlot:number;requests:number;observers:number}>;
export declare class CollaborationError extends Error {
  readonly code:string; readonly scope:Readonly<Record<string,unknown>>; readonly retrySafe:boolean; readonly nextAction:string;
  constructor(code:string,message?:string,scope?:Record<string,unknown>);
}
export interface EndpointReference { readonly deviceId:string; readonly endpointId:string; readonly endpointIncarnation:string }
export interface OperationReference { readonly applicationId:string;  readonly author:string; readonly operationId:string; readonly proposalId?:string }
/** Read from immutable domain rows and the engine-owned authenticated transaction log. */
export interface VerifiedOperationReference extends OperationReference { readonly proposalId:string }
export type Target = {readonly kind:'endpoint';readonly endpoint:EndpointReference}|{readonly kind:'signer';readonly deviceId:string}|{readonly kind:'participant';readonly principalId:string}|{readonly kind:'agent';readonly agentBindingId:string}|{readonly kind:'workerGroup';readonly groupId:string;readonly mode:'claimOne'}|{readonly kind:'thread';readonly threadId:string};
export type ResponsePolicy = 'one'|'allSlots'|'firstAccepted'|'manual';
export interface ContributionSlot {readonly slotId:string;readonly eligibleSigners:readonly string[];readonly label?:string;readonly agentBindingId?:string}
export interface RequestInput {readonly interactionId?:string;readonly kind:string;readonly title:string;readonly input:unknown;readonly target:Target;readonly context?:unknown;readonly responsePolicy?:ResponsePolicy;readonly slots:readonly ContributionSlot[]}
export interface SubmitOptions {readonly operationId?:string;readonly authorTimestampMs?:bigint}
export interface ClaimInput {readonly taskId:string;readonly slotId:string;readonly claimId?:string;readonly runId?:string;readonly endpointIncarnation?:string;readonly expectedEpoch?:number;readonly taskVersion?:number}
export interface ClaimFence {readonly taskId:string;readonly slotId:string;readonly claimEpoch:number;readonly claimProposalId:string;readonly runId?:string;readonly endpointIncarnation?:string;readonly taskVersion?:number}
export interface CollaborationIdentities {
  readonly operationId:string;readonly localOperationId:string;readonly interactionId?:string;readonly taskId?:string;readonly slotId?:string;
  readonly claimId?:string;readonly resultId?:string;readonly actionId?:string;readonly threadId?:string;readonly messageId?:string;
}
export interface CollaborationSubmission<Identity extends keyof CollaborationIdentities=never> {
  readonly command:string;readonly input:Readonly<Record<string,unknown>>;readonly source:Readonly<Record<string,unknown>>;
  readonly authorTimestampMs?:string;readonly identities:CollaborationIdentities&Readonly<Record<Identity,string>>;
}
/** Metadata is immutable even when the original transport error is extensible. */
export interface CollaborationSubmissionFailure extends Error {
  readonly operationReference:OperationReference;readonly operationIdentities:CollaborationIdentities;
  readonly operationSubmission:CollaborationSubmission;
}
export interface CollaborationOperation<Identity extends keyof CollaborationIdentities=never> {
  readonly operationId:string;readonly reference:VerifiedOperationReference;
  readonly identities:CollaborationIdentities&Readonly<Record<Identity,string>>;readonly submission:CollaborationSubmission<Identity>;
  readonly stored:true;readonly proposalId:string;
  inspect():OperationInspection|Promise<OperationInspection>;materialized(options?:WaitOptions):Promise<MaterializedOperation>;
  retained(options?:WaitOptions):Promise<readonly RetentionEvidence[]>;
  finalized(options?:WaitOptions):Promise<MaterializedOperation>;
}
export interface SignerAssertedSource extends Readonly<Record<string,unknown>> {
  readonly deviceId:string;readonly evidence:'signer-asserted';readonly contextEvidence:'caller-asserted';
}
export interface CollaborationCancellation {
  readonly reason:string;readonly expectedVersion:number;readonly author:string;readonly operation:VerifiedOperationReference;
}
export interface CollaborationAggregate {
  readonly resultIds:readonly string[];readonly expectedVersion:number;readonly content:unknown;readonly allowPartial:boolean;
  readonly author:string;readonly disposition:'partial'|'complete';readonly operation:VerifiedOperationReference;
}
export interface CollaborationTask {
  readonly taskId:string;readonly creator:string;readonly revision:MaterializedRevision;readonly finality:'pending'|'finalized';readonly operation:VerifiedOperationReference;
  readonly taskVersion:number;readonly version:number;readonly title:string;readonly kind:string;readonly responsePolicy:ResponsePolicy;
  readonly slots:readonly ContributionSlot[];readonly input:unknown;readonly target:unknown;readonly context:unknown;readonly source:SignerAssertedSource;
  readonly status:'open'|'completed'|'cancelRequested'|'cancelled';
  readonly cancellation:CollaborationCancellation|null;readonly aggregate:CollaborationAggregate|null;
}
export interface CollaborationClaim {
  readonly taskId:string;readonly slotId:string;readonly taskVersion:number;readonly claimEpoch:number;readonly claimant:string;
  readonly claimProposalId:string;readonly revision:MaterializedRevision;readonly finality:'pending'|'finalized';
  readonly runId:string|null;readonly endpointIncarnation:string|null;readonly operation:VerifiedOperationReference;
  readonly acknowledgement:VerifiedOperationReference|null;
  readonly status:'active'|'offered'|'completed'|'cancelRequested'|'cancelled';
}
export interface CollaborationResult extends ClaimFence {
  readonly resultId:string;readonly author:string;readonly runId:string;readonly endpointIncarnation:string;
  readonly outcome:'succeeded'|'failed';readonly content:unknown;readonly disposition:'accepted'|'superseded'|'cancelled';
  readonly operationRecord:string;readonly operation:VerifiedOperationReference;
}
export interface CollaborationMessage {
  readonly threadId:string;readonly messageId:string;readonly text:string;readonly inReplyTo?:string;
  readonly source:SignerAssertedSource;readonly author:string;readonly operation:VerifiedOperationReference;
}
export interface CollaborationTaskSnapshot {
  readonly task:CollaborationTask|null;readonly claims:readonly CollaborationClaim[];readonly results:readonly CollaborationResult[];
  readonly acceptedResults:readonly CollaborationAcceptedResult[];readonly resultsPage:CollaborationPage;
}
export interface CollaborationSnapshot {
  readonly tasks:readonly CollaborationTask[];readonly claims:readonly CollaborationClaim[];readonly results:readonly CollaborationResult[];
  readonly acceptedResults:readonly CollaborationAcceptedResult[];readonly messages:readonly CollaborationMessage[];
  readonly pages:Readonly<{tasks:CollaborationPage;results:CollaborationPage;messages:CollaborationPage}>;
}
export interface CollaborationQuery<Value> {readonly revision:MaterializedRevision;readonly value:Value}
export interface RetainedOperation {readonly reference:OperationReference;readonly viewId:string;readonly context:Readonly<Record<string,unknown>>}
export { createViewStore } from '@chronolog/peer-session';
/** Create a Chronolog v2 collaboration ES Module reducer, genesis topic/import seeds, and ApplicationDefinition. */
export declare function createCollaborationReducerSource(options?:{administrators?:readonly string[];limits?:Partial<typeof COLLABORATION_LIMITS>}):string;
export declare function createCollaborationDefinition(options?:{id?:string;version?:string;administrators?:readonly string[];limits?:Partial<typeof COLLABORATION_LIMITS>}):{readonly definition:ApplicationDefinition;readonly reducerSource:string;readonly imports:Readonly<Record<string,string>>;readonly topics:Readonly<Record<string,ChainTopicSeed>>};
export interface ApplicationEndpointBinding { readonly endpointId:string;readonly endpointIncarnation:string;readonly ownerInstanceId?:string;readonly context?:Readonly<Record<string,unknown>> }
export type CollaborationSession = ApplicationSession|WorkerApplicationSession;
export interface CollaborationClient<Session extends CollaborationSession=CollaborationSession> {
  readonly session:Session;readonly endpoint:ApplicationEndpointBinding|undefined;readonly runId:string;readonly source:Readonly<Record<string,unknown>>;
  request(input:RequestInput,options?:SubmitOptions):Promise<CollaborationOperation<'interactionId'|'taskId'>>;
  claim(input:ClaimInput,options?:SubmitOptions):Promise<CollaborationOperation<'taskId'|'slotId'|'claimId'>>;
  handoff(input:{taskId:string;slotId:string;actionId?:string;expectedEpoch:number;assignee:string;reason:string},options?:SubmitOptions):Promise<CollaborationOperation<'taskId'|'slotId'|'actionId'>>;
  result(input:ClaimFence&{resultId?:string;outcome?:'succeeded'|'failed';content:unknown},options?:SubmitOptions):Promise<CollaborationOperation<'taskId'|'slotId'|'resultId'>>;
  cancel(input:{taskId:string;actionId?:string;expectedVersion:number;reason:string},options?:SubmitOptions):Promise<CollaborationOperation<'taskId'|'actionId'>>;
  acknowledgeCancel(input:ClaimFence&{actionId?:string},options?:SubmitOptions):Promise<CollaborationOperation<'taskId'|'slotId'|'actionId'>>;
  finalize(input:{taskId:string;actionId?:string;expectedVersion:number;resultIds:readonly string[];content:unknown;allowPartial?:boolean},options?:SubmitOptions):Promise<CollaborationOperation<'taskId'|'actionId'>>;
  message(input:{threadId:string;messageId?:string;text:string;inReplyTo?:string},options?:SubmitOptions):Promise<CollaborationOperation<'threadId'|'messageId'>>;
  inspect(taskId:string):Promise<CollaborationQuery<CollaborationTaskSnapshot>>;snapshot():Promise<CollaborationQuery<CollaborationSnapshot>>;
  tasks(options?:CollaborationTaskPageOptions):Promise<CollaborationQuery<CollaborationTaskPage>>;
  results(options?:CollaborationResultPageOptions):Promise<CollaborationQuery<CollaborationResultPage>>;
  messages(options?:CollaborationMessagePageOptions):Promise<CollaborationQuery<CollaborationMessagePage>>;
  thread(options:CollaborationThreadPageOptions):Promise<CollaborationQuery<CollaborationMessagePage>>;
  capture(options?:{signal?:AbortSignal}):Promise<CapturedCollaborationReader>;
  waitForOutcome(taskId:string,options?:{signal?:AbortSignal}):Promise<CollaborationTaskSnapshot&{readonly revision:MaterializedRevision}>;
  inspectOperation(reference:OperationReference):Promise<OperationInspection|null>;
  retry(reference:OperationReference):Promise<unknown>;detach():Promise<void>;
}
export declare function createCollaborationClient<Session extends CollaborationSession>(options:{session:Session;endpoint?:ApplicationEndpointBinding;runId?:string;store?:ViewStore}):CollaborationClient<Session>;
export declare function canonicalJson(value:unknown,maxBytes?:number):string;
export declare function identifier(value:unknown,name?:string):string;
export declare function signerId(value:unknown):string;
export declare function endpointReference(value:unknown):EndpointReference;
export declare function sameEndpoint(left:EndpointReference|undefined,right:EndpointReference|undefined):boolean;
export declare function validateTarget(target:unknown):Target;
export interface RecipientEntry {
  readonly deviceId:string;readonly authorized:boolean;readonly revoked?:boolean;readonly principalId?:string;
  readonly agentBindingId?:string;readonly endpoint?:EndpointReference;readonly capabilities?:readonly string[];
}
export declare function resolveRecipient<Entry extends RecipientEntry>(target:Target,entries:readonly Entry[],options?:{capability?:string}):Entry;
export declare function operationReference(session:{applicationId:string;identity:{publicKey:string};scopeOperationId?:(raw:string)=>string},operationId:string,inspection?:OperationInspection|null):OperationReference;
export declare function prepareCollaborationCommand<Input>(endpoint:ApplicationEndpointBinding,name:string,input:Input,deviceId:string):Input;
export interface ConsumerScope {readonly applicationId:string;readonly consumerId:string;readonly revisionDigest:string;readonly filterVersion:string}
export interface ConsumerCursor extends ConsumerScope {readonly protocol:typeof COLLABORATION_PROTOCOL;readonly sequence:number}
export declare function consumerCursor(scope:ConsumerScope,sequence:number):ConsumerCursor;
export declare function validateConsumerCursor(cursor:unknown,scope:ConsumerScope,options?:{retainedFrom?:number}):ConsumerCursor;
export interface ParticipantPresence {readonly expiresAt:number;readonly phase?:string;readonly [key:string]:unknown}
export interface ParticipantEntry extends RecipientEntry {
  /** Verified reader membership; it does not authorize execution or recipient selection. */
  readonly canRead?:boolean;
  readonly kind?:'person'|'agent';readonly label?:string;readonly deviceLabel?:string;readonly viewLabel?:string;
  readonly route?:string;readonly presence?:ParticipantPresence|null;
}
export type PresentedParticipant<Entry extends ParticipantEntry=ParticipantEntry> = Omit<Entry,'presence'|'label'|'route'>&{
  readonly presence:ParticipantPresence|null;readonly label:string;readonly route:string;readonly availability:string;
  readonly thisView:boolean;readonly canRequest:boolean;readonly detail:string;
};
export interface ParticipantModel<Entry extends ParticipantEntry=ParticipantEntry> {
  readonly participants:readonly PresentedParticipant<Entry>[];readonly counts:{readonly people:number;readonly agents:number;readonly devices:number;readonly endpoints:number};
}
export declare function participantModel<Entry extends ParticipantEntry>(entries:readonly Entry[],options?:{selfEndpoint?:EndpointReference;now?:number}):ParticipantModel<Entry>;
export interface ReceiptEvidence {readonly status?:string;readonly outcome?:string;readonly reference?:OperationReference|null}
export declare function receiptModel(evidence?:ReceiptEvidence|null):{status:string;label:string;detail:string;reference:OperationReference|null};
export declare function mountParticipantPanel<Entry extends ParticipantEntry>(options:{container:HTMLElement;participants?:readonly Entry[];selfEndpoint?:EndpointReference;onSelect?:(participant:PresentedParticipant<Entry>)=>void}):{update(entries?:readonly Entry[]):ParticipantModel<Entry>;close():void};
export interface EffectRecord<Fence=unknown,Receipt=unknown> {
  readonly effectId:string;readonly payload:string;readonly fence:Fence;readonly idempotencyKey?:string;
  readonly status:'dispatching'|'outcomeUnknown'|'completed';readonly receipt?:Receipt;readonly reason?:string;readonly nextAction?:string;
}
export interface EffectJournal<Fence=unknown,Receipt=unknown> {
  idempotencyKey?(effectId:string):string;
  transact<Value>(effectId:string,update:(previous:EffectRecord<Fence,Receipt>|undefined)=>{record:EffectRecord<Fence,Receipt>;value:Value}):Promise<Value>;
}
export declare function createEffectDispatcher<Fence=unknown,Input=unknown,Receipt=unknown>(options:{
  session?:Pick<CollaborationSession,'applicationId'|'operations'>;
  /** Explicit opt-in to external-effect risk; this never establishes global claim exclusivity or finality. */
  allowProvisionalEffects?:boolean;
  journal:EffectJournal<Fence,Receipt>;dispatch:(input:{effectId:string;idempotencyKey:string;fence:Fence;input:Input})=>Receipt|Promise<Receipt>;
  authorize:(fence:Fence)=>void|Promise<void>;reconcile?:(id:string,record:EffectRecord<Fence,Receipt>)=>Receipt|null|undefined|Promise<Receipt|null|undefined>;
}):{execute(input:{effectId:string;fence:Fence;input:Input}):Promise<EffectRecord<Fence,Receipt>>};
export * from './paging.mjs';
