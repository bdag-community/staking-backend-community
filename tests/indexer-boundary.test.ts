import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIndexingBoundary, nextIndexBlock } from '../src/indexing/start-boundary';
const hash = `0x${'a'.repeat(64)}`;
const address = `0x${'1'.repeat(40)}`;
const provider = {getBlock:async()=>({hash}),getCode:async(_:string,block:number)=>block===100?'0x1234':'0x'};
test('a scoped fresh index starts at the verified deployment, never at an arbitrary head',async()=>{
  assert.equal(await verifyIndexingBoundary(provider,100,hash,[{address,fromBlock:100}]),100);
  assert.equal(nextIndexBlock(100,0),100);
  assert.equal(nextIndexBlock(100,150),151);
  assert.equal(nextIndexBlock(0,0),0);
  await assert.rejects(verifyIndexingBoundary(provider,100,`0x${'b'.repeat(64)}`,[{address,fromBlock:100}]),/hash/);
  await assert.rejects(verifyIndexingBoundary({...provider,getCode:async()=> '0x1234'},100,hash,[{address,fromBlock:100}]),/before/);
  await assert.rejects(verifyIndexingBoundary(provider,100,hash,[{address,fromBlock:0}]),/registry/);
  await assert.rejects(verifyIndexingBoundary(provider,100,undefined,[{address,fromBlock:100}]),/hash/);
});
test('a retained canonical deployment checkpoint permits restart after trie pruning, not an unverified fresh start',async()=>{
 const pruned={...provider,getCode:async()=>{throw Error('missing trie node');}};
 await assert.rejects(verifyIndexingBoundary(pruned,100,hash,[{address,fromBlock:100}]),/trie/);
 assert.equal(await verifyIndexingBoundary(pruned,100,hash,[{address,fromBlock:100}],{number:100,hash}),100);
 await assert.rejects(verifyIndexingBoundary(pruned,100,hash,[{address,fromBlock:100}],{number:101,hash}),/checkpoint/);
 await assert.rejects(verifyIndexingBoundary(pruned,100,hash,[{address,fromBlock:100}],{number:100,hash:`0x${'b'.repeat(64)}`}),/checkpoint/);
 await assert.rejects(verifyIndexingBoundary({...pruned,getBlock:async()=>({hash:`0x${'b'.repeat(64)}`})},100,hash,[{address,fromBlock:100}],{number:100,hash}),/hash/);
});
