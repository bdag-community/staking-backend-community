import test from 'node:test';
import assert from 'node:assert/strict';
import { mapBounded } from '../src/indexing/bounded-reads';
test('header collection keeps at most four RPC reads active and returns block order',async()=>{
 let active=0,peak=0;const input=Array.from({length:20},(_,i)=>i);
 const values=await mapBounded(input,4,async n=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,(n%3)+1));active--;return n*2;});
 assert.equal(peak,4);assert.deepEqual(values,input.map(n=>n*2));
});
test('bounded reads propagate failure and reject invalid concurrency',async()=>{
 await assert.rejects(mapBounded([1],0,async n=>n),/concurrency/);
 await assert.rejects(mapBounded([1,2],1,async n=>{if(n===2)throw new Error('RPC failed');return n;}),/RPC failed/);
});
