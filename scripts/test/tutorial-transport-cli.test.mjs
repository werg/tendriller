import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),root=new URL('../../',import.meta.url);
for(const variant of ['events','sql'])for(const command of ['status','diagnostics'])test(`${variant} CLI ${command} takes one local sample and detaches without opening or closing an owner`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'transport-cli-'));
 try{
  const folder=variant==='sql'?join(directory,'sql'):directory;await mkdir(folder,{recursive:true});await mkdir(join(directory,'helpers'));
  await copyFile(new URL(`docs/tutorial/${variant==='sql'?'sql/':''}session.mjs`,root),join(folder,'session.mjs'));
  await copyFile(new URL('docs/tutorial/helpers/cli-lifetime.mjs',root),join(directory,'helpers/cli-lifetime.mjs'));
  await writeFile(join(folder,'domain.mjs'),"export const definition={id:'fixture',version:'1'};");
  await writeFile(join(folder,'local.mjs'),`export const privateDirectory=new URL('./p/',import.meta.url),devicePath='unused',databasePath='unused';export async function readPrivate(name){return name==='handle.json'?{application:{id:'a'.repeat(64)}}:{token:'local-fixture'};}export async function readHostHandle(){return{application:{id:'a'.repeat(64)}};}export function project(){throw Error('MUST_NOT_OPEN_HOST');}export function savePrivate(){throw Error('MUST_NOT_WRITE_PROFILE');}`);
  if(variant==='sql')await writeFile(join(folder,'engine.mjs'),"export function createNativeEngine(){throw Error('MUST_NOT_OPEN_SQL');}");
  else{
   await writeFile(join(folder,'pairing-native.mjs'),"export function createReviewedPairingProcessor(){throw Error('MUST_NOT_PAIR');}");
   await writeFile(join(directory,'helpers/participant-lifecycle.mjs'),"export function superviseParticipant(){throw Error('MUST_NOT_OWN');}");
  }
  const marker=join(directory,'result.json');
  await writeFile(join(directory,'stub.mjs'),`import{writeFileSync}from'node:fs';const counts={attached:0,detached:0,reads:0,listeners:0};export async function attachNativeSession(options){counts.attached++;counts.profile=options.directory.split('owner-').at(-1);return{session:{participation:{status:{phase:'connected',connectedPeers:['b'.repeat(64)],connectionRevision:0},onStatus(fn){counts.listeners++;fn(this.status);return()=>counts.listeners--;},async diagnostics(){counts.reads++;return[{peerId:'b'.repeat(64),kind:'direct',sentBytes:42,receivedBytes:12}];}}},async detach(){counts.detached++;writeFileSync(${JSON.stringify(marker)},JSON.stringify(counts));}};}const forbidden=()=>{throw Error('MUST_NOT_OWN_OR_NETWORK');};export{forbidden as createNativeSessionSupervisor,forbidden as createNativeAttachmentKey,forbidden as participateNativeApplication,forbidden as createDevicePairingClient,forbidden as watchApplicationSetup,forbidden as verifyAuthorityBundle,forbidden as signTransitionRequest,forbidden as openNativeApplication,forbidden as openNativeDevice,forbidden as connectApplicationOwner,forbidden as createApplicationOwner,forbidden as openSqlApplication};`);
  const helper=pathToFileURL(new URL('collaboration/transport-diagnostics.mjs',root).pathname).href;
  await writeFile(join(directory,'preload.mjs'),`import{registerHooks}from'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='@tendriller/core/collaboration/transport-diagnostics')return{url:${JSON.stringify(helper)},shortCircuit:true};if(specifier.startsWith('@tendriller/')||specifier.startsWith('@chronolog/'))return{url:new URL('./stub.mjs',import.meta.url).href,shortCircuit:true};return next(specifier,context);}});`);
  const profile=command==='status'?'retained':'main';
  const {stdout}=await run(process.execPath,['--import',join(directory,'preload.mjs'),join(folder,'session.mjs'),command,profile],{timeout:5000});
  const report=JSON.parse(stdout);assert.equal(report.connections[0].kind,'direct');assert.equal(report.connections[0].sentBytes,42);assert.equal(stdout.includes('b'.repeat(64)),false);
  assert.deepEqual(JSON.parse(await readFile(marker,'utf8')),{attached:1,detached:1,reads:1,listeners:0,profile});
 }finally{await rm(directory,{recursive:true,force:true});}
});
