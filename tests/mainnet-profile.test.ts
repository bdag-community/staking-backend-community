import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {parseEpochRelease} from '../src/services/epoch-release';
import {parseEligibilityManifest} from '../src/services/governance-eligibility';
const profile=JSON.parse(readFileSync(new URL('./fixtures/mainnet-profile.fixture.json',import.meta.url),'utf8'));
test('Mainnet epoch reads accept a sealed canonical dual-address seven-day release profile',()=>{
 const parsed=parseEpochRelease(profile,1404);assert.equal(parsed?.activeStakingSource,profile.stakingProxy);assert.equal((parsed as any).mainnetProfile?.baseline.hash,profile.baseline.hash);
});
test('Mainnet epoch reads reject unsealed, wrong-fork, wrong-source or shortened-epoch profiles',()=>{
 for(const value of [{...profile,status:'review',installationAuthorized:false},{...profile,genesisHash:'0x'+'12'.repeat(32)},{...profile,baseline:{...profile.baseline,hash:'0x'+'12'.repeat(32)}},{...profile,epochSeconds:1800},{...profile,stakingProxy:profile.legacyStakingProxy}])assert.throws(()=>parseEpochRelease(value,1404));
});
test('Mainnet eligibility uses the sealed profile as provenance without seeded reward allocations',()=>{
 assert.deepEqual(parseEligibilityManifest({...profile,stakers:[],pools:[]},1404),{stakers:[],pools:[]});
 assert.throws(()=>parseEligibilityManifest({...profile,status:'review',stakers:[],pools:[]},1404));
});
