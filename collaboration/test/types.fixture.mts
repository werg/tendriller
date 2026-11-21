import type { ApplicationSession } from '@chronolog/peer-session';
import type { WorkerApplicationSession } from '@chronolog/peer-session/browser';
import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { createCollaborationClient, createViewStore, createEffectDispatcher, mountParticipantPanel, captureCollaborationReader, type ParticipantEntry } from '../index.mjs';
import { createSqliteEffectJournal, attachNativeSession } from '../../session/native.mjs';
import { serveBrowserOwner } from '../../session/worker.mjs';
declare const native: ApplicationSession;
declare const attached: WorkerApplicationSession;
const nativeAttachment=await attachNativeSession({directory:'private-owner',token:'credential',connect:connectApplicationOwner,
  applicationId:'application',definitionId:'definition',definitionVersion:'1'});
const canonicalOperation:string=nativeAttachment.session.scopeOperationId('local-operation');void canonicalOperation;
// @ts-expect-error the supervisor binding namespace cannot be replaced
nativeAttachment.session.scopeOperationId=()=> 'forged';
serveBrowserOwner({load:async()=>({profileId:'retained',openSession:async()=>({session:native})})});
const nativeClient=createCollaborationClient({session:native});
const attachedClient=createCollaborationClient({session:attached});
const generated=await attachedClient.request({kind:'review',title:'Review',input:null,target:{kind:'signer',deviceId:'key'},slots:[]});
const interactionId:string=generated.identities.interactionId;
await attachedClient.waitForOutcome(interactionId);
// @ts-expect-error generated identity metadata is immutable
generated.identities.interactionId='replacement';
// @ts-expect-error the exact submitted input is readonly
generated.submission.input.interactionId='replacement';
const snapshot=await attachedClient.snapshot();
const reader=await captureCollaborationReader(attached),taskPage=await reader.tasks({limit:8,eligibleSigner:'key',state:'open'});
const cursor:string|null=taskPage.value.page.nextCursor;void cursor;
const acceptedResult=taskPage.value.acceptedResults[0];
if(acceptedResult){const disposition:'accepted'=acceptedResult.disposition;void disposition;
  // @ts-expect-error current accepted summaries deliberately omit full content
  void acceptedResult.content;}
await reader.thread({threadId:'thread',limit:16});await reader.close();
await attachedClient.results({taskId:'task',disposition:'needsReview'});
const ownReader=await nativeClient.capture();await ownReader.close();
// @ts-expect-error thread pagination requires an exact thread identity
await attachedClient.thread({limit:16});
const reference=snapshot.value.tasks[0]?.operation;
if(reference){const attempt:string=reference.attemptId;const history:string=reference.historyId;await nativeClient.inspectOperation(reference);void attempt;void history;}
const store=createViewStore<{text:string}>({storage:localStorage,applicationId:'app',historyId:attached.historyId,profileId:'profile',viewId:'view'});
// @ts-expect-error a partial reference cannot select a verified history
await nativeClient.inspectOperation({applicationId:'app',author:'signer',operationId:'operation'});
store.writeDraft({text:'hello'});const text:string|undefined=store.readDraft()?.text;void text;
const people:ParticipantEntry[]=[{deviceId:'key',authorized:true,kind:'person'}];
mountParticipantPanel({container:document.body,participants:people,onSelect:participant=>{const available:boolean=participant.canRequest;void available;}});
const journal=await createSqliteEffectJournal({path:'effects.db',applicationId:'app',providerId:'provider'});
const effects=createEffectDispatcher({journal,authorize:async()=>{},dispatch:async({idempotencyKey})=>({id:idempotencyKey})});
await effects.execute({effectId:'effect',fence:{},input:{}});
// @ts-expect-error request policy is a closed domain contract
await attachedClient.request({kind:'review',title:'Review',input:null,target:{kind:'signer',deviceId:'key'},slots:[],responsePolicy:'all-connected-tabs'});
// @ts-expect-error claims do not accept an arbitrary operation reference as an epoch
await attachedClient.claim({taskId:'task',slotId:'slot',expectedEpoch:'latest'});
