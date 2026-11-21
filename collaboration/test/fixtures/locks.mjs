import assert from 'node:assert/strict';
// Model browser lock names independently: the document witness and protocol
// owner are separate locks, and query() must not request or contend for either.
export class FixtureLocks{
 held=new Map();pending=new Map();
 query(){return Promise.resolve({held:[...this.held.values()].map(({name,mode,clientId})=>({name,mode,clientId})),pending:[...this.pending.values()].flat().map(({name,mode,clientId})=>({name,mode,clientId}))});}
 request(name,options,run){
  if(typeof options==='function'){run=options;options={};}
  if(options.ifAvailable&&options.signal)return Promise.reject(new DOMException('signal and ifAvailable cannot be combined','NotSupportedError'));
  options.signal?.throwIfAborted();assert.equal(options.mode??'exclusive','exclusive');
  if(this.held.has(name)&&options.ifAvailable)return Promise.resolve().then(()=>run(null));
  return new Promise((resolve,reject)=>{
   const job={name,mode:'exclusive',clientId:name==='chronolog-owner:retained'?'fixture-worker':`fixture-document:${name}`,run,resolve,reject,signal:options.signal};
   job.abort=()=>{const queue=this.pending.get(name)??[],index=queue.indexOf(job);if(index<0)return;queue.splice(index,1);if(!queue.length)this.pending.delete(name);job.signal.removeEventListener('abort',job.abort);reject(job.signal.reason);};
   if(this.held.has(name)){const queue=this.pending.get(name)??[];queue.push(job);this.pending.set(name,queue);job.signal?.addEventListener('abort',job.abort,{once:true});}
   else this.grant(job);
  });
 }
 grant(job){
  job.signal?.removeEventListener('abort',job.abort);this.held.set(job.name,job);
  void Promise.resolve().then(()=>job.run({name:job.name,mode:job.mode})).then(job.resolve,job.reject).finally(()=>{
   this.held.delete(job.name);const queue=this.pending.get(job.name);if(!queue?.length)return;const next=queue.shift();if(!queue.length)this.pending.delete(job.name);this.grant(next);
  });
 }
}

