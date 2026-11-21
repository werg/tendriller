import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPersistentOutbox} from '../../session/outbox.mjs';

test('full outbox preserves unresolved operations and reclaims only terminal entries', async t => {
  const root=await mkdtemp(join(tmpdir(),'outbox-retention-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const entries=Array.from({length:512},(_,i)=>({operationId:`op-${i}`,status:'recorded'}));
  await writeFile(join(root,'outbox.json'),JSON.stringify({version:1,entries}),{mode:0o600});
  const box=await createPersistentOutbox(root);
  const next={operationId:'new',appId:'app',deviceId:'device',command:'add',input:null};
  await assert.rejects(box.record(next),{code:'OUTBOX_FULL'});
  assert.equal((await box.get('op-0')).status,'recorded');
  await box.mark('op-7','rejected');
  await box.record(next);
  assert.equal((await box.list()).length,512);
  assert.equal(await box.get('op-7'),null);
  assert.ok(await box.get('op-0'));
  await assert.rejects(box.record({...next,deviceId:'another'}),{code:'OUTBOX_OPERATION_CONFLICT'});
});

test('unrecognized outbox is preserved rather than replaced with an empty history', async t => {
  const root=await mkdtemp(join(tmpdir(),'outbox-invalid-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const original=JSON.stringify({version:2,entries:[]});
  await writeFile(join(root,'outbox.json'),original,{mode:0o600});
  const box=await createPersistentOutbox(root);
  await assert.rejects(box.record({operationId:'new',command:'add',input:null}),{code:'OUTBOX_INVALID'});
  assert.equal(await readFile(join(root,'outbox.json'),'utf8'),original);
});
