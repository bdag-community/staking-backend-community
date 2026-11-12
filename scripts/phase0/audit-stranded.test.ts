import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, zeroPadValue, toBeHex, keccak256, concat } from 'ethers';
import { discoverPairs, classifyPosition, mappingSlot, decodeBatch, summarize, cachedLogs, pooled } from './audit-stranded';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const iface = new Interface([
  'event Staked(address indexed staker,uint256 amount,address indexed pool)',
  'event Redelegated(address indexed staker,uint256 amount,address indexed fromPool,address indexed toPool)',
]);
function log(name: string, args: unknown[], i: number) {
  const event = iface.getEvent(name); assert.ok(event);
  return { ...iface.encodeEventLog(event, args), blockNumber: '0x1', logIndex: toBeHex(i), transactionHash: '0x'+'ab'.repeat(32), removed: false };
}
test('pair discovery includes rescue source and destination and deduplicates repeat deposits', () => {
  const logs = [log('Staked', [A, 10n, B], 0), log('Staked', [A, 20n, B], 1), log('Redelegated', [A, 5n, B, C], 2)];
  assert.deepEqual(discoverPairs(logs), [{ staker: A, pool: B }, { staker: A, pool: C }, { staker: B, pool: B }, { staker: C, pool: C }]);
  assert.deepEqual(discoverPairs([...logs].reverse()), discoverPairs(logs));
});
test('removed logs invalidate a candidate universe', () => {
  assert.throws(() => discoverPairs([{ ...log('Staked', [A, 1n, B], 0), removed: true }]), /removed/i);
});
test('nested mapping has staker outer and pool inner, with separate old/new layouts', () => {
  const outer = keccak256(concat([zeroPadValue(A,32),zeroPadValue('0x0e',32)]));
  const expected = keccak256(concat([zeroPadValue(B,32),outer]));
  assert.equal(mappingSlot(A,B,14), expected);
  assert.notEqual(mappingSlot(A,B,14), mappingSlot(B,A,14));
  assert.notEqual(mappingSlot(A,B,14), mappingSlot(A,B,15));
});
test('orphan principal and displaced records are observations, never automatic compensation', () => {
  const result=classifyPosition({staker:A,pool:B,shares:'0',principal:'17',legacyPrincipal:'20',legacyUnbonding:'0',unbonding:'0'});
  assert.deepEqual(result.flags,['orphan-current-principal','displaced-legacy-principal']);
  assert.equal(result.entitlement,'unverified');
  assert.equal('repairAmount' in result,false);
});
test('live shares prevent orphan classification; self-pool entries require separate review', () => {
  const row={staker:A,pool:B,shares:'5',principal:'10',legacyPrincipal:'0',legacyUnbonding:'0',unbonding:'0'};
  assert.deepEqual(classifyPosition(row).flags,[]);
  assert.deepEqual(classifyPosition({...row,pool:A,shares:'0'}).flags,['operator-self-position','orphan-current-principal']);
});
test('missing or failed RPC responses cannot masquerade as zero balances', () => {
  assert.throws(()=>decodeBatch([{id:1,result:'0x0'}],2),/missing/i);
  assert.throws(()=>decodeBatch([{id:1,error:{message:'state pruned'}}],1),/state pruned/i);
  assert.throws(()=>decodeBatch([{id:1,result:'0x0'},{id:1,result:'0x1'}],1),/duplicate/i);
  assert.deepEqual(decodeBatch([{id:2,result:'0x2'},{id:1,result:'0x1'}],2),['0x1','0x2']);
});
test('summary is deterministic and keeps overlapping candidate amounts separate', () => {
  const rows=[{staker:A,pool:C,shares:'1',principal:'7',legacyPrincipal:'5',legacyUnbonding:'0',unbonding:'0'}, {staker:A,pool:B,shares:'0',principal:'17',legacyPrincipal:'20',legacyUnbonding:'0',unbonding:'0'}];
  const s=summarize(rows);
  assert.deepEqual(s,summarize([...rows].reverse()));
  assert.equal(s.orphanPrincipalWei,'17');assert.equal(s.displacedPrincipalWei,'25');
  assert.equal(s.candidates.length,2);assert.equal('merkleRoot' in s,false);
});
test('a resumed range must be fully covered, and only in-range logs are reused', () => {
  const logs=[{...log('Staked',[A,1n,B],0),blockNumber:'0x3'}];
  assert.deepEqual(cachedLogs([{from:0,to:9,logs}],2,4),logs);
  assert.deepEqual(cachedLogs([{from:0,to:9,logs}],5,9),[]);
  assert.equal(cachedLogs([{from:0,to:9,logs}],5,15),null);
});
test('a failed audit worker stops scheduling further RPC work', async () => {
  const seen:number[]=[];
  await assert.rejects(()=>pooled([0,1,2,3],1,async n=>{seen.push(n);throw new Error('rate limited');}),/rate limited/);
  assert.deepEqual(seen,[0]);
});
test('duplicate position rows cannot inflate candidate totals', () => {
  const p={staker:A,pool:B,shares:'0',principal:'17',legacyPrincipal:'0'};
  assert.throws(()=>summarize([p,p]),/duplicate/i);
});
