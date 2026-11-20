import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { nativeReady, quietBoundary } from '../idle-soak/warmup.mjs';

test('native startup requires its actual ready message, not process spawn or coverage', async () => {
 const child = new EventEmitter(); let ready = false;
 const waiting = nativeReady(child).then(() => { ready = true; });
 child.emit('message', {idleSoakCoverage:1}); await Promise.resolve(); assert.equal(ready,false);
 child.emit('message', {idleSoakReady:1}); await waiting; assert.equal(ready,true); assert.equal(child.listenerCount('message'),0);
});
test('native exit and cancellation cannot start a quiet phase', async () => {
 const child = new EventEmitter(), waiting = nativeReady(child); child.emit('exit',1);
 await assert.rejects(waiting,/NOT_READY/);
 const stop = new AbortController(), interrupted = nativeReady(child,{signal:stop.signal});stop.abort();await assert.rejects(interrupted,/INTERRUPTED/);
});
test('boundary activity resets only the active warmup timer; idle time starts afterwards', async t => {
 t.mock.timers.enable({apis:['setTimeout']}); const b=quietBoundary();let ready=false;
 const waiting=b.wait().then(()=>{ready=true;});t.mock.timers.tick(1900);b.activity();t.mock.timers.tick(1900);await Promise.resolve();assert.equal(ready,false);
 t.mock.timers.tick(100);await waiting;assert.equal(ready,true);b.activity();t.mock.timers.tick(48*3600000);assert.equal(ready,true);
});
test('continuous boundary traffic reaches its deadline instead of being hidden as warmup', async t => {
 t.mock.timers.enable({apis:['setTimeout']}); const b=quietBoundary({timeoutMs:3000}); const waiting=b.wait();
 t.mock.timers.tick(1500);b.activity();t.mock.timers.tick(1500);await assert.rejects(waiting,/DEADLINE/);
});
