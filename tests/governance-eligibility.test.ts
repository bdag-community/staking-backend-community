import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import { buildEligibilitySnapshot } from '../src/services/governance-eligibility';
import * as eligibility from '../src/services/governance-eligibility';

test('release manifests accept the empty native testnet census without inventing fixture rewards', () => {
  assert.equal(typeof eligibility.parseEligibilityManifest, 'function');
  const parsed = eligibility.parseEligibilityManifest({chainId:1043, version:3, fixtureRevision:7, network:'bdag-community-testnet-bootstrap', stakers:[], pools:[]}, 1043);
  assert.deepEqual(parsed, {stakers:[], pools:[]});
  assert.throws(() => eligibility.parseEligibilityManifest({chainId:1404, fixtureRevision:7, stakers:[], pools:[]}, 1043));
  assert.throws(() => eligibility.parseEligibilityManifest({chainId:1043, fixtureRevision:99, stakers:[], pools:[]}, 1043));
});

test('the reviewed separate-staking release retains census provenance without inventing rewards',()=>{
  const fresh='0x1000000000000000000000000000000000000020',legacy='0x08Bd519F611556dC148e7BfFE8d6f078F23a8EF7';
  const manifest={chainId:1043,version:3,fixtureRevision:7,network:'bdag-community-testnet-separate-staking-v1',stakers:[],pools:[],stakingProxy:fresh,legacyStakingProxy:legacy,
    epochClock:{interfaceVersion:'3',reader:'0x1000000000000000000000000000000000000002',stakingSource:legacy,activeStakingSource:fresh,codeHash:'0x32dade1466821a061bf09f482f97921a307f5ca421467512c04bbbb5989c1db3'},
    transition:{historicalManifestSha256:'2974bfdce5e574db5df0a2ca49c4fd8d5f8f78adb9845ba3f741125a0d0c7529',runtimeBundleSha256:'b8d100d8c69746070d02b497ee3e4c2837f9020981d036eff7d5a94ef61a5275',readBoundsFromChain:true,historicalEpochsUnchanged:true},
    stakingTransition:{runtimeBundleSha256:'3e93657b71f9cdf3562a61c963541e9a41417c6a1ee98e6e1933ef1acedf7436'}};
  assert.deepEqual(eligibility.parseEligibilityManifest(manifest,1043),{stakers:[],pools:[]});
  for(const invalid of [
    {...manifest,stakingTransition:{runtimeBundleSha256:'00'.repeat(32)}},
    {...manifest,epochClock:{...manifest.epochClock,codeHash:'0x'+'00'.repeat(32)}},
    {...manifest,transition:{...manifest.transition,historicalEpochsUnchanged:false}},
  ])assert.throws(()=>eligibility.parseEligibilityManifest(invalid,1043));
});

test('the pinned timing release retains the native census and requires reviewed clock provenance', () => {
  const manifest = {
    chainId:1043, version:3, fixtureRevision:7, network:'bdag-community-testnet-timing-v1', stakers:[], pools:[],
    epochClock:{interfaceVersion:'3',reader:'0x1000000000000000000000000000000000000002',codeHash:'0x013d916344de3ecc07a7ff5f690bfdddc16b76ae1f44768e95382400828c695d',stakingSource:'0x08Bd519F611556dC148e7BfFE8d6f078F23a8EF7'},
    transition:{historicalManifestSha256:'2974bfdce5e574db5df0a2ca49c4fd8d5f8f78adb9845ba3f741125a0d0c7529',runtimeBundleSha256:'b8d100d8c69746070d02b497ee3e4c2837f9020981d036eff7d5a94ef61a5275',readBoundsFromChain:true,historicalEpochsUnchanged:true},
  };
  assert.deepEqual(eligibility.parseEligibilityManifest(manifest,1043),{stakers:[],pools:[]});
  for(const invalid of [
    {...manifest,epochClock:undefined},
    {...manifest,epochClock:{...manifest.epochClock,reader:'0x1000000000000000000000000000000000000003'}},
    {...manifest,epochClock:{...manifest.epochClock,codeHash:'0x'+'f'.repeat(64)}},
    {...manifest,transition:{...manifest.transition,runtimeBundleSha256:'f'.repeat(64)}},
    {...manifest,transition:{...manifest.transition,historicalEpochsUnchanged:false}},
    {...manifest,network:'unreviewed-timing-release'},
  ])assert.throws(()=>eligibility.parseEligibilityManifest(invalid,1043));
});

const hash = (c: string) => `0x${c.repeat(64).slice(0, 64)}`;
const genesis = hash('a'), blockHash = hash('b');
const mining = '0x0000000000000000000000000000000000000011';
const staking = '0x0000000000000000000000000000000000000012';
const source = '0x0000000000000000000000000000000000000021';
const delegate = '0x0000000000000000000000000000000000000022';
function rpc(mutated = false) {
  let reads = 0;
  return {
    network: async () => 8008,
    block: async (n: number) => n === 0 ? { number: 0, hash: genesis } : n === 100 ? { number: 100, hash: mutated && ++reads > 1 ? hash('c') : blockHash } : null,
    head: async () => 164,
    credential: async (_address: string, method: string, args: unknown[]) => {
      if (method === 'currentEpoch') return 7n;
      if (method === 'votingReady') return true;
      if (method === 'totalSupplyAt') return 200n;
      if (method === 'delegateAt') return args[0] === source ? delegate : args[0];
      if (method === 'isDelegate') return args[0] === delegate;
      if (method === 'poolsOf') return [mining];
      if (method === 'getVotes') return 200n;
      throw new Error(method);
    },
  };
}
const input = () => ({ rpc: rpc(), chainId: 8008, genesisHash: genesis, manifestHash: 'f'.repeat(64), manifest: { stakers: [{ staker: source, pool: mining }], pools: [mining] }, indexed: { miningSources: [], stakingSources: [], stakingSourcePools: [], delegationSources: {} }, epoch: 7, credentialAddresses: { mining, staking } });

test('eligibility snapshot pins genesis and one confirmed header with full uncapped earned-reward weight', async () => {
  const out = await buildEligibilitySnapshot(input());
  const miningEntry = out.entries.find(entry => entry.chamber === 'mining')!;
  const stakingEntry = out.entries.find(entry => entry.chamber === 'staking')!;
  assert.equal(out.provenance.blockNumber, 100);
  assert.equal(out.entries.length, 2);
  assert.equal(miningEntry.delegated, false);
  assert.equal(miningEntry.rawGetVotesWeight, '200');
  assert.equal(miningEntry.governorEquivalentWeight, '200');
  assert.equal(stakingEntry.wallet, delegate);
  assert.equal(stakingEntry.delegated, true);
  assert.equal(stakingEntry.rawGetVotesWeight, '200');
  assert.equal(stakingEntry.governorEquivalentWeight, '200');
  assert.equal(out.provenance.complete, true);
});

test('a single wallet or delegate can retain the full chamber weight', async () => {
  const fullRpc = { ...rpc(), credential: async (_address: string, method: string, args: unknown[]) => {
    if (method === 'currentEpoch') return 7n;
    if (method === 'votingReady') return true;
    if (method === 'totalSupplyAt') return 900n;
    if (method === 'delegateAt') return args[0];
    if (method === 'isDelegate') return false;
    if (method === 'poolsOf') return [];
    if (method === 'getVotes') return 900n;
    throw new Error(method);
  } };
  const out = await buildEligibilitySnapshot({ ...input(), rpc: fullRpc, manifest: { pools: [source], stakers: [{staker:source,pool:mining}] } });
  assert.equal(out.entries[0].governorEquivalentWeight, '900');
});

test('identity, confirmation, and mixed header failures are 503', async () => {
  const base = input();
  await assert.rejects(buildEligibilitySnapshot({ ...base, rpc: rpc(true) }), (e: any) => e.statusCode === 503 && /changed/.test(e.message));
  await assert.rejects(buildEligibilitySnapshot({ ...base, rpc: { ...rpc(), network: async () => 1 } }), (e: any) => e.statusCode === 503 && /identity/.test(e.message));
});

test('invalid identities and more than 32 sources fail closed with 503', async () => {
  const base = input();
  await assert.rejects(buildEligibilitySnapshot({ ...base, manifest: { ...base.manifest, pools: ['not-an-address'] } }), (e: any) => e.statusCode === 503 && /identity/.test(e.message));
  const sources = Array.from({ length: 33 }, (_, index) => `0x${(1000 + index).toString(16).padStart(40, '0')}`);
  const wideRpc = { ...rpc(), credential: async (_address: string, method: string, args: unknown[]) => {
    if (method === 'currentEpoch') return 7n;
    if (method === 'votingReady') return true;
    if (method === 'totalSupplyAt') return 1000n;
    if (method === 'delegateAt') return delegate;
    if (method === 'isDelegate') return true;
    if (method === 'poolsOf') return [];
    if (method === 'getVotes') return 1n;
    throw new Error(String(method));
  } };
  await assert.rejects(buildEligibilitySnapshot({ ...base, rpc: wideRpc, manifest: { stakers: [], pools: sources } }), (e: any) => e.statusCode === 503 && /bounds/.test(e.message));
});


test('delegated mining and staking encode every source with its corresponding pool list', async () => {
  const miningSource2 = '0x0000000000000000000000000000000000000031';
  const stakingSource2 = '0x0000000000000000000000000000000000000032';
  const stakingPool1 = '0x0000000000000000000000000000000000000041';
  const stakingPool2 = '0x0000000000000000000000000000000000000042';
  const registeredPool = '0x0000000000000000000000000000000000000043';
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const checked: string[] = [];
  const multiRpc = {
    ...rpc(),
    credential: async (address: string, method: string, args: unknown[]) => {
      if (method === 'currentEpoch') return 7n;
      if (method === 'votingReady') return true;
      if (method === 'totalSupplyAt') return address.toLowerCase() === mining.toLowerCase() ? 100n : 200n;
      if (method === 'delegateAt') return delegate;
      if (method === 'isDelegate') return true;
      if (method === 'poolsOf') return args[0] === stakingSource2 ? [registeredPool] : [];
      if (method === 'getVotes') {
        const [identities, poolLists] = coder.decode(['address[]', 'address[][]'], String(args[2]));
        const normalizedIdentities = [...identities].map(value => String(value).toLowerCase());
        const normalizedPools = [...poolLists].map(list => [...list].map(value => String(value).toLowerCase()));
        if (address.toLowerCase() === mining.toLowerCase()) {
          assert.deepEqual(normalizedIdentities, [mining, miningSource2]);
          assert.deepEqual(normalizedPools, [[], []]);
          checked.push('mining');
          return 100n;
        }
        assert.deepEqual(normalizedIdentities, [source, stakingSource2]);
        assert.deepEqual(normalizedPools, [[stakingPool1], [stakingPool2, registeredPool]]);
        checked.push('staking');
        return 200n;
      }
      throw new Error(method);
    },
  };
  const out = await buildEligibilitySnapshot({
    ...input(), rpc: multiRpc,
    manifest: { pools: [mining, miningSource2], stakers: [{ staker: source, pool: stakingPool1 }, { staker: stakingSource2, pool: stakingPool2 }] },
  });
  assert.deepEqual(checked.sort(), ['mining', 'staking']);
  assert.equal(out.entries.find(entry => entry.chamber === 'mining')?.voteParams.startsWith('0x'), true);
  assert.deepEqual(out.entries.find(entry => entry.chamber === 'staking')?.sourcePools, [
    { source, pools: [stakingPool1] }, { source: stakingSource2, pools: [stakingPool2, registeredPool] },
  ]);
});

test('eligibility keeps all RPC reads at or below the four-read global bound', async () => {
  let active = 0, peak = 0;
  const observe = async <T>(value: Promise<T> | T): Promise<T> => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 2)); return await value; }
    finally { active--; }
  };
  const baseRpc = rpc();
  const boundedRpc = {
    network: () => observe(baseRpc.network()),
    head: () => observe(baseRpc.head()),
    block: (number: number) => observe(baseRpc.block(number)),
    credential: (address: string, method: string, args: unknown[], block: number) => observe(method === 'totalSupplyAt' && address === mining ? 1000n : baseRpc.credential(address, method, args, block)),
  };
  const pools = Array.from({ length: 5 }, (_, index) => `0x${(80 + index).toString(16).padStart(40, '0')}`);
  await buildEligibilitySnapshot({ ...input(), rpc: boundedRpc, manifest: { pools, stakers: [{staker:source,pool:mining}] } });
  assert.ok(peak <= 4, `observed ${peak} concurrent RPC reads`);
});

test('an incomplete or overcounted census never claims native reward completeness', async () => {
  const base = input();
  for (const total of [199n, 201n]) {
    const original = rpc();
    const mismatched = {...original, credential: async (address: string, method: string, args: unknown[]) => method === 'totalSupplyAt' ? total : method === 'getVotes' ? 100n : original.credential(address,method,args)};
    await assert.rejects(buildEligibilitySnapshot({...base,rpc:mismatched,manifest:{pools:[mining,source],stakers:[{staker:mining,pool:mining},{staker:source,pool:mining}]}}), (error: any) => error.statusCode === 503 && /conserve/.test(error.message));
  }
});
