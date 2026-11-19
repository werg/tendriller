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
let browser;const evidence={scenarios:[],scope:'Actual Chromium; local origin, events backend; no mobile/provider/Internet claim'};
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  evidence.browser=browser.version();
  for(const mode of ['shared','elected']){
    const context=await browser.newContext(),profile=`qualification-${mode}`,one=await context.newPage(),two=await context.newPage();
    const url=(path,view='copied-view')=>`${base}/${path}?profile=${profile}&mode=${mode}&view=${view}`;
    await one.goto(url('board.html'));const a=await one.evaluate(()=>window.ready);
    await two.goto(url('discussion.html'));const b=await two.evaluate(()=>window.ready);
    assert.equal(a.deviceId,b.deviceId);assert.equal(a.endpoint.ownerInstanceId,b.endpoint.ownerInstanceId);
    assert.notEqual(a.endpoint.endpointIncarnation,b.endpoint.endpointIncarnation);assert.notEqual(a.endpoint.context.viewId,b.endpoint.context.viewId);
    assert.equal(a.status.database,'idle');assert.equal(b.status.database,'idle');
    await two.evaluate(async()=>{window.signalIterator=window.session.signals.subscribe({topics:['progress'],mode:'latest'})[Symbol.asyncIterator]();window.signalNext=window.signalIterator.next();});
    await one.evaluate(()=>window.session.signals.send('progress',{run:'one'},{stream:{streamId:'run-one'}}));
    const signal=await two.evaluate(async()=>{const value=(await window.signalNext).value;await window.signalIterator.return();return{value,status:window.session.status};});
    assert.equal(signal.value.stream.endpointId,a.endpoint.endpointId);assert.equal(signal.status.database,'idle');
    await one.evaluate(()=>window.viewStore.writeDraft({text:'board draft'}));await two.evaluate(()=>window.viewStore.writeDraft({text:'discussion draft'}));
    assert.equal(await one.evaluate(()=>window.viewStore.readDraft().text),'board draft');
    await one.evaluate(async()=>{const op=await window.session.command('say','first',{operationId:'first'});await op.applied();});
    await two.evaluate(async()=>{const op=await window.session.command('say','second',{operationId:'second'});await op.applied();});
    assert.equal(await two.evaluate(async()=>(await window.session.query('messages',null)).value.events.length),2);
    await one.evaluate(()=>window.attachment.suspend());await one.evaluate(()=>window.attachment.resume());
    assert.equal(await one.evaluate(()=>window.session.endpoint.endpointIncarnation),a.endpoint.endpointIncarnation);
    if(mode==='shared'){
      await one.evaluate(()=>window.attachment.detach());await one.close();
      assert.equal(await two.evaluate(async()=>(await window.session.operations.inspect('first')).state.status),'applied');
    }else{
      // Real Worker termination releases the Web Lock; the queued follower becomes owner.
      await one.close();await two.waitForFunction(()=>window.session.status.phase==='closed');
      await two.reload();const reopened=await two.evaluate(()=>window.ready);assert.equal(reopened.deviceId,a.deviceId);
      assert.notEqual(reopened.endpoint.ownerInstanceId,a.endpoint.ownerInstanceId);
      assert.equal(await two.evaluate(async()=>(await window.session.operations.inspect('first')).state.status),'applied');
    }
    evidence.scenarios.push({mode,oneSigner:true,twoDocuments:true,duplicateViewFenced:true,protocolOnlyCold:true,signedLocalSignals:true,
      concurrentCommands:true,independentDrafts:true,suspendResume:true,detachOrCrashReopen:true});await context.close();
  }
  evidence.status='passed';console.log(JSON.stringify(evidence,null,2));
}finally{await browser?.close();await new Promise(done=>server.close(done));await writeFile(join(root,'.results/collaboration-browser.json'),JSON.stringify(evidence,null,2)+'\n');}
