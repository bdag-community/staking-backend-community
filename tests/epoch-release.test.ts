import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpochRelease } from '../src/services/epoch-release';
const clock={interfaceVersion:'3',reader:'0x1000000000000000000000000000000000000002',stakingSource:'0x08Bd519F611556dC148e7BfFE8d6f078F23a8EF7',codeHash:'0x'+'ab'.repeat(32)};
test('separate staking pins the legacy clock and new active source independently',()=>{
  const fresh='0x1000000000000000000000000000000000000020';
  const manifest={chainId:1043,stakingProxy:fresh,legacyStakingProxy:clock.stakingSource,epochClock:{...clock,activeStakingSource:fresh}};
  assert.equal((parseEpochRelease(manifest,1043) as any).activeStakingSource,fresh);
  for(const invalid of [
    {...manifest,stakingProxy:clock.stakingSource},
    {...manifest,legacyStakingProxy:fresh},
    {...manifest,epochClock:{...manifest.epochClock,activeStakingSource:clock.reader}},
  ])assert.throws(()=>parseEpochRelease(invalid,1043),/Invalid epoch/);
});
test('epoch interface is manifest-selected, not inferred from duration or RPC failure',()=>{
  assert.equal(parseEpochRelease({chainId:1043},1043),null);
  assert.deepEqual(parseEpochRelease({chainId:1043,epochClock:clock},1043),{...clock,stakingSource:clock.stakingSource.toLowerCase()});
  for(const override of [{interfaceVersion:'4'},{reader:'0x1234'},{codeHash:'0x00'},{stakingSource:clock.reader}]) {
    assert.throws(()=>parseEpochRelease({chainId:1043,epochClock:{...clock,...override}},1043),/Invalid epoch/);
  }
  assert.throws(()=>parseEpochRelease({chainId:1043,epochClock:null},1043),/Invalid epoch/);
  assert.throws(()=>parseEpochRelease({chainId:1404,epochClock:clock},1404),/Invalid epoch/);
  assert.throws(()=>parseEpochRelease({chainId:1043,epochClock:clock},106043),/mismatch/);
});
