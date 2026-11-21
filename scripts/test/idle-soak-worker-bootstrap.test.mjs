import test from 'node:test';
import assert from 'node:assert/strict';
import { observeWorkerBootstraps } from '../idle-soak/worker-bootstrap.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
class Socket extends EventTarget {
 static latest;
 constructor() { super(); Socket.latest = this; this.commands = []; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
 emit(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
 send(text) { const m=JSON.parse(text); this.commands.push(m); queueMicrotask(()=>this.emit({id:m.id,result:m.method==='Runtime.evaluate'?{result:{value:{ready:true,url:this.replyURL??this.url}}}:{}})); }
 attach(url='https://fixture.invalid/worker.mjs',targetId='target',sessionId='worker-session') { this.url=url;this.emit({method:'Target.attachedToTarget',params:{sessionId,waitingForDebugger:true,targetInfo:{type:'shared_worker',targetId,url}}}); }
 finished(requestId='target',sessionId='worker-session') { this.emit({method:'Network.loadingFinished',sessionId,params:{requestId,encodedDataLength:0}}); }
 close() { this.closed=true; }
}
test('only exact worker session and main request/target correlation plus executable URL completes a load',async()=>{
 const completions=[],observer=await observeWorkerBootstraps('ws://127.0.0.1',url=>completions.push(url),{Socket});const socket=Socket.latest;
 socket.attach();await flush();socket.finished('wrong');socket.finished('target','other-session');await flush();assert.deepEqual(completions,[]);
 socket.finished();await observer.finish();assert.deepEqual(completions,['https://fixture.invalid/worker.mjs']);await observer.close();
 assert.equal(socket.closed,true);assert.deepEqual(socket.commands.at(-1).params,{autoAttach:false,waitForDebuggerOnStart:false,flatten:true});
});
test('network completion cannot substitute for a mismatched executable worker reply',async()=>{
 const completions=[],observer=await observeWorkerBootstraps('ws://127.0.0.1',url=>completions.push(url),{Socket});const socket=Socket.latest;
 socket.replyURL='https://fixture.invalid/other.mjs';socket.attach();socket.finished();await assert.rejects(observer.finish(),/IDENTITY_MISMATCH/);assert.deepEqual(completions,[]);await observer.close();
});
test('an unfinished network load fails closed; cleanup cancels its startup deadline and fences late messages',async()=>{
 const completions=[],observer=await observeWorkerBootstraps('ws://127.0.0.1',url=>completions.push(url),{Socket,timeoutMs:50});const socket=Socket.latest;
 socket.attach();await flush();const finished=observer.finish();const rejected=assert.rejects(finished,/CLOSED/);await observer.close();await rejected;socket.finished();await flush();assert.deepEqual(completions,[]);
});
