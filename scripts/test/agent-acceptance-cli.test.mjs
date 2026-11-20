import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { control, observeInController, prerequisiteFailure } from '../agent-acceptance/cli.mjs';
import { externalReport, innocentPrompt, Evidence } from '../agent-acceptance/evidence.mjs';

test('omitted owner-access record names the exact missing prerequisite without publishing a private path', () => {
  const failure = prerequisiteFailure({ code: 'ENOENT', path: '/private/owner.json' }, { access: '/private/owner.json' }, 'preflight-or-owner');
  assert.equal(failure.prerequisiteCode, 'owner_access_missing'); assert.match(failure.nextAction, /No model turn or application/);
  assert(!JSON.stringify(failure).includes('/private/'));
  assert.equal(prerequisiteFailure({ code: 'ENOENT', path: '/other/file' }, { access: '/private/owner.json' }, 'preflight-or-owner').prerequisiteCode, 'see-private-failure-record');
});

test('bounded CLI subprocess starts isolated app-server thread, reports model, and cleans copied auth without invoking a model', t => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-cli-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'), auth = join(directory, 'auth'), output = join(directory, 'run');
  mkdirSync(bin); mkdirSync(auth);
  writeFileSync(join(auth, 'auth.json'), '{"fixture":"PRIVATE_MODEL_AUTH"}', { mode: 0o600 });
  writeFileSync(join(auth, 'config.toml'), 'developer_instructions="MAINTAINER_HINT"');
  writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node
const {createInterface}=require('node:readline'),fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-fixture 1');process.exit(0)}
const record={argv:process.argv,env:{HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,secret:process.env.PRIVATE_REVIEW_SECRET},calls:[],files:fs.readdirSync(process.cwd())};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);record.calls.push(m);fs.writeFileSync(process.env.HOME+'/fixture.json',JSON.stringify(record));
 if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='thread/start'?{thread:{id:'fresh'},model:'fixture-model',modelProvider:'fixture',instructionSources:[]}: {}})+'\\n');
});`, { mode: 0o700 });
  execFileSync(process.execPath, [resolve(import.meta.dirname, '../agent-acceptance/cli.mjs'), 'protocol-smoke', '--output', output, '--seconds', '5'],
    { timeout: 15000, env: { ...process.env, CODEX_HOME: auth, PATH: bin + ':' + process.env.PATH, PRIVATE_REVIEW_SECRET: 'NEVER_INHERIT' }, stdio: 'pipe' });
  const report = JSON.parse(readFileSync(join(output, 'report.json'))), captured = JSON.parse(readFileSync(join(output, 'home/fixture.json')));
  assert.equal(report.environment.model, 'fixture-model'); assert.equal(report.outcome, 'blocked');
  assert.equal(report.cleanup.appServerStopped, true); assert.equal(report.chatgptWeb.status, 'not-tested');
  assert.equal(captured.env.CODEX_HOME, join(output, 'home/.codex')); assert.equal(captured.env.secret, undefined);
  assert.deepEqual(captured.files, []);
  for (const flag of ['features.apps=false', 'features.plugins=false', 'features.remote_plugin=false', 'features.skip_host_skill_discovery=true', 'features.skill_search=false']) assert(captured.argv.includes(flag));
  assert(!captured.calls.some(call => call.method === 'turn/start'));
  assert.equal(captured.calls.find(call => call.method === 'thread/start').params.ephemeral, true);
  assert(!existsSync(join(output, 'home/.codex/config.toml'))); assert(!existsSync(join(output, 'home/.codex/auth.json')));
  assert(!JSON.stringify(report).includes('PRIVATE_MODEL_AUTH'));
});

test('filesystem-private controller uses the actual request protocol', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-control-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const socket = join(directory, 'control.sock'), requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body)); res.end(JSON.stringify({ busy: false }));
  });
  await new Promise(resolve => server.listen(socket, resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(join(directory, 'controller.json'), JSON.stringify({ socket }));
  assert.deepEqual(await control(directory, { action: 'status' }), { busy: false });
  assert.deepEqual(requests, [{ action: 'status' }]);
});

test('external ChatGPT observations remain separate attestation with omissions blocked', t => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-external-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const envelope = { protocol: 'tendriller-external-host-v1', host: 'chatgpt-web', mode: 'domain', origin: 'https://selected.example',
    environment: { browser: 'External browser', private: 'PRIVATE_ENVIRONMENT' }, initialPrompt: innocentPrompt('https://selected.example', 'domain'),
    sessionEvidence: { reference: 'PRIVATE_SESSION' }, interventions: [], observations: [] };
  const evidence = externalReport(directory, envelope);
  assert.equal(evidence.data.chatgptWeb.status, 'external-attested'); assert.equal(evidence.data.outcome, 'blocked');
  assert(!readFileSync(join(directory, 'report.json'), 'utf8').includes('PRIVATE_'));
  assert.throws(() => externalReport(directory, { ...envelope, sessionEvidence: null }), /actual session evidence/);
});

test('observe IPC and subsequent model updates share the controller Evidence without filesystem merging', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-writer-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const evidence = new Evidence(directory, {}), socket = join(directory, 'control.sock');
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (input.action === 'observe') {
      res.end(JSON.stringify(await observeInController({ evidence, input: input.input, source: 'test-observer', observe: async request => ({
        protocol: 'tendriller-agent-observation-v1', check: request.check, observedAt: new Date().toISOString(), status: 'passed', evidence: { urls: ['measured-fixture'] },
      }) })));
    } else if (input.action === 'model-update') {
      evidence.data.lastTurn = { status: 'completed' }; evidence.save(); res.end('{}');
    } else res.end(JSON.stringify({ report: evidence.data }));
  });
  await new Promise(resolve => server.listen(socket, resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(join(directory, 'controller.json'), JSON.stringify({ socket }));
  assert.equal((await control(directory, { action: 'observe', input: { check: 'discovery' } })).status, 'passed');
  await control(directory, { action: 'model-update' });
  const status = await control(directory, { action: 'status' }), report = JSON.parse(readFileSync(join(directory, 'report.json')));
  assert.equal(status.report.checks.discovery.status, 'passed'); assert.equal(report.checks.discovery.status, 'passed');
  assert.equal(report.lastTurn.status, 'completed'); assert.equal(report.observations.length, 1);
  assert.equal(readFileSync(join(directory, 'observations.jsonl'), 'utf8').trim().split('\n').length, 1);
  for (const check of Object.values(evidence.data.checks)) check.status = 'passed';
  evidence.data.deadlineReached = true; evidence.finish(); assert.notEqual(evidence.data.outcome, 'complete');
});
