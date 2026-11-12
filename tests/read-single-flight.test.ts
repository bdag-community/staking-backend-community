import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadSingleFlight } from '../src/services/read-single-flight';

test('duplicate wallet reads join the same in-flight work and completed data is never cached',async()=>{
 const run=createReadSingleFlight<number>(2);let calls=0;let complete:(value:number)=>void=()=>{};
 const operation=()=>{calls++;return new Promise<number>(resolve=>{complete=resolve;});};
 const first=run('wallet-a',operation),duplicate=run('wallet-a',operation);
 assert.equal(first,duplicate);await Promise.resolve();assert.equal(calls,1);
 complete(1);assert.equal(await first,1);
 assert.equal(await run('wallet-a',async()=>{calls++;return 2;}),2);assert.equal(calls,2);
});

test('two distinct reads are bounded, third fails closed without queuing, and rejection releases the slot',async()=>{
 const run=createReadSingleFlight<number>(2);let fail:(error:Error)=>void=()=>{};let complete:(value:number)=>void=()=>{};let thirdCalls=0;
 const first=run('a',()=>new Promise<number>((_resolve,reject)=>{fail=reject;}));
 const second=run('b',()=>new Promise<number>(resolve=>{complete=resolve;}));
 await Promise.resolve();
 await assert.rejects(run('c',async()=>{thirdCalls++;return 3;}),(error:{statusCode?:number})=>error.statusCode===503);
 assert.equal(thirdCalls,0);assert.equal(run('a',async()=>99),first);
 fail(Error('read failed'));await assert.rejects(first,/read failed/);
 assert.equal(await run('c',async()=>3),3);complete(2);assert.equal(await second,2);
});
