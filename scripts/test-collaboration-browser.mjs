// Actual browser/storage qualification of the public owner composition, without a hosted service.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
import {launchNetworkBrowser} from '../test/e2e/network-qualification/browser-launch.mjs';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const qualifyLifecycle=process.env.TENDRILLER_BROWSER_LIFECYCLE==='1';
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
let browser,lifecycleBrowser;const evidence={status:'failed',stage:'launch',scenarios:[],completedStages:[],diagnostics:[],scope:'Actual Chromium; local origin, events backend; no mobile/provider/Internet claim'};
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
  const launchOptions=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{};
  if(qualifyLifecycle){lifecycleBrowser=await launchNetworkBrowser(launchOptions);browser=lifecycleBrowser.browser;}
  else browser=await chromium.launch({headless:true,...launchOptions});
  evidence.browser=browser.version();
  for(const mode of ['shared','elected']){
    const context=lifecycleBrowser?.context??await browser.newContext(),profile=`qualification-${mode}`,one=await context.newPage(),two=await context.newPage();
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
    if(qualifyLifecycle)await stage(`${mode}:automatic-freeze-retains-document-and-owner`,async()=>{
      // A DedicatedWorker freezes with its owning page. Freeze the follower
      // in elected mode so this case measures a genuinely live owner.
      const selected=mode==='elected'?two:one,sibling=mode==='elected'?one:two;
      const before=await selected.evaluate(()=>{window.freezeMarker=crypto.randomUUID();window.freezeEvents=[];
        for(const type of ['freeze','resume'])document.addEventListener(type,()=>window.freezeEvents.push(type));
        return{marker:window.freezeMarker,endpoint:window.session.endpoint,deviceId:window.session.deviceId};});
      const cdp=await context.newCDPSession(selected);let cover;
      try{
        await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
        cover=await context.newPage();await cover.goto('about:blank');await cover.bringToFront();
        assert.equal(await selected.evaluate(()=>document.hidden),true,'Selected document must really be hidden before freeze');
        // Endpoint observation state is independent from root RTC authority.
        await sibling.waitForFunction(async id=>(await window.session.endpoints()).some(row=>row.endpointId===id&&row.state==='suspended'),before.endpoint.endpointId,{timeout:5000});
        await cdp.send('Page.setWebLifecycleState',{state:'frozen'});
        // Cross the unchanged 15s page fence while the healthy owner still serves
        // a sibling. This is actual Chromium suspension, not a synthetic event.
        await sibling.evaluate(()=>window.session.query('messages',null));
        await new Promise(resolve=>setTimeout(resolve,16000));
        await cdp.send('Page.setWebLifecycleState',{state:'active'});await cover.close();cover=undefined;await selected.bringToFront();
        await selected.waitForFunction(()=>window.freezeEvents.includes('resume'),null,{timeout:5000});
        await sibling.waitForFunction(async id=>(await window.session.endpoints()).some(row=>row.endpointId===id&&row.state==='active'),before.endpoint.endpointId,{timeout:5000});
        const after=await selected.evaluate(async()=>({marker:window.freezeMarker,events:window.freezeEvents,endpoint:window.session.endpoint,deviceId:window.session.deviceId,aborted:window.session.signal.aborted,eventsRead:(await window.session.query('messages',null)).value.events.length}));
        assert.equal(after.marker,before.marker);assert.deepEqual(after.events,['freeze','resume']);assert.deepEqual(after.endpoint,before.endpoint);assert.equal(after.deviceId,before.deviceId);assert.equal(after.aborted,false);assert.equal(after.eventsRead,2);
      }finally{await cdp.send('Page.setWebLifecycleState',{state:'active'}).catch(()=>{});await cover?.close();await cdp.detach();}
    });
    await stage(`${mode}:follower-reload-retains-view`,async()=>{
      await two.reload();const reloaded=await two.evaluate(()=>window.ready);
      assert.equal(reloaded.endpoint.context.viewId,b.endpoint.context.viewId);
      assert.notEqual(reloaded.endpoint.endpointIncarnation,b.endpoint.endpointIncarnation);
      assert.equal(await two.evaluate(()=>window.viewStore.readDraft().text),'discussion draft');
      assert.equal(reloaded.endpoint.ownerInstanceId,a.endpoint.ownerInstanceId);
    });
    if(mode==='shared'){
      if(qualifyLifecycle)await stage('shared:frozen-document-discard-reclaims-root-capacity',async()=>{
        const before=await two.evaluate(async()=>({deviceId:window.session.deviceId,ownerInstanceId:window.session.endpoint.ownerInstanceId,
          operation:await window.session.operations.inspect('first'),eventCount:(await window.session.query('messages',null)).value.events.length}));
        // maxPorts is four. Six discarded roots plus two retained siblings must
        // force fresh admission scans; BC attachment would hide a root leak.
        const wireProof=[];
        for(let index=0;index<6;index++){
          const wire={droppedRootDetaches:0};
          const orphan=await context.newPage();let cover,cdp,timer;
          try{
            await orphan.exposeBinding('__orphanWire',(_source,type)=>{if(type==='root.detach.dropped')wire.droppedRootDetaches++;});
            await orphan.goto(url('discussion.html',`orphan-${index}`)+'&lost-teardown=1');const attached=await orphan.evaluate(()=>window.ready);
            assert.equal(attached.mode,'shared','BC fallback must not mask exhausted SharedWorker capacity');
            assert.deepEqual(attached.portEventFault?.events,['close','messageerror']);
            assert.equal(await two.evaluate(async name=>(await navigator.locks.query()).held.some(lock=>lock.name===name),attached.portEventFault.witnessName),true,'live document witness must exist');
            assert.equal(attached.deviceId,before.deviceId);assert.equal(attached.endpoint.ownerInstanceId,before.ownerInstanceId);
            const events=[];let frozen;const observed=new Promise(resolve=>{frozen=resolve;});
            await orphan.exposeBinding('__orphanLifecycle',(_source,type)=>{events.push(type);if(type==='freeze')frozen();});
            await orphan.evaluate(()=>{for(const type of ['freeze','resume'])document.addEventListener(type,()=>{void window.__orphanLifecycle(type);});});
            cdp=await context.newCDPSession(orphan);await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
            cover=await context.newPage();await cover.goto('about:blank');await cover.bringToFront();assert.equal(await orphan.evaluate(()=>document.hidden),true);
            await two.waitForFunction(async id=>(await window.session.endpoints()).some(row=>row.endpointId===id&&row.state==='suspended'),attached.endpoint.endpointId,{timeout:5000});
            await cdp.send('Page.setWebLifecycleState',{state:'frozen'});
            try{await Promise.race([observed,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('ORPHAN_FREEZE_NOT_OBSERVED')),5000);})]);}finally{clearTimeout(timer);}
            // The fixture drops root.detach at MessagePort.postMessage. Any
            // pagehide work during close cannot notify the Worker of teardown.
            // Deliberately never thaw or call application detach. Browser death
            // releases the witness while this Worker keeps serving the siblings.
            await orphan.close();assert.deepEqual(events,['freeze']);
            await cdp.detach().catch(()=>{});cdp=undefined;
            await two.waitForFunction(async name=>!(await navigator.locks.query()).held.some(lock=>lock.name===name),attached.portEventFault.witnessName,{timeout:5000});
            wireProof.push(wire);
          }finally{await orphan.close().catch(()=>{});await cover?.close();await cdp?.detach().catch(()=>{});}
        }
        // One fresh root forces admission GC for the last discarded pair too.
        // cycleRoots asserts SharedWorker mode and then closes only its live root.
        assert.deepEqual(await two.evaluate(()=>window.cycleRoots(1)),[before.ownerInstanceId]);
        const after=await two.evaluate(async()=>({deviceId:window.session.deviceId,ownerInstanceId:window.session.endpoint.ownerInstanceId,
          operation:await window.session.operations.inspect('first'),eventCount:(await window.session.query('messages',null)).value.events.length}));
        assert.deepEqual(after,before);assert.equal(await one.evaluate(()=>window.session.signal.aborted),false);
        evidence.frozenDiscardWire={pages:wireProof,detachFault:'dropped-before-native-post',nativePortEventsBlocked:['close','messageerror'],missingWitnessesVerified:6,droppedRootDetaches:wireProof.reduce((sum,page)=>sum+page.droppedRootDetaches,0)};
      });
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
      concurrentCommands:true,independentDrafts:true,...(mode==='shared'?{otherWorkerVersionAttaches:true}:{}),samePageReattachKeepsOwner:true,suspendResume:true,automaticChromiumFreezeResume:qualifyLifecycle,detachPreservesSibling:true,detachOrCrashReopen:true,
      asyncIdentityBootstrap:true,participantFocus:true,reloadPreservesDraft:true,...(mode==='shared'?{boundedRootReuse:true,frozenDiscardCapacityReclaimed:qualifyLifecycle,frozenDiscardCount:qualifyLifecycle?6:0,sessionCloseReleasesFence:true}:{})});
    if(lifecycleBrowser)await Promise.all(context.pages().map(page=>page.close()));else await context.close();
  }
  evidence.stage='complete';evidence.status='passed';console.log(JSON.stringify(evidence,null,2));
}catch(error){evidence.failure??=error.stack??String(error);console.error(JSON.stringify(evidence,null,2));throw error;
}finally{clearTimeout(deadline);if(lifecycleBrowser)await lifecycleBrowser.close();else await browser?.close();await new Promise(done=>server.close(done));await writeFile(join(root,'.results/collaboration-browser.json'),JSON.stringify(evidence,null,2)+'\n');}
