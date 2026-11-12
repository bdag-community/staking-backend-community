import test from 'node:test';import assert from 'node:assert/strict';
import { createRpcPacer } from '../src/services/rpc-pacing';
test('concurrent providers share orderly request starts without dropping calls',async()=>{
 let now=0;const waits:number[]=[];
 const pace=createRpcPacer(150,()=>now,async(ms)=>{waits.push(ms);now+=ms});
 await Promise.all([pace(),pace(),pace(),pace()]);
 assert.deepEqual(waits,[150,150,150]);
 assert.throws(()=>createRpcPacer(-1),/interval/);
});
