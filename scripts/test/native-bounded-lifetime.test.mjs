import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectOrStartNativeSession} from '../../session/native.mjs';

test('bounded detach and close share one owned cleanup',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'native-bounded-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let closes=0;
  const owned=await connectOrStartNativeSession({directory,bounded:true,openOwner:async()=>({session:{},close:async()=>{closes++;}})});
  await Promise.all([owned.detach(),owned.close(),owned.close()]);assert.equal(closes,1);
});

test('cancelled bounded opening disposes a late owner and does not return it',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'native-cancel-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const signal=new AbortController();let closes=0;
  await assert.rejects(connectOrStartNativeSession({directory,bounded:true,signal:signal.signal,openOwner:async()=>{
    signal.abort();return{session:{},close:async()=>{closes++;}};
  }}),{name:'AbortError'});
  assert.equal(closes,1);
});
