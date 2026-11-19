import type { ApplicationDefinition, ApplicationSession, ApplicationEndpointBinding, PeerRevision,
  OperationState, AppliedResult, SignedRetainedCoverage, SignedAttempt } from '@chronolog/peer-session';
import type { WorkerApplicationSession } from '@chronolog/peer-session/browser';

export declare const COLLABORATION_PROTOCOL: 'tendriller.collaboration.v1';
export declare const COLLABORATION_LIMITS: Readonly<{slots:number;activeClaimsPerSigner:number;payloadBytes:number;resultsPerSlot:number;requests:number;observers:number}>;
export declare class CollaborationError extends Error {
  readonly code:string; readonly scope:Readonly<Record<string,unknown>>; readonly retrySafe:boolean; readonly nextAction:string;
  constructor(code:string,message?:string,scope?:Record<string,unknown>);
}
export interface EndpointReference { readonly deviceId:string; readonly endpointId:string; readonly endpointIncarnation:string }
export interface OperationReference { readonly applicationId:string; readonly historyId:string; readonly author:string; readonly operationId:string; readonly attemptId?:string; readonly generation?:string }
/** Read from immutable domain rows and the engine-owned authenticated transaction log. */
export interface VerifiedOperationReference extends OperationReference { readonly attemptId:string; readonly generation:string }
export type Target = {readonly kind:'endpoint';readonly endpoint:EndpointReference}|{readonly kind:'signer';readonly deviceId:string}|{readonly kind:'participant';readonly principalId:string}|{readonly kind:'agent';readonly agentBindingId:string}|{readonly kind:'workerGroup';readonly groupId:string;readonly mode:'claimOne'}|{readonly kind:'thread';readonly threadId:string};
export type ResponsePolicy = 'one'|'allSlots'|'firstAccepted'|'manual';
export interface ContributionSlot {readonly slotId:string;readonly eligibleSigners:readonly string[];readonly label?:string;readonly agentBindingId?:string}
export interface RequestInput {readonly interactionId?:string;readonly kind:string;readonly title:string;readonly input:unknown;readonly target:Target;readonly context?:unknown;readonly responsePolicy?:ResponsePolicy;readonly slots:readonly ContributionSlot[]}
export interface SubmitOptions {readonly operationId?:string;readonly basedOn?:PeerRevision}
export interface ClaimInput {readonly taskId:string;readonly slotId:string;readonly claimId?:string;readonly runId?:string;readonly endpointIncarnation?:string;readonly expectedEpoch?:number;readonly taskVersion?:number}
export interface ClaimFence {readonly taskId:string;readonly slotId:string;readonly claimEpoch:number;readonly generation:string;readonly runId?:string;readonly endpointIncarnation?:string;readonly taskVersion?:number}
export interface CollaborationOperation {
  readonly operationId:string;readonly reference:OperationReference;
  get():Promise<OperationState|null>;applied(options?:{signal?:AbortSignal}):Promise<AppliedResult>;
  shared(options?:{signal?:AbortSignal}):Promise<readonly SignedRetainedCoverage[]>;
}
export interface SignerAssertedSource extends Readonly<Record<string,unknown>> {
  readonly deviceId:string;readonly evidence:'signer-asserted';readonly contextEvidence:'caller-asserted';
}
export interface CollaborationCancellation {
  readonly reason:string;readonly expectedVersion:number;readonly author:string;readonly generation:string;readonly operation:VerifiedOperationReference;
}
export interface CollaborationAggregate {
  readonly resultIds:readonly string[];readonly expectedVersion:number;readonly content:unknown;readonly allowPartial:boolean;
  readonly author:string;readonly generation:string;readonly disposition:'partial'|'complete';readonly operation:VerifiedOperationReference;
}
export interface CollaborationTask {
  readonly taskId:string;readonly creator:string;readonly generation:string;readonly operation:VerifiedOperationReference;
  readonly taskVersion:number;readonly version:number;readonly title:string;readonly kind:string;readonly responsePolicy:ResponsePolicy;
  readonly slots:readonly ContributionSlot[];readonly input:unknown;readonly target:unknown;readonly context:unknown;readonly source:SignerAssertedSource;
  readonly status:'open'|'completed'|'cancelRequested'|'cancelled'|'needsReview';
  readonly cancellation:CollaborationCancellation|null;readonly aggregate:CollaborationAggregate|null;
}
export interface CollaborationClaim {
  readonly taskId:string;readonly slotId:string;readonly taskVersion:number;readonly claimEpoch:number;readonly claimant:string;
  readonly runId:string|null;readonly endpointIncarnation:string|null;readonly generation:string;readonly operation:VerifiedOperationReference;
  readonly acknowledgement:VerifiedOperationReference|null;
  readonly status:'active'|'offered'|'needsReview'|'completed'|'cancelRequested'|'cancelled';
}
export interface CollaborationResult extends ClaimFence {
  readonly resultId:string;readonly author:string;readonly runId:string;readonly endpointIncarnation:string;
  readonly outcome:'succeeded'|'failed';readonly content:unknown;readonly disposition:'accepted'|'superseded'|'cancelled'|'needsReview';
  readonly operationRecord:string;readonly operation:VerifiedOperationReference;
}
export interface CollaborationMessage {
  readonly threadId:string;readonly messageId:string;readonly text:string;readonly inReplyTo?:string;
  readonly source:SignerAssertedSource;readonly author:string;readonly generation:string;readonly operation:VerifiedOperationReference;
}
export interface CollaborationTaskSnapshot {readonly task:CollaborationTask|null;readonly claims:readonly CollaborationClaim[];readonly results:readonly CollaborationResult[]}
export interface CollaborationSnapshot {readonly tasks:readonly CollaborationTask[];readonly claims:readonly CollaborationClaim[];readonly results:readonly CollaborationResult[];readonly messages:readonly CollaborationMessage[]}
export interface CollaborationQuery<Value> {readonly revision:PeerRevision;readonly value:Value}
export interface RetainedOperation {readonly reference:OperationReference;readonly viewId:string;readonly context:Readonly<Record<string,unknown>>}
export interface ViewStore<Draft=unknown> {
  readonly viewId:string;readonly historyId?:string;readDraft(draftId?:string):Draft|null;writeDraft(value:Draft,draftId?:string):void;removeDraft(draftId?:string):void;
  retainOperation(reference:OperationReference,context?:Record<string,unknown>):RetainedOperation;inspectOperation(reference:OperationReference):RetainedOperation|null;
  removeOperation(reference:OperationReference):void;pending(options?:{allViews?:boolean}):readonly RetainedOperation[];
}
export declare function createViewStore<Draft=unknown>(options:{storage:Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;applicationId:string;historyId?:string;profileId:string;viewId:string}):ViewStore<Draft>;
export declare function createCollaborationDefinition(options?:{id?:string;version?:string;administrators?:readonly string[];limits?:Partial<typeof COLLABORATION_LIMITS>}):ApplicationDefinition;
export type CollaborationSession = ApplicationSession|WorkerApplicationSession;
export interface CollaborationClient<Session extends CollaborationSession=CollaborationSession> {
  readonly session:Session;readonly endpoint:ApplicationEndpointBinding|undefined;readonly runId:string;readonly source:Readonly<Record<string,unknown>>;
  request(input:RequestInput,options?:SubmitOptions):Promise<CollaborationOperation>;
  claim(input:ClaimInput,options?:SubmitOptions):Promise<CollaborationOperation>;
  rebind(input:ClaimInput&{expectedEpoch:number},options?:SubmitOptions):Promise<CollaborationOperation>;
  handoff(input:{taskId:string;slotId:string;actionId?:string;expectedEpoch:number;assignee:string;reason:string},options?:SubmitOptions):Promise<CollaborationOperation>;
  result(input:ClaimFence&{resultId?:string;outcome?:'succeeded'|'failed';content:unknown},options?:SubmitOptions):Promise<CollaborationOperation>;
  cancel(input:{taskId:string;actionId?:string;expectedVersion:number;reason:string},options?:SubmitOptions):Promise<CollaborationOperation>;
  acknowledgeCancel(input:ClaimFence&{actionId?:string},options?:SubmitOptions):Promise<CollaborationOperation>;
  finalize(input:{taskId:string;actionId?:string;expectedVersion:number;resultIds:readonly string[];content:unknown;allowPartial?:boolean},options?:SubmitOptions):Promise<CollaborationOperation>;
  message(input:{threadId:string;messageId?:string;text:string;inReplyTo?:string},options?:SubmitOptions):Promise<CollaborationOperation>;
  inspect(taskId:string):Promise<CollaborationQuery<CollaborationTaskSnapshot>>;snapshot():Promise<CollaborationQuery<CollaborationSnapshot>>;
  waitForOutcome(taskId:string,options?:{signal?:AbortSignal}):Promise<CollaborationTaskSnapshot&{readonly revision:PeerRevision}>;
  inspectOperation(reference:OperationReference):Promise<{readonly state:OperationState;readonly attempt:SignedAttempt}|null>;
  retry(reference:OperationReference):Promise<void>;detach():Promise<void>;
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
export declare function operationReference(session:{applicationId?:string;id?:string;historyId:string;deviceId:string},operationId:string,state?:{operationId?:string;author?:string;attemptId?:string;generation?:string}|null):OperationReference;
export declare function prepareCollaborationCommand<Input>(endpoint:ApplicationEndpointBinding,name:string,input:Input,deviceId:string):Input;
export interface ConsumerScope {readonly applicationId:string;readonly consumerId:string;readonly generation:string;readonly filterVersion:string}
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
  journal:EffectJournal<Fence,Receipt>;dispatch:(input:{effectId:string;idempotencyKey:string;fence:Fence;input:Input})=>Receipt|Promise<Receipt>;
  authorize:(fence:Fence)=>void|Promise<void>;reconcile?:(id:string,record:EffectRecord<Fence,Receipt>)=>Receipt|null|undefined|Promise<Receipt|null|undefined>;
}):{execute(input:{effectId:string;fence:Fence;input:Input}):Promise<EffectRecord<Fence,Receipt>>};
