import type { ApplicationDefinition, ApplicationSession } from '@chronolog/peer-session';
export declare const COLLABORATION_PROTOCOL: 'tendriller.collaboration.v1';
export declare const COLLABORATION_LIMITS: Readonly<{slots:number;activeClaimsPerSigner:number;payloadBytes:number;resultsPerSlot:number;requests:number;observers:number}>;
export declare class CollaborationError extends Error { readonly code:string;readonly scope:Readonly<Record<string,unknown>>;readonly retrySafe:boolean;readonly nextAction:string;constructor(code:string,message?:string,scope?:Record<string,unknown>); }
export interface EndpointReference { readonly deviceId:string;readonly endpointId:string;readonly endpointIncarnation:string }
export interface OperationReference { readonly applicationId:string;readonly author:string;readonly operationId:string;readonly attemptId?:string;readonly generation?:string }
export type Target = {readonly kind:'endpoint';readonly endpoint:EndpointReference}|{readonly kind:'signer';readonly deviceId:string}|{readonly kind:'participant';readonly principalId:string}|{readonly kind:'agent';readonly agentBindingId:string}|{readonly kind:'workerGroup';readonly groupId:string;readonly mode:'claimOne'}|{readonly kind:'thread';readonly threadId:string};
export interface ContributionSlot {readonly slotId:string;readonly eligibleSigners:readonly string[];readonly label?:string;readonly agentBindingId?:string}
export interface RequestInput {readonly interactionId?:string;readonly kind:string;readonly title:string;readonly input:unknown;readonly target:Target;readonly context?:unknown;readonly responsePolicy?:'one'|'allSlots'|'firstAccepted'|'manual';readonly slots:readonly ContributionSlot[]}
export interface SubmitOptions {readonly operationId?:string;readonly basedOn?:unknown}
export interface ClaimInput {readonly taskId:string;readonly slotId:string;readonly claimId?:string;readonly runId?:string;readonly endpointIncarnation?:string;readonly expectedEpoch?:number;readonly taskVersion?:number}
export interface ClaimFence {readonly taskId:string;readonly slotId:string;readonly claimEpoch:number;readonly generation:string;readonly runId?:string;readonly endpointIncarnation?:string;readonly taskVersion?:number}
export interface CollaborationOperation {readonly reference:OperationReference;get():Promise<unknown>;applied(options?:{signal?:AbortSignal}):Promise<unknown>;shared(options?:{signal?:AbortSignal}):Promise<unknown>}
export interface ViewStore {readonly viewId:string;readDraft(draftId?:string):unknown;writeDraft(value:unknown,draftId?:string):void;removeDraft(draftId?:string):void;retainOperation(reference:OperationReference,context?:Record<string,unknown>):unknown;inspectOperation(reference:OperationReference):unknown;removeOperation(reference:OperationReference):void;pending(options?:{allViews?:boolean}):readonly unknown[]}
export declare function createViewStore(options:{storage:Storage;applicationId:string;profileId:string;viewId:string}):ViewStore;
export declare function createCollaborationDefinition(options?:{id?:string;version?:string;administrators?:readonly string[];limits?:Partial<typeof COLLABORATION_LIMITS>}):ApplicationDefinition;
export interface CollaborationClient {readonly session:ApplicationSession;readonly endpoint:unknown;readonly runId:string;readonly source:Readonly<Record<string,unknown>>;
 request(input:RequestInput,options?:SubmitOptions):Promise<CollaborationOperation>;
 claim(input:ClaimInput,options?:SubmitOptions):Promise<CollaborationOperation>;
 rebind(input:ClaimInput&{expectedEpoch:number},options?:SubmitOptions):Promise<CollaborationOperation>;
 handoff(input:{taskId:string;slotId:string;actionId?:string;expectedEpoch:number;assignee:string;reason:string},options?:SubmitOptions):Promise<CollaborationOperation>;
 result(input:ClaimFence&{resultId?:string;outcome?:'succeeded'|'failed';content:unknown},options?:SubmitOptions):Promise<CollaborationOperation>;
 cancel(input:{taskId:string;actionId?:string;expectedVersion:number;reason:string},options?:SubmitOptions):Promise<CollaborationOperation>;
 acknowledgeCancel(input:ClaimFence&{actionId?:string},options?:SubmitOptions):Promise<CollaborationOperation>;
 finalize(input:{taskId:string;actionId?:string;expectedVersion:number;resultIds:readonly string[];content:unknown;allowPartial?:boolean},options?:SubmitOptions):Promise<CollaborationOperation>;
 message(input:{threadId:string;messageId?:string;text:string;inReplyTo?:string},options?:SubmitOptions):Promise<CollaborationOperation>;
 inspect(taskId:string):Promise<any>;snapshot():Promise<any>;waitForOutcome(taskId:string,options?:{signal?:AbortSignal}):Promise<any>;
 inspectOperation(reference:OperationReference):Promise<unknown>;retry(reference:OperationReference):Promise<void>;detach():Promise<void>;
}
export declare function createCollaborationClient(options:{session:ApplicationSession|any;endpoint?:any;runId?:string;store?:ViewStore}):CollaborationClient;
export declare function canonicalJson(value:unknown,maxBytes?:number):string;
export declare function identifier(value:unknown,name?:string):string;
export declare function signerId(value:unknown):string;
export declare function endpointReference(value:unknown):EndpointReference;
export declare function sameEndpoint(left:EndpointReference|undefined,right:EndpointReference|undefined):boolean;
export declare function validateTarget(target:unknown):Target;
export declare function resolveRecipient(target:Target,entries:readonly any[],options?:{capability?:string}):any;
export declare function operationReference(session:any,operationId:string,state?:any):OperationReference;
export declare function prepareCollaborationCommand(endpoint:any,name:string,input:any,deviceId:string):any;
export declare function consumerCursor(scope:{applicationId:string;consumerId:string;generation:string;filterVersion:string},sequence:number):any;
export declare function validateConsumerCursor(cursor:any,scope:any,options?:{retainedFrom?:number}):any;
export declare function participantModel(entries:readonly any[],options?:{selfEndpoint?:EndpointReference;now?:number}):any;
export declare function receiptModel(evidence:any):{status:string;label:string;detail:string;reference:OperationReference|null};
export declare function mountParticipantPanel(options:{container:HTMLElement;participants?:readonly any[];selfEndpoint?:EndpointReference;onSelect?:(participant:any)=>void}):{update(entries?:readonly any[]):any;close():void};
export declare function createEffectDispatcher(options:{journal:{transact(id:string,update:(previous:any)=>{record:any;value:any}):Promise<any>};dispatch:(input:any)=>Promise<any>;authorize:(fence:any)=>Promise<void>;reconcile?:(id:string,record:any)=>Promise<any>}):{execute(input:{effectId:string;fence:unknown;input:unknown}):Promise<any>};
