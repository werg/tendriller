import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentConvergence} from '../deployment-convergence.mjs';

test('a rolling old Worker is not accepted, but propagation can finish within a bounded deploy check', async () => {
 let calls=0;const waits=[];
 const value=await deploymentConvergence(async()=>{if(++calls<4)throw Error('old source');return{source:'qualified'};},{wait:async ms=>waits.push(ms)});
 assert.deepEqual(value,{source:'qualified'});assert.equal(calls,4);assert.deepEqual(waits,[2000,2000,2000]);
});
test('persistent identity mismatch fails closed after its exact attempt budget', async () => {
 let calls=0,waits=0;
 await assert.rejects(deploymentConvergence(async()=>{calls++;throw Error('wrong composition');},{attempts:3,wait:async()=>{waits++;}}),/wrong composition/);
 assert.equal(calls,3);assert.equal(waits,2);
});
test('a matching identity performs no extra probes or timers',async()=>{
 let calls=0;const value=await deploymentConvergence(async()=>{calls++;return'qualified';},{wait:()=>{throw Error('unexpected wait');}});
 assert.equal(value,'qualified');assert.equal(calls,1);
});
