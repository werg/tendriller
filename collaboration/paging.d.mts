import type { PeerRevision } from '@chronolog/peer-session';
import type { CollaborationSession, CollaborationTask, CollaborationClaim, CollaborationResult, CollaborationMessage,
  CollaborationQuery, CollaborationTaskSnapshot, CollaborationSnapshot } from './index.mjs';

export interface CollaborationTaskPageOptions {
  readonly limit?:number;readonly cursor?:string;readonly creator?:string;readonly eligibleSigner?:string;
  readonly state?:'all'|'open'|'closed';
}
export interface CollaborationResultPageOptions {
  readonly limit?:number;readonly cursor?:string;readonly taskId?:string;readonly slotId?:string;
  readonly disposition?:CollaborationResult['disposition'];
}
export interface CollaborationMessagePageOptions {readonly limit?:number;readonly cursor?:string;readonly threadId?:string}
export interface CollaborationThreadPageOptions extends CollaborationMessagePageOptions {readonly threadId:string}
export interface CollaborationPage {
  readonly nextCursor:string|null;readonly hasMore:boolean;readonly total:number;readonly returned:number;
  readonly limit:number;readonly revision:PeerRevision;
}
/** Current accepted evidence keeps its complete identity/fence without large content. */
export type CollaborationAcceptedResult = Omit<CollaborationResult,'content'|'disposition'>&{readonly disposition:'accepted'};
export interface CollaborationTaskPage {
  readonly tasks:readonly CollaborationTask[];readonly claims:readonly CollaborationClaim[];
  readonly acceptedResults:readonly CollaborationAcceptedResult[];readonly page:CollaborationPage;
}
export interface CollaborationResultPage {readonly results:readonly CollaborationResult[];readonly page:CollaborationPage}
export interface CollaborationMessagePage {readonly messages:readonly CollaborationMessage[];readonly page:CollaborationPage}
export interface CapturedCollaborationReader {
  readonly revision:PeerRevision;readonly closed:boolean;
  tasks(options?:CollaborationTaskPageOptions):Promise<CollaborationQuery<CollaborationTaskPage>>;
  results(options?:CollaborationResultPageOptions):Promise<CollaborationQuery<CollaborationResultPage>>;
  messages(options?:CollaborationMessagePageOptions):Promise<CollaborationQuery<CollaborationMessagePage>>;
  thread(options:CollaborationThreadPageOptions):Promise<CollaborationQuery<CollaborationMessagePage>>;
  inspect(taskId:string):Promise<CollaborationQuery<CollaborationTaskSnapshot>>;
  snapshot():Promise<CollaborationQuery<CollaborationSnapshot>>;
  close():Promise<void>;
}
/** Requires unrestricted public SQL queries; named-query scopes stay restricted. */
export function captureCollaborationReader(session:CollaborationSession,options?:{signal?:AbortSignal}):Promise<CapturedCollaborationReader>;
