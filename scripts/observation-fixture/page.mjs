import { connectApplicationOwner } from '@chronolog/peer-session/browser';
import { startRuntime } from '@tendriller/runtime/kernel';
import { mountObservations } from '../../docs/tutorial/shared/observation/panel.mjs';
import { createReviewedInput } from '../../docs/tutorial/shared/helpers/reviewed-input.mjs';
import { createCameraController } from '../../docs/tutorial/shared/media/camera.mjs';
import { createPeerInferenceClient } from '../../docs/tutorial/shared/media/inference-client.mjs';
const worker=window.worker=new Worker('/worker.mjs',{type:'module'});
let closed;const closedPromise=new Promise(resolve=>closed=resolve);
worker.addEventListener('error',event=>{throw Error(event.message);});
worker.addEventListener('message',({data})=>{void(async()=>{
  if(data?.type==='identity')window.identity=data.publicKey;
  if(data?.type==='failure')throw Error(data.message);
  if(data?.type==='closed')closed();
  if(data?.type==='bridge-out') {
    try {await window.__nativeFrame(data.lane,data.bytes);worker.postMessage({type:'bridge-ack',id:data.id});}
    catch(error){worker.postMessage({type:'bridge-ack',id:data.id,error:error.message});}
  }
})().catch(error=>{setTimeout(()=>{throw error;});});});
window.setup=async({applicationId,nativePublicKey})=>{
  const channel=new MessageChannel();worker.postMessage({type:'attach',port:channel.port1},[channel.port1]);
  const session=window.session=await connectApplicationOwner(channel.port2,{applicationId});
  const runtime=window.runtime=startRuntime({id:'observation-fixture',base:'/',version:0,documentPath:null,application:{id:applicationId}});
  window.controller=mountObservations({container:document.querySelector('main'),session,runtime,nativeDeviceId:nativePublicKey});
  const inference=window.inference=createPeerInferenceClient({session,workerDeviceId:nativePublicKey,prompt:'Return the deterministic transport-test result; no external model is called.'});
  const review=window.mediaReview=createReviewedInput({analyze:input=>inference.analyze(input),commit:async()=>{throw Error('Analysis must not dispatch a durable command.');}});
  const camera=window.camera=createCameraController({runtime,video:document.querySelector('video')});
  const bind=(id,action)=>document.querySelector(id).addEventListener('click',event=>{
    if(!event.isTrusted)throw Error('Use a trusted local review action.');
    Promise.resolve(action(event)).catch(error=>{window.mediaError=error.message;});
  });
  bind('#media-start',event=>camera.start(event));
  bind('#media-capture',async()=>{
    const context={question:'original reviewed question',revision:1};
    const capturing=review.capture({blob:await camera.capture({type:'image/png'}),context});
    context.question='mutated after capture';await capturing;
  });
  bind('#media-analyze',()=>review.analyze());
  window.closeOwner=async()=>{
    camera.dispose();inference.close();review.close();await window.controller.close();await session.close();
    worker.postMessage({type:'close'});await closedPromise;worker.terminate();
  };
  return {publicKey:session.identity.publicKey,endpoint:session.endpoint};
};
