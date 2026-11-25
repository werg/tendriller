import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { installReviewFixtureSources, REVIEW_FIXTURE_FILES } from '../review/fixture.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const proposalId = 'a'.repeat(64);
const notice = (approved, revision = 'first', id = proposalId) => ({ type: 'setup', version: 1, assistant: { proposalId: id, approved, revision: approved ? revision : null } });
async function fixture(t, { forwardingError, expectedProposalId = proposalId, legacyHooks = {} } = {}) {
  const root = resolve(import.meta.dirname, '../..'), project = mkdtempSync(join(tmpdir(), 'review-approval-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const files = installReviewFixtureSources(root, project);
  assert.equal(files.length, REVIEW_FIXTURE_FILES.length);
  assert.deepEqual(readFileSync(join(project,'support/participant-lifecycle.mjs')), readFileSync(join(root,'docs/tutorial/shared/participant-lifecycle.mjs')));
  const { superviseReviewAssistant, retainedReviewProposal } = await import(pathToFileURL(join(project,'review-assistant.mjs')).href);
  const native = new AbortController(), channel = Promise.withResolvers(), adapters = [], forwarded = [], reports = [];
  let callbacks;
  const lifecycle = superviseReviewAssistant({ session: { signal: native.signal }, expectedProposalId, ...legacyHooks,
    watch(value) { callbacks=value; return { closed:channel.promise,close(){channel.resolve();} }; },
    startAdapter({ signal,onStatus }) {
      const done=Promise.withResolvers(), adapter={signal,onStatus,done,closes:0}; adapters.push(adapter);
      return {closed:done.promise,waitUntilOnline:async()=>{},close(){adapter.closes++;done.resolve();}};
    },
    async onOnline(_assistant,signal) {
      forwarded.push(signal);
      if (forwardingError) throw Object.assign(Error('PRIVATE_FORWARD_ERROR'), {code:forwardingError});
      if (!signal.aborted) await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    },report:value=>reports.push(value),
  });
  t.after(()=>lifecycle.close());
  return {lifecycle,native,adapters,forwarded,reports,retainedReviewProposal,send:value=>callbacks.onChange(value)};
}
test('copied public reviewer starts zero adapter dials before exact approval, with independent native lifetime',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t);f.send(notice(false));await flush();t.mock.timers.tick(48*3600000);await flush();
  assert.equal(f.adapters.length,0);assert.equal(f.forwarded.length,0);assert.equal(f.native.signal.aborted,false);
  f.send(notice(true));await flush();await flush();assert.equal(f.adapters.length,1);assert.equal(f.forwarded.length,1);
  assert.equal(f.native.signal.aborted,false);
});
test('revocation aborts event forwarding, replacement cannot redial the same revision, and another proposal is ignored',async t=>{
  const f=await fixture(t);f.send(notice(false));await flush();f.send(notice(true));await flush();await flush();
  f.send(notice(false));await flush();await flush();assert(f.adapters[0].signal.aborted);assert(f.forwarded[0].aborted);
  f.send(notice(true,'second'));await flush();await flush();assert.equal(f.adapters.length,2);
  f.adapters[1].onStatus({state:'disconnected',reason:'participant_replaced'});await flush();await flush();
  assert(f.forwarded[1].aborted);f.send(notice(true,'second'));await flush();assert.equal(f.adapters.length,2);
  f.send(notice(true,'third','b'.repeat(64)));await flush();assert.equal(f.adapters.length,2);
  f.send(notice(true,'third'));await flush();await flush();assert.equal(f.adapters.length,3);
  assert.equal(f.native.signal.aborted,false);
});
test('event recovery review preserves the healthy MCP adapter and never silently resets or retries its cursor',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=await fixture(t,{forwardingError:'EVENT_FORWARDER_REVIEW_RECOVERY'});
  f.send(notice(true));await flush();await flush();
  assert.equal(f.adapters.length,1);assert.equal(f.adapters[0].closes,0);assert.equal(f.forwarded.length,1);
  assert(f.reports.some(x=>x.state==='event_forwarding_review_required'&&x.reason==='recovery'));
  assert(!JSON.stringify(f.reports).includes('PRIVATE_FORWARD_ERROR'));
  t.mock.timers.tick(48*3600000);await flush();assert.equal(f.adapters.length,1);assert.equal(f.forwarded.length,1);
  assert.equal(f.native.signal.aborted,false);
});

test('foreign first approval is never adopted and a retained proposal must match the actual adapter key',async t=>{
  const f=await fixture(t);f.send(notice(true,'foreign','b'.repeat(64)));await flush();await flush();
  assert.equal(f.adapters.length,0);f.send(notice(true));await flush();await flush();assert.equal(f.adapters.length,1);
  const key='PRIVATE_ADAPTER_KEY', record={proposed:proposalId,adapterHash:createHash('sha256').update(key).digest('hex')};
  assert.equal(f.retainedReviewProposal(record,key),proposalId);
  assert.equal(f.retainedReviewProposal(record,'DIFFERENT_PRIVATE_KEY'),undefined);
  assert.equal(f.retainedReviewProposal(null,key),undefined);
});
test('missing own proposal identity keeps MCP stopped while the native lifetime and consent watcher continue',async t=>{
  // Removed pairing hooks stay uncalled even if an old caller still passes them.
  const removed=name=>()=>{throw Error(name+' was removed');};
  const f=await fixture(t,{expectedProposalId:null,legacyHooks:{processPairings:removed('processPairings')}});
  f.send(notice(true));await flush();await flush();assert.equal(f.adapters.length,0);assert.equal(f.native.signal.aborted,false);
  assert(f.reports.some(x=>x.state==='assistant_proposal_identity_required'&&x.participantRunning));
  assert(!f.reports.some(x=>x.pairing||x.state==='pairing_unavailable'));
});
