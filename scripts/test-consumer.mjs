// Verify that only public release artifacts are needed in a clean consumer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CORE_RELEASE } from '../contract/index.mjs';
const root = resolve(import.meta.dirname, '..');
// A sibling of the source tree cannot silently resolve undeclared dependencies
// through the checkout's node_modules. All consumer inputs are packed artifacts.
const directory = mkdtempSync(join(tmpdir(), 'tendriller-consumer-'));
const run = (command, args) => execFileSync(command, args, {cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000});
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({private: true, type: 'module'}));
  // Include the engine's declared type dependency as an exact local archive so
  // this check needs no registry access, even with an empty npm cache.
  const workersTypes = JSON.parse(readFileSync(join(root, 'node_modules/@cloudflare/workers-types/package.json')));
  const [typesArchive] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--offline', '--json',
    '--cache', join(directory, 'npm-cache'), '--pack-destination', directory, join(root, 'node_modules/@cloudflare/workers-types')]));
  run('npm', ['install', '--ignore-scripts', '--offline', '--omit=dev', '--no-audit', '--no-fund',
    '--cache', join(directory, 'npm-cache'), join(directory, typesArchive.filename),
    ...['sdk', 'runtime', 'engine'].map(name => join(root, 'dist', `tendriller-${name}-${CORE_RELEASE}.tgz`))]);
  const core = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/core/package.json')));
  const runtime = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/runtime/package.json')));
  const engine = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/engine/package.json')));
  assert.equal(core.dependencies, undefined); assert.equal(runtime.dependencies, undefined);
  assert.deepEqual(engine.dependencies, { '@cloudflare/workers-types': workersTypes.version });
  assert.deepEqual(engine.peerDependencies, { '@tendriller/core': CORE_RELEASE });
  writeFileSync(join(directory, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { createClient, requireService } from '@tendriller/core';
import { CONTRACT_VERSION, assertValid, STREAM_LIMITS } from '@tendriller/core/contract';
import { RECORD_LOG_FORMAT, recordGenesisRoot, recordEntryRoot, recordId, encodeRecord, verifyRecordEntry } from '@tendriller/core/records';
import schema from '@tendriller/core/schema' with {type: 'json'};
import manifest from '@tendriller/runtime/manifest' with {type: 'json'};
import {applyOps, validateOps, validateStateChecks, checkState, historyPage} from '@tendriller/runtime/preview-support';
assert.equal(CONTRACT_VERSION, 3); assert.equal(schema.$defs.decision, undefined);
assert.equal(schema.$defs.uploadStart.properties.cid.type, 'string');
assert.equal(schema.$defs.publicationWrite.properties.expected_head_revision.type, 'integer');
assert.ok(manifest.assets.some(file => file.path === 'tendril.js'));
assert.ok(manifest.assets.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
assertValid('command', {cid:'event-1',expected_generations:{},data:{type:'job.status',session:'application data'}});
assert.deepEqual(applyOps({}, validateOps([{op:'set',path:['experiment'],value:{session_id:'opaque'}}])), {experiment:{session_id:'opaque'}});
const conditional = {cid:'claim',expected_generations:{},conditions:[{path:['claim'],exists:false}],ops:[{op:'set',path:['claim'],value:'a'}]};
assertValid('stateUpdate', conditional);
checkState({}, 0, validateStateChecks(conditional));
assert.throws(() => checkState({claim:'b'}, 1, validateStateChecks(conditional)), {code:'state_conflict'});
assert.equal(historyPage([{seq:1}], {after:0,limit:2,latest:1,earliest:1}).cursor, 1);
assert.equal(STREAM_LIMITS.record_bytes, 65536);
assert.throws(() => requireService({contract:2,workflows:[]}), /contract/);
const client = createClient({api:'https://example.test/api/t/test',token:'private'}, {fetch: async () => new Response(JSON.stringify({events:[],cursor:2,withheld:0}))});
assert.equal((await client.readEvents({after:2})).cursor, 2);
assert.equal(client.createDecision, undefined);
assert.equal(typeof client.records.read, 'function');
assert.equal(RECORD_LOG_FORMAT, 'record-log/v1');
const historyId = 'h_' + '1'.repeat(32), recordBytes = new Uint8Array([0,255,17]);
const previousRoot = await recordGenesisRoot(historyId), id = await recordId(recordBytes);
const entry = {historyId,position:1,recordId:id,previousRoot,root:await recordEntryRoot(historyId,1,previousRoot,id),record:encodeRecord(recordBytes)};
assert.deepEqual(await verifyRecordEntry(entry, {historyId,position:0,root:previousRoot,bytes:0}),recordBytes);
assert.match(readFileSync(new URL(import.meta.resolve('@tendriller/engine/accounts-schema')), 'utf8'), /CREATE TABLE accounts/);
`);
  run(process.execPath, ['consumer.mjs']);
  writeFileSync(join(directory, 'consumer.mts'), `
import {createClient, type CommandMetadata} from '@tendriller/core';
import {type RuntimeApi, type SendResult, type WireContracts, type SensorStatus} from '@tendriller/core/contract';
import {type WorkflowModule} from '@tendriller/core/host';
import {type RecordLogClient, type RecordLogHead} from '@tendriller/core/records';
import {createFixtureTransport} from '@tendriller/runtime/preview';
import type {} from '@tendriller/core/browser';
const command: CommandMetadata = {cid:'durable-command',expected_generations:{}};
const client = createClient({api:'https://example.test',token:'private'});
void client.updateState({...command,ops:[{op:'set',path:['job'],value:{status:'ready'}}]});
void client.updateState({...command,conditions:[{path:['job'],exists:false}],expected_revision:0,ops:[]});
// @ts-expect-error all commands need explicit stable IDs and preconditions
void client.updateState({ops:[]});
declare const page: RuntimeApi<{count:number}>;
const log: RecordLogClient = page.records;
declare const recordHead: RecordLogHead;
void log.read({historyId:recordHead.historyId,after:recordHead.position,previous:recordHead});
const sensors: SensorStatus = page.sensors.status();
page.sensors.on(status => { const pending: SensorStatus['pending'] = status.pending; void pending; });
page.on('sensors', status => { const active: SensorStatus['active'] = status.active; void active; });
void sensors;
void page.state.apply([{op:'set',path:['count'],value:1}],{conditions:[{path:['count'],equals:0}]});
const snapshot = await page.state.snapshot();
const count:number = snapshot.state.count;
void page.state.apply([{op:'set',path:['count'],value:count+1}],{expected_revision:snapshot.rev});
// @ts-expect-error a state condition has one predicate, never both.
void page.state.apply([],{conditions:[{path:['count'],equals:0,exists:true}]});
const stateResult = await page.state.apply([]);
if (stateResult.status === 'accepted' || stateResult.status === 'queued') { const cid:string = stateResult.cid; void cid; }
// @ts-expect-error unchanged work has no durable command identity.
if (stateResult.status === 'unchanged') stateResult.cid;
for (const command of page.state.pending()) { const keys:string[] = command.ops[0].path; void keys; }
page.on('state_queue', commands => { const pending:string|undefined = commands[0]?.cid; void pending; });
page.on('state_result', receipt => { const keys:string[] = receipt.ops[0].path; void keys; });
const result: SendResult = await page.send({session:'opaque'});
if(result.status==='accepted'){const seq:number=result.seq; void seq;}
// @ts-expect-error queued is not accepted
if(result.status==='queued') result.seq;
declare const module: WorkflowModule;
void module;
const json: WireContracts['streamJson'] = {readings:[1, null, {valid:true}]};
// @ts-expect-error nested stream data must remain JSON rather than any
const invalidJson: WireContracts['streamJson'] = {readings:[() => 1]};
void [json, invalidJson];
const fixture = createFixtureTransport();
fixture.onSend((frame,reply) => { if(frame.t==='hello') reply({t:'welcome'}); });
`);
  writeFileSync(join(directory, 'worker.mts'), `
import worker, {Admission, Tendril, configureWorkflows} from '@tendriller/engine';
import type {WorkflowModule} from '@tendriller/core/host';
import {initializeTestService} from '@tendriller/engine/testing';
const capability: WorkflowModule = {
  id:'review', interfaceVersion:'1', schemaVersion:'1', implementationVersion:'fixture',
  operations:{ submit:{ access:'participant', mutate:true, run(host, data) {
    host.records.put('private', host.identity.actor, data);
    host.afterCommit(() => host.notify('changed', 'owner'));
    return {accepted:true};
  } } },
};
configureWorkflows([capability]);
// @ts-expect-error trusted extensions must provide their complete public contract
configureWorkflows([{id:'incomplete'}]);
void initializeTestService([{name:'empty.sql',queries:[]}]);
export {Admission, Tendril};
export default {
  fetch(request, env, context) { return worker.fetch(request, env, context); },
  scheduled(event, env, context) { return worker.scheduled(event, env, context); },
} satisfies typeof worker;
`);
  run(process.execPath, [join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--target','es2022','--module','nodenext','--moduleResolution','nodenext','--lib','es2023,dom','consumer.mts','worker.mts']);
  console.log('Independent SDK/runtime/engine consumer passed with strict declarations and no source checkout dependencies.');
} catch(error) {
  if(error.stdout) process.stderr.write(error.stdout);
  if(error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {rmSync(directory,{recursive:true,force:true});}
