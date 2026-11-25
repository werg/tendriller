import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardSessionEvents } from '@chronolog/peer-session';
import { createAssistantEventDelivery } from '../../contract/assistant.mjs';
import { p, createPhysicalSession } from '../../collaboration/test/physical-fixture.mjs';

test('the assistant forwarder retries exact provisional delivery and skips only an explicitly declined projection', { timeout: 10_000 }, async () => {
  const definition=p.defineApplication({id:'assistant-forwarding',version:'1',commands:{
    say:p.defineCommand({description:'Emit an authored test event',input:{type:'string'},prepare:id=>p.program(p.emit('test',{id}))}),
  },queries:{}});
  const session=await createPhysicalSession({definition}), stop=new AbortController();
  const deliveries=[],skipped=[],checkpoints=[];let released=0;
  try {
    for(const name of ['first','declined','last'])await(await session.command('say',name,{operationId:name})).materialized();
    const captured=await session.readView(), events=captured.readEvents({topics:['test']}).events;await captured.release();
    const source={applicationId:session.applicationId,signal:session.signal,operations:session.operations,
      changes:options=>session.changes(options),onStatus:listener=>session.onStatus(listener),
      async readView(options){const view=await session.readView(options);return{...view,async release(){released++;await view.release();}};}};
    const assistant={async waitUntilOnline(){},async publish(event){
      deliveries.push(event);
      if(deliveries.length===1)throw Object.assign(Error('Alarm write failed'),{code:'application_event_unavailable'});
      if(event.name==='declined')throw Object.assign(Error('Owner declined'),{code:'event_not_approved'});
    }};
    const reason=Error('Completed this bounded forwarding observation');
    const running=forwardSessionEvents({session:source,topics:['test'],signal:stop.signal,
      checkpoint:{load:()=>undefined,save(state){checkpoints.push(state);const ledger=JSON.parse(state);if(Object.keys(ledger.entries).length===3&&Object.values(ledger.entries).every(entry=>entry.acknowledged))setImmediate(()=>stop.abort(reason));}},
      deliver:createAssistantEventDelivery({assistant,onSkipped:event=>skipped.push(event)}),
      project:event=>({name:event.payload.id,payload:{value:event.payload.id}}),
    });
    await assert.rejects(running,error=>error===reason);
    assert.equal(released,1);
    assert.deepEqual(deliveries.map(event=>event.sourceEventId),[events[0].id,events[0].id,events[1].id,events[2].id]);
    assert.deepEqual(deliveries[0],deliveries[1],'An uncertain external reply retries the same revision/facts/identity');
    assert.deepEqual(skipped,[{name:'declined',sourceEventId:events[1].id}]);
    const ledger=JSON.parse(checkpoints.at(-1));assert.equal(ledger.format,'authored-event-outbox-v1');
    assert.deepEqual(Object.keys(ledger.entries).sort(),events.map(event=>event.id).sort());
    assert(Object.values(ledger.entries).every(entry=>entry.acknowledged));
    for(const delivery of deliveries){assert.equal(delivery.change,'upsert');assert.equal(delivery.observation.stored,true);assert.equal(delivery.observation.materialized.outcome,'accepted');assert.equal(delivery.observation.finalized,false);}
  } finally {stop.abort();await session.close();}
});
