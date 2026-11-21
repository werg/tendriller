// Actual browser/storage qualification of the public owner composition, without a hosted service.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),out=join(root,'.results/collaboration-browser-assets');
await mkdir(out,{recursive:true});
await build({absWorkingDir:root,entryPoints:{page:'collaboration/test/browser/page.mjs',worker:'collaboration/test/browser/worker.mjs'},
  bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',outdir:out,outExtension:{'.js':'.mjs'}});
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'||path==='/board.html'||path==='/discussion.html'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Owner conformance</title><script type="module" src="/page.mjs"></script>');return;}
  if(!/^\/[A-Za-z0-9_.-]+\.mjs$/.test(path)){res.writeHead(404);res.end();return;}
  try{res.writeHead(200,{'content-type':'text/javascript'});res.end(await readFile(join(out,path.slice(1))));}catch{res.writeHead(404);res.end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${server.address().port}`;
let browser;const evidence={status:'failed',stage:'launch',scenarios:[],completedStages:[],diagnostics:[],scope:'Actual Chromium; local origin, events backend; no mobile/provider/Internet claim'};
async function stage(name,run){
  evidence.stage=name;console.log(`Browser qualification: ${name}`);let timer;
  try{const result=await Promise.race([run(),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(`Browser stage timed out: ${name}`)),25000);})]);
    evidence.completedStages.push(name);return result;
  }finally{clearTimeout(timer);}
}
function observe(page,label){
  const record=message=>{if(evidence.diagnostics.length<64)evidence.diagnostics.push({page:label,stage:evidence.stage,message});};
  page.on('pageerror',error=>record(error.message));page.on('console',message=>{if(message.type()==='error')record(message.text());});
}
const deadline=setTimeout(()=>{evidence.failure=`Browser qualification exceeded its 120 second deadline at ${evidence.stage}`;void browser?.close();},120000);
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  evidence.browser=browser.version();
  for(const mode of ['shared','elected']){
    const context=await browser.newContext(),profile=`qualification-${mode}`,one=await context.newPage(),two=await context.newPage();
    observe(one,`${mode}:one`);observe(two,`${mode}:two`);
    const url=(path,view='copied-view')=>`${base}/${path}?profile=${profile}&mode=${mode}&view=${view}`;
    const a=await stage(`${mode}:identity-and-first-attachment`,async()=>{await one.goto(url('board.html')+'&identity=create');return one.evaluate(()=>window.ready);});
    await stage(`${mode}:participant-focus`,()=>one.evaluate(()=>window.verifyParticipantPanel()));
    await stage(`${mode}:same-page-reattach-keeps-the-owner`,async()=>{
      // An app-level reconnect in the only page must not restart the owner (and its peer connections).
      const endpoint=await one.evaluate(()=>window.reattach());
      assert.equal(endpoint.ownerInstanceId,a.endpoint.ownerInstanceId,JSON.stringify(await one.evaluate(()=>window.reattachTrace)));
    });
    const b=await stage(`${mode}:second-attachment`,async()=>{await two.goto(url('discussion.html'));return two.evaluate(()=>window.ready);});
    assert.equal(a.deviceId,b.deviceId);assert.equal(a.endpoint.ownerInstanceId,b.endpoint.ownerInstanceId);
    assert.notEqual(a.endpoint.endpointIncarnation,b.endpoint.endpointIncarnation);assert.notEqual(a.endpoint.context.viewId,b.endpoint.context.viewId);
    assert.equal(a.status.database,'idle');assert.equal(b.status.database,'idle');
    await stage(`${mode}:signal-subscription-readiness`,()=>two.evaluate(async()=>{
      const iterator=window.session.signals.subscribe({topics:['progress','fixture-ready'],mode:'latest',signal:AbortSignal.timeout(15000)})[Symbol.asyncIterator]();
      window.signalIterator=iterator;let received=false;
      const admitted=iterator.next().then(result=>{if(result.done||result.value.topic!=='fixture-ready')throw Error('Signal subscription readiness failed');received=true;});
      // Ephemeral sends do not acknowledge subscriber admission. Observe a real
      // fixture probe before the one-shot cross-page assertion; no arbitrary sleep.
      for(let index=0;index<32&&!received;index++)await window.session.signals.send('fixture-ready',{probe:index},{stream:{streamId:'fixture-readiness'}});
      await admitted;
      window.signalNext=(async()=>{for(;;){const result=await iterator.next();if(result.done)throw Error('Live progress signal deadline expired');
        if(result.value.topic==='progress')return result.value;}})();
    }));
    await stage(`${mode}:cross-endpoint-signal`,async()=>{
      await one.evaluate(()=>window.session.signals.send('progress',{run:'one'},{stream:{streamId:'run-one'}}));
      const signal=await two.evaluate(async()=>{const value=await window.signalNext;await window.signalIterator.return();return{value,status:window.session.status};});
      assert.equal(signal.value.stream.endpointId,await one.evaluate(()=>window.session.endpoint.endpointId));assert.equal(signal.status.database,'idle');
    });
    await stage(`${mode}:drafts-and-commands`,async()=>{
      await one.evaluate(()=>window.viewStore.writeDraft({text:'board draft'}));await two.evaluate(()=>window.viewStore.writeDraft({text:'discussion draft'}));
      assert.equal(await one.evaluate(()=>window.viewStore.readDraft().text),'board draft');
      await one.evaluate(async()=>{const op=await window.session.command('say','first',{operationId:'first'});await op.applied();});
      await two.evaluate(async()=>{const op=await window.session.command('say','second',{operationId:'second'});await op.applied();});
      assert.equal(await two.evaluate(async()=>(await window.session.query('messages',null)).value.events.length),2);
    });
    await stage(`${mode}:suspend-resume`,async()=>{
      const before=await one.evaluate(()=>window.session.endpoint.endpointIncarnation);
      await one.evaluate(()=>window.attachment.suspend());await one.evaluate(()=>window.attachment.resume());
      assert.equal(await one.evaluate(()=>window.session.endpoint.endpointIncarnation),before);
    });
    await stage(`${mode}:follower-reload-retains-view`,async()=>{
      await two.reload();const reloaded=await two.evaluate(()=>window.ready);
      assert.equal(reloaded.endpoint.context.viewId,b.endpoint.context.viewId);
      assert.notEqual(reloaded.endpoint.endpointIncarnation,b.endpoint.endpointIncarnation);
      assert.equal(await two.evaluate(()=>window.viewStore.readDraft().text),'discussion draft');
      assert.equal(reloaded.endpoint.ownerInstanceId,a.endpoint.ownerInstanceId);
    });
    if(mode==='shared'){
      await stage('shared:another-worker-version-attaches-to-the-existing-owner',async()=>{
        // A tab on a different publication's Worker URL gets its own SharedWorker,
        // which cannot take the held profile. It must attach to the owner, not fail OWNER_BUSY.
        const three=await context.newPage();observe(three,'shared:three');
        await three.goto(url('board.html','third-view')+'&variant=next');
        const c=await three.evaluate(()=>window.ready);
        assert.equal(c.deviceId,a.deviceId);assert.equal(c.endpoint.ownerInstanceId,a.endpoint.ownerInstanceId);
        await three.evaluate(async()=>{const op=await window.session.command('say','third',{operationId:'third'});await op.applied();});
        await three.close();
      });
      await stage('shared:repeated-root-detach',async()=>{
        assert.deepEqual(await two.evaluate(()=>window.cycleRoots(12)),[a.endpoint.ownerInstanceId]);
      });
      await stage('shared:local-detach-preserves-sibling',async()=>{
        await one.evaluate(()=>window.attachment.detach());
        assert.equal(await two.evaluate(async()=>(await window.session.operations.inspect('first')).state.status),'applied');
        await one.reload();const again=await one.evaluate(()=>window.ready);assert.equal(again.endpoint.ownerInstanceId,a.endpoint.ownerInstanceId);
      });
      await stage('shared:underlying-session-close-and-reopen',async()=>{
        await two.evaluate(()=>window.closeUnderlyingSession());
        await Promise.all([one.waitForFunction(()=>window.session.status.phase==='closed'),two.waitForFunction(()=>window.session.status.phase==='closed')]);
        await two.waitForFunction(async()=>!(await navigator.locks.query()).held.some(lock=>lock.name===`chronolog-owner:${window.ownerProfile}`));
        await two.reload();const reopened=await two.evaluate(()=>window.ready);
        assert.equal(reopened.deviceId,a.deviceId);assert.notEqual(reopened.endpoint.ownerInstanceId,a.endpoint.ownerInstanceId);
        assert.equal(await two.evaluate(async()=>(await window.session.operations.inspect('first')).state.status),'applied');
      });
    }else{
      await stage('elected:local-detach-preserves-sibling',async()=>{
        await one.evaluate(()=>window.attachment.detach());
        assert.equal(await two.evaluate(async()=>(await window.session.operations.inspect('first')).state.status),'applied');
        assert.equal(await two.evaluate(()=>window.session.endpoint.ownerInstanceId),a.endpoint.ownerInstanceId);
        assert.notEqual(await two.evaluate(()=>window.session.status.phase),'closed');
      });
      await stage('elected:physical-owner-page-close-and-reopen',async()=>{
        // Physical page death can terminate its dedicated Worker. A retired
        // local attachment alone must not do so while an authenticated sibling lives.
        await one.close();await two.waitForFunction(()=>window.session.status.phase==='closed');
        await two.reload();const reopened=await two.evaluate(()=>window.ready);assert.equal(reopened.deviceId,a.deviceId);
        assert.notEqual(reopened.endpoint.ownerInstanceId,a.endpoint.ownerInstanceId);
        assert.equal(await two.evaluate(async()=>(await window.session.operations.inspect('first')).state.status),'applied');
      });
    }
    evidence.scenarios.push({mode,oneSigner:true,twoDocuments:true,duplicateViewFenced:true,protocolOnlyCold:true,signedLocalSignals:true,
      concurrentCommands:true,independentDrafts:true,...(mode==='shared'?{otherWorkerVersionAttaches:true}:{}),samePageReattachKeepsOwner:true,suspendResume:true,detachPreservesSibling:true,detachOrCrashReopen:true,
      asyncIdentityBootstrap:true,participantFocus:true,reloadPreservesDraft:true,...(mode==='shared'?{boundedRootReuse:true,sessionCloseReleasesFence:true}:{})});
    await context.close();
  }
  evidence.stage='complete';evidence.status='passed';console.log(JSON.stringify(evidence,null,2));
}catch(error){evidence.failure??=error.stack??String(error);console.error(JSON.stringify(evidence,null,2));throw error;
}finally{clearTimeout(deadline);await browser?.close();await new Promise(done=>server.close(done));await writeFile(join(root,'.results/collaboration-browser.json'),JSON.stringify(evidence,null,2)+'\n');}
