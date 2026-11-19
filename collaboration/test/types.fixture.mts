import type { ApplicationSession } from '@chronolog/peer-session';
import type { WorkerApplicationSession } from '@chronolog/peer-session/browser';
import { createCollaborationClient, createViewStore, createEffectDispatcher, mountParticipantPanel, type ParticipantEntry } from '../index.mjs';
import { createSqliteEffectJournal } from '../native.mjs';
declare const native: ApplicationSession;
declare const attached: WorkerApplicationSession;
const nativeClient=createCollaborationClient({session:native});
const attachedClient=createCollaborationClient({session:attached});
const snapshot=await attachedClient.snapshot();
const reference=snapshot.value.tasks[0]?.operation;
if(reference){const attempt:string=reference.attemptId;await nativeClient.inspectOperation(reference);void attempt;}
const store=createViewStore<{text:string}>({storage:localStorage,applicationId:'app',profileId:'profile',viewId:'view'});
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
