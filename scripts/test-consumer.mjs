// Verify that only public release artifacts are needed in a clean consumer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CORE_RELEASE } from '../contract/index.mjs';
const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(root, '.consumer-'));
const run = (command, args) => execFileSync(command, args, {cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000});
try {
  writeFileSync(join(directory, 'package.json'), JSON.stringify({private: true, type: 'module'}));
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', ...['sdk', 'runtime'].map(name => join(root, 'dist', `tendriller-${name}-${CORE_RELEASE}.tgz`))]);
  const core = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/core/package.json')));
  const runtime = JSON.parse(readFileSync(join(directory, 'node_modules/@tendriller/runtime/package.json')));
  assert.equal(core.dependencies, undefined); assert.equal(runtime.dependencies, undefined);
  writeFileSync(join(directory, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createClient, requireService } from '@tendriller/core';
import { CONTRACT_VERSION, assertValid, STREAM_LIMITS } from '@tendriller/core/contract';
import schema from '@tendriller/core/schema' with {type: 'json'};
import manifest from '@tendriller/runtime/manifest' with {type: 'json'};
import {applyOps, validateOps, historyPage} from '@tendriller/runtime/preview-support';
assert.equal(CONTRACT_VERSION, 3); assert.equal(schema.$defs.decision, undefined);
assert.ok(manifest.assets.some(file => file.path === 'tendril.js'));
assert.ok(manifest.assets.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
assertValid('command', {cid:'event-1',expected_generations:{},data:{type:'job.status',session:'application data'}});
assert.deepEqual(applyOps({}, validateOps([{op:'set',path:['experiment'],value:{session_id:'opaque'}}])), {experiment:{session_id:'opaque'}});
assert.equal(historyPage([{seq:1}], {after:0,limit:2,latest:1,earliest:1}).cursor, 1);
assert.equal(STREAM_LIMITS.record_bytes, 65536);
assert.throws(() => requireService({contract:1,workflows:[]}), /contract/);
const client = createClient({api:'https://example.test/api/t/test',token:'private'}, {fetch: async () => new Response(JSON.stringify({events:[],cursor:2,withheld:0}))});
assert.equal((await client.readEvents({after:2})).cursor, 2);
assert.equal(client.createDecision, undefined);
`);
  run(process.execPath, ['consumer.mjs']);
  writeFileSync(join(directory, 'consumer.mts'), `
import {createClient, type CommandMetadata} from '@tendriller/core';
import {type RuntimeApi, type SendResult} from '@tendriller/core/contract';
import {type WorkflowModule} from '@tendriller/core/host';
import {createFixtureTransport} from '@tendriller/runtime/preview';
import type {} from '@tendriller/core/browser';
const command: CommandMetadata = {cid:'durable-command',expected_generations:{}};
const client = createClient({api:'https://example.test',token:'private'});
void client.updateState({...command,ops:[{op:'set',path:['job'],value:{status:'ready'}}]});
// @ts-expect-error all commands need explicit stable IDs and preconditions
void client.updateState({ops:[]});
declare const page: RuntimeApi<{count:number}>;
const result: SendResult = await page.send({session:'opaque'});
if(result.status==='accepted'){const seq:number=result.seq; void seq;}
// @ts-expect-error queued is not accepted
if(result.status==='queued') result.seq;
declare const module: WorkflowModule;
void module;
const fixture = createFixtureTransport();
fixture.onSend((frame,reply) => { if(frame.t==='hello') reply({t:'welcome'}); });
`);
  run(process.execPath, [join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--skipLibCheck','--target','es2022','--module','nodenext','--moduleResolution','nodenext','--lib','es2023,dom','consumer.mts']);
  console.log('Independent SDK/runtime consumer passed with no source checkout dependencies.');
} catch(error) {
  if(error.stdout) process.stderr.write(error.stdout);
  if(error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {rmSync(directory,{recursive:true,force:true});}
