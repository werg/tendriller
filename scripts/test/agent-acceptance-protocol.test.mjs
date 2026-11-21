import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppServer, observable, observableTracker } from '../agent-acceptance/protocol.mjs';
import { Evidence, checks, innocentPrompt, privateDirectory } from '../agent-acceptance/evidence.mjs';
import { adapterCall } from '../agent-acceptance/adapter.mjs';

const fixture = `import {createInterface} from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!m.method||m.id===undefined)return;
 if(m.method==='hang')return;
 if(m.method==='die'){process.exit(1);return;}
 if(m.method==='bad'){send({id:m.id,error:{message:'PRIVATE_CREDENTIAL'}});return;}
 if(m.method==='turn/start'){
   send({id:999,method:'item/commandExecution/requestApproval',params:{}});
   send({method:'item/completed',params:{item:{type:'reasoning',summary:['SECRET_THOUGHT']}}});
   send({method:'item/reasoning/summaryTextDelta',params:{delta:'SECRET_THOUGHT'}});
   send({method:'item/completed',params:{item:{id:'msg',type:'agentMessage',text:'Ready page'}}});
   send({method:'item/started',params:{item:{id:'cmd',type:'commandExecution',private:'PRIVATE_START_PAYLOAD'}}});
   send({method:'item/completed',params:{item:{id:'cmd',type:'commandExecution',command:'echo ready',aggregatedOutput:'ready',exitCode:0}}});
   send({method:'turn/completed',params:{turn:{id:'turn',status:'completed',items:[{type:'reasoning',text:'SECRET_THOUGHT'}]}}});
 }
 send({id:m.id,result:m.method==='thread/start'?{thread:{id:'fresh'},model:'fixture'}:m.method==='turn/start'?{turn:{id:'turn'}}:{}});
});`;

test('real stdio child handles turns, server requests, reasoning exclusion, RPC errors, deadlines and exit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-protocol-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'host.mjs'); writeFileSync(path, fixture);
  const events = [], host = new AppServer({ cwd: directory, env: process.env, deadlineMs: 5000,
    spawnHost: (_cmd, _args, options) => spawn(process.execPath, [path], options), onEvent: e => events.push(e) });
  t.after(() => host.close());
  await host.initialize(); assert.equal((await host.rpc('thread/start')).thread.id, 'fresh');
  await host.rpc('turn/start');
  assert.deepEqual(events.map(e => e.event), ['item', 'item', 'turn']);
  assert(!JSON.stringify(events).includes('SECRET_THOUGHT'));
  assert(!JSON.stringify(events).includes('PRIVATE_START_PAYLOAD'));
  assert(Number.isFinite(Date.parse(events[1].startedAt))); assert(Number.isFinite(Date.parse(events[1].completedAt)));
  await assert.rejects(host.rpc('bad'), error => /RPC failed/.test(error.message) && !error.message.includes('PRIVATE_CREDENTIAL'));
  host.deadlineMs = 25;
  await assert.rejects(host.rpc('hang'), /deadline/);
  host.deadlineMs = 5000;
  await assert.rejects(host.rpc('die'), /exited/);
  await assert.rejects(host.rpc('anything'), /closed/);
});

test('notification allowlist rejects unknown items and never copies whole turn objects', () => {
  assert.equal(observable({ method: 'item/completed', params: { item: { type: 'reasoning' } } }), null);
  assert.equal(observable({ method: 'item/agentMessage/delta', params: { delta: 'partial' } }), null);
  const event = observable({ method: 'turn/completed', params: { turn: { id: 't', status: 'failed', secret: 'no' } } });
  assert.deepEqual(event, { event: 'turn', id: 't', status: 'failed' });
});

test('typed timing retains only ID/start time, never starts or reasoning payloads, and marks missing starts unknown', () => {
  let tick = 0; const track = observableTracker(() => new Date(++tick * 1000).toISOString());
  assert.equal(track({ method: 'item/started', params: { item: { id: 'reason', type: 'reasoning', text: 'SECRET' } } }), null);
  assert.equal(tick, 0);
  track({ method: 'item/started', params: { item: { id: 'mcp', type: 'mcpToolCall', arguments: { private: 'SECRET' } } } });
  track({ method: 'item/started', params: { item: { id: 'mcp', type: 'mcpToolCall' } } });
  const event = track({ method: 'item/completed', params: { item: { id: 'mcp', type: 'mcpToolCall', server: 'tendriller', tool: 'get_profile' } } });
  assert.equal(event.startedAt, new Date(1000).toISOString()); assert.equal(event.completedAt, new Date(2000).toISOString());
  assert(!JSON.stringify(event).includes('SECRET'));
  const missing = track({ method: 'item/completed', params: { item: { id: 'missing', type: 'commandExecution' } } });
  assert.equal(missing.startedAt, null);
});

test('initial prompts contain only domain and ordinary outcome, with separate source-free MCP prompt', () => {
  const domain = innocentPrompt('https://staging.example', 'domain'), mcp = innocentPrompt('https://staging.example', 'mcp');
  assert(domain.includes('https://staging.example')); assert(!mcp.includes('https://'));
  for (const text of [domain, mcp]) {
    assert(!/api\/|Chronolog|bootstrap|module|AGENTS|repository|publication|readiness|worker|MCP|architecture/i.test(text));
    assert(text.includes('checklist')); assert(text.includes('reload'));
  }
});

test('evidence is private, public summaries exclude raw content, advice marks assisted and omissions never pass', t => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-evidence-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const evidence = new Evidence(directory, { mode: 'domain' });
  evidence.intervention('identity', 'PRIVATE_IDENTITY');
  evidence.finish(); assert.equal(evidence.data.outcome, 'blocked');
  evidence.intervention('maintainer-advice', 'PRIVATE_IMPLEMENTATION_ADVICE');
  evidence.finish(); assert.equal(evidence.data.outcome, 'assisted');
  const report = readFileSync(join(directory, 'report.json'), 'utf8');
  assert(!report.includes('PRIVATE_')); assert.equal(statSync(join(directory, 'report.json')).mode & 0o777, 0o600);
  assert.throws(() => evidence.intervention('unknown', 'x'), /category/);
});

test('observation contracts reject fabricated retry, reopen, shared-read, preclaim and cleanup shortcuts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-contract-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const evidence = new Evidence(directory, {});
  const observation = (check, detail = {}) => ({ protocol: 'tendriller-agent-observation-v1', check, observedAt: new Date().toISOString(), status: 'passed', evidence: detail });
  for (const name of ['preclaim-publication', 'native-reopen', 'lost-command-response', 'lost-publication-response', 'connected', 'browser-to-agent', 'agent-to-browser', 'cleanup'])
    assert.throws(() => evidence.observation(observation(name), 'test'));
  const retry = { operationId: 'op', retryOperationId: 'changed', attemptHash: 'a'.repeat(64), retryAttemptHash: 'a'.repeat(64), responseLost: true, appliedCount: 1 };
  assert.throws(() => evidence.observation(observation('lost-command-response', retry), 'test'));
  retry.retryOperationId = 'op'; evidence.observation(observation('lost-command-response', retry), 'test');
  assert.equal(evidence.data.checks['lost-command-response'].status, 'passed');
  assert.throws(() => evidence.observation({ ...observation('discovery'), observedAt: 'nonsense' }, 'test'));
  assert.throws(() => evidence.observation(observation('not-a-check'), 'test'));
  assert.equal(evidence.data.chatgptWeb.status, 'not-tested');
  assert.equal(checks.length, 14);
});

test('private directory refuses existing dirs and any source-checkout descendant', t => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-private-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => privateDirectory(directory), /new private/);
  assert.throws(() => privateDirectory(join(import.meta.dirname, 'should-never-exist')), /outside source/);
  assert(!existsSync(join(import.meta.dirname, 'should-never-exist')));
  const created = privateDirectory(join(directory, 'new')); assert.equal(statSync(created).mode & 0o777, 0o700);
});

test('external adapter protocol is bounded, JSON-only, and suppresses diagnostics', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-adapter-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'observer.mjs');
  writeFileSync(path, `#!/usr/bin/env node\nlet x='';for await(const c of process.stdin)x+=c;console.log(JSON.stringify({received:JSON.parse(x).check}));`, { mode: 0o700 });
  assert.deepEqual(await adapterCall(path, { check: 'native-reopen' }), { received: 'native-reopen' });
  writeFileSync(path, '#!/usr/bin/env node\nconsole.error("PRIVATE_DIAGNOSTIC");process.exit(1);');
  await assert.rejects(adapterCall(path, {}), e => e.message === 'Observer adapter failed');
  writeFileSync(path, '#!/usr/bin/env node\nsetInterval(()=>{},1000);');
  await assert.rejects(adapterCall(path, {}, { timeoutMs: 40 }), /deadline/);
});
