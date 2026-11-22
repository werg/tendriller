// Request-driven portable adapter. The embedding host supplies authorization and
// a cross-isolate storage-owner lock; an isolate-local promise queue is not one.
const fail = (code, message, status = 500) => Object.assign(new Error(message), {code, status});
const errorInfo = error => ({code: error?.code ?? 'serverless_error', message: error?.message ?? 'Serverless execution failed.'});
const bounded = (value, fallback, maximum) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw fail('SERVERLESS_LIMIT_INVALID', 'Invalid request limit.');
  return value;
};
function boundary(parent, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => controller.abort(fail('serverless_deadline', 'Request deadline expired; inspect original operation IDs.', 504)), timeoutMs);
  return {signal:controller.signal, dispose(){clearTimeout(timer);parent?.removeEventListener('abort',abort);}};
}
function until(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(()=>{}); return Promise.reject(signal.reason); }
  return new Promise((resolve,reject) => {
    const abort = () => {signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
const bytes = value => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (!(value instanceof Uint8Array)) throw fail('SERVERLESS_STORAGE_INVALID','Storage values must be byte arrays.');
  return Uint8Array.from(value);
};

/** Raw byte-store wrapper. Its caller must hold the storage-owner lock for the
 * entire operation; list-of-keys enumeration otherwise cannot be a snapshot. */
export function createTransactionalBytesStore(backend) {
  if (!backend || typeof backend.get !== 'function' || typeof backend.put !== 'function')
    throw fail('SERVERLESS_STORAGE_INVALID','Supply get(key), put(key, bytes) and optional list().');
  return Object.freeze({
    async get(key){const value=await backend.get(key);return value==null?null:bytes(value);},
    async put(key,value){await backend.put(key,bytes(value));},
    async entries(){
      if(typeof backend.list!=='function')throw fail('CHECKPOINT_ENUMERATION_UNSUPPORTED','Storage must implement list() for checkpoint export.');
      const listed=await backend.list();
      // Durable Object list() already supplies an atomic snapshot of rows.
      if(listed instanceof Map)return [...listed].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>{
        if(typeof key!=='string')throw fail('SERVERLESS_STORAGE_INVALID','Storage keys must be strings.');
        return {key,value:bytes(value)};
      });
      if(!Array.isArray(listed)||listed.some(key=>typeof key!=='string'))throw fail('SERVERLESS_STORAGE_INVALID','list() must return keys or a Map of byte rows.');
      const out=[];
      for(const key of [...listed].sort()){const value=await backend.get(key);if(value!=null)out.push({key,value:bytes(value)});}
      return out;
    },
  });
}
const lifecycle = state => {
  if(state?.status==='abandoned'||state?.status==='needsReapply')return state.status;
  if(state?.status==='saved')return 'recorded';
  if(state?.status==='applied' || state?.outcome==='accepted' || state?.outcome==='rejected')
    return state.outcome==='rejected'?'rejected':state.outcome==='accepted'?'applied':'unknown';
  return 'unknown';
};
const commandInput = item => {
  if(!item || typeof item.command!=='string' || !item.command.length || item.command.length>128 ||
    typeof item.operationId!=='string' || !item.operationId.length || item.operationId.length>256 ||
    item.wait!==undefined && !['recorded','applied'].includes(item.wait))
    throw fail('invalid_command','Supply a command, original operationId and optional recorded/applied wait.',400);
  return item;
};
async function readJson(request, signal, maximum) {
  const length=request.headers.get('content-length');
  if(length!==null && (!/^\d+$/u.test(length)||Number(length)>maximum))throw fail('request_body_limit','Request body exceeds its bound.',413);
  const reader=request.body?.getReader();
  if(!reader)throw fail('invalid_json','A JSON object body is required.',400);
  const chunks=[];let size=0,complete=false;
  try {
    for(;;){const {done,value}=await until(reader.read(),signal);if(done){complete=true;break;}
      size+=value.byteLength;if(size>maximum)throw fail('request_body_limit','Request body exceeds its bound.',413);chunks.push(value);}
    const joined=new Uint8Array(size);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
    let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined));}catch{throw fail('invalid_json','A valid JSON object is required.',400);}
    if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw fail('invalid_json','A JSON object is required.',400);
    return parsed;
  } finally {if(!complete)void reader.cancel().catch(()=>{});reader.releaseLock();}
}

export function createServerlessHostAdapter({applicationId,storage,withLock,openSession,authorize,timeoutMs,maxBodyBytes}) {
  if(typeof applicationId!=='string'||!/^[a-f0-9]{64}$/u.test(applicationId))throw fail('SERVERLESS_APP_ID_INVALID','Supply a lowercase hex64 applicationId.');
  if(typeof withLock!=='function')throw fail('SERVERLESS_OWNER_LOCK_REQUIRED','Supply a storage-owner lock shared by every isolate using this application.');
  if(typeof authorize!=='function')throw fail('SERVERLESS_AUTHORIZATION_REQUIRED','Supply explicit request authorization.');
  if(typeof openSession!=='function')throw fail('SERVERLESS_OPEN_SESSION_REQUIRED','Supply openSession({store,signal}).');
  timeoutMs=bounded(timeoutMs,30_000,120_000);maxBodyBytes=bounded(maxBodyBytes,65_536,1_048_576);
  const rawStore=createTransactionalBytesStore(storage);
  async function active(signal,run) {
    const scope=boundary(signal,timeoutMs);
    // Only the response races the deadline. The physical work retains the owner
    // lock until open/run/flush/close settle, including non-cooperative promises.
    const physical=Promise.resolve().then(()=>withLock(applicationId,async()=>{
      scope.signal.throwIfAborted();
      let owned, result, primary, failed=false;const cleanupErrors=[];
      try {
        owned=await openSession({store:rawStore,signal:scope.signal});
        if(!owned?.session)throw fail('SERVERLESS_SESSION_INVALID','openSession must return {session}.');
        scope.signal.throwIfAborted();result=await run(owned,scope.signal);
      } catch(error){failed=true;primary=error;}
      if(owned){
        try{if(typeof owned.flush==='function')await owned.flush();}catch(error){cleanupErrors.push(error);}
        try{if(typeof owned.close==='function')await owned.close();else await owned.session?.close?.();}catch(error){cleanupErrors.push(error);}
      }
      if(failed){
        if(!cleanupErrors.length)throw primary;
        throw Object.assign(fail(primary?.code??'serverless_error',primary?.message??'Serverless execution failed.',primary?.status??500),{cause:primary,cleanupErrors:cleanupErrors.map(errorInfo)});
      }
      if(cleanupErrors.length)throw Object.assign(fail('serverless_cleanup_failed','State flush or owned shutdown failed.'),{cause:cleanupErrors[0],cleanupErrors:cleanupErrors.map(errorInfo)});
      return result;
    },{signal:scope.signal}));
    try{return await until(physical,scope.signal);}finally{scope.dispose();}
  }
  // Public store access takes the same owner lock; internal session IO uses the
  // raw store under its already-held lock, avoiding recursive lock acquisition.
  const store=Object.freeze(Object.fromEntries(['get','put','entries'].map(name=>[name,async(...args)=>{
    const scope=boundary(undefined,timeoutMs);
    const physical=Promise.resolve().then(()=>withLock(applicationId,()=>{scope.signal.throwIfAborted();return rawStore[name](...args);},{signal:scope.signal}));
    try{return await until(physical,scope.signal);}finally{scope.dispose();}
  }])));
  async function handleRequest(request) {
    const scope=boundary(request.signal,timeoutMs);let results, batch=false;
    const respond=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    async function dispatch(){
      const allowed=await authorize(request);scope.signal.throwIfAborted();
      if(allowed!==true)throw fail('unauthorized','Unauthorized serverless request.',401);
      const url=new URL(request.url),prefix=`/v1/apps/${applicationId}`;
      if(!url.pathname.startsWith(prefix+'/'))throw fail('not_found','Unknown serverless route.',404);
      const rest=url.pathname.slice(prefix.length);
      if(rest==='/health'&&request.method==='GET')return {ok:true,applicationId,mode:'serverless-request-driven'};
      if(rest==='/query'&&(request.method==='POST'||request.method==='GET')){
        let payload;
        if(request.method==='POST')payload=await readJson(request,scope.signal,maxBodyBytes);
        else {
          const encoded=url.searchParams.get('input')??'null';
          if(new TextEncoder().encode(encoded).length>maxBodyBytes)throw fail('request_body_limit','Query input exceeds its bound.',413);
          try{payload={query:url.searchParams.get('query'),input:JSON.parse(encoded)};}catch{throw fail('invalid_json','Invalid query input.',400);}
        }
        if(typeof payload.query!=='string'||!payload.query.length||payload.query.length>128)throw fail('invalid_query','Supply a query name.',400);
        return active(scope.signal,({session})=>session.query(payload.query,payload.input??null));
      }
      if((rest==='/commands'||rest==='/commands/batch')&&request.method==='POST'){
        const body=await readJson(request,scope.signal,maxBodyBytes);batch=rest.endsWith('/batch');
        if(batch&&(!Array.isArray(body.commands)||body.commands.length>64))throw fail('invalid_batch','Supply 0..64 commands.',400);
        const commands=batch?body.commands.map(commandInput):[commandInput(body)];
        if(new Set(commands.map(item=>item.operationId)).size!==commands.length)throw fail('invalid_batch','Each batch operationId must be distinct.',400);
        results=commands.map(item=>({operationId:item.operationId,command:item.command,lifecycle:'not_submitted'}));
        await active(scope.signal,async({session},signal)=>{
          for(let index=0;index<commands.length;index++){
            signal.throwIfAborted();const item=commands[index];
            // From this boundary onward a failure may hide a retained command.
            results[index]={...results[index],lifecycle:'unknown'};
            try{
              const op=await session.command(item.command,item.input,{operationId:item.operationId,...(item.basedOn===undefined?{}:{basedOn:item.basedOn})});
              signal.throwIfAborted();
              const state=item.wait==='recorded'?await op.get():await op.applied({signal});
              results[index]={...results[index],lifecycle:lifecycle(state),[item.wait==='recorded'?'state':'applied']:state};
            }catch(error){
              if(['abandoned','needsReapply'].includes(error?.operation?.status))results[index]={...results[index],lifecycle:error.operation.status,state:error.operation};
              throw error;
            }
            if(!['applied','rejected','recorded'].includes(results[index].lifecycle))throw fail('operation_recovery_required','Inspect the original operation before deliberate recovery.',409);
          }
        });
        return batch?{results,complete:true}:results[0];
      }
      if(rest.startsWith('/operations/')&&request.method==='GET'){
        let operationId;try{operationId=decodeURIComponent(rest.slice('/operations/'.length));}catch{throw fail('invalid_operation','Invalid operation ID.',400);}
        if(!operationId||operationId.length>256)throw fail('invalid_operation','Invalid operation ID.',400);
        const state=await active(scope.signal,({session})=>session.operations.get(operationId));
        return {operationId,lifecycle:lifecycle(state),state};
      }
      throw fail('not_found','Unknown serverless route.',404);
    }
    try{return respond(await until(Promise.resolve().then(dispatch),scope.signal));}
    catch(error){
      const detail={error:errorInfo(error),...(error?.cleanupErrors?{cleanupErrors:error.cleanupErrors}:{})};
      if(results){
        const unknown=results.some(item=>item.lifecycle==='unknown');
        const status=unknown?202:results.some(item=>['abandoned','needsReapply'].includes(item.lifecycle))?409:Number.isInteger(error?.status)?error.status:500;
        return respond(batch?{...detail,results,complete:false}:{...results[0],...detail},status);
      }
      return respond(detail,Number.isInteger(error?.status)?error.status:scope.signal.aborted?504:500);
    }finally{scope.dispose();}
  }
  return Object.freeze({applicationId,store,withActiveSession:active,handleRequest});
}
