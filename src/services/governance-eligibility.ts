import { ethers } from 'ethers';
import { AppError } from '../helpers/appError.helper';
import { mapBounded } from '../indexing/bounded-reads';
import { parseEpochRelease } from './epoch-release';

export type Chamber = 'mining' | 'staking';
export type EligibilityRpc = {
  network: () => Promise<number>;
  head: () => Promise<number>;
  block: (n: number) => Promise<{ number: number; hash: string } | null>;
  credential: (address: string, method: string, args: unknown[], block: number) => Promise<unknown>;
};
type SourcePool = { wallet: string; pool: string };
export type EligibilityInput = {
  rpc: EligibilityRpc;
  chainId: number;
  genesisHash: string;
  manifestHash: string;
  manifest: { stakers: Array<{ staker: string; pool: string }>; pools: string[] };
  indexed: {
    miningSources: string[];
    stakingSources: string[];
    /** Canonical post-genesis positions and registered pools. */
    stakingSourcePools: SourcePool[];
    delegationSources: Partial<Record<Chamber, string[]>>;
  };
  epoch: number;
  credentialAddresses: Record<Chamber, string>;
  /** Canonical height chosen by the caller before indexed census reads. */
  blockNumber?: number;
  /** Hash read with the DB census in the same repeatable-read transaction. */
  indexedBlockHash?: string;
};

const unavailable = (message: string) => new AppError(message, 503);
const normalize = (value: string) => {
  try { return ethers.getAddress(value).toLowerCase(); }
  catch { throw unavailable('Eligibility identity is invalid'); }
};
const sourceKey = (chamber: Chamber, source: string) => `${chamber}:${source}`;

/** The SHA-256 pin is checked by the caller. A release is not a funded fixture. */
export function parseEligibilityManifest(value: unknown, chainId: number): { stakers: Array<{staker:string; pool:string}>; pools: string[] } {
  if (!value || typeof value !== 'object') throw unavailable('Eligibility release manifest is invalid');
  const m = value as Record<string, unknown>;
  // An activated timing release is a new, reviewed manifest identity, not a
  // different census or permission to invent rewards. The caller still checks
  // the exact file digest; fixed native history and chamber totals stay required.
  let reviewedTimingRelease = false;
  if (chainId === 1043 && ['bdag-community-testnet-timing-v1','bdag-community-testnet-separate-staking-v1'].includes(String(m.network))) {
    try {
      const clock = parseEpochRelease(m, chainId);
      const transition = m.transition as Record<string, unknown> | undefined;
      const separated = m.network === 'bdag-community-testnet-separate-staking-v1';
      const stakingTransition = m.stakingTransition as Record<string,unknown> | undefined;
      const reviewedClock = separated
        ? clock?.codeHash === '0x32dade1466821a061bf09f482f97921a307f5ca421467512c04bbbb5989c1db3'
          && clock.activeStakingSource === '0x1000000000000000000000000000000000000020'
          && stakingTransition?.runtimeBundleSha256 === '3e93657b71f9cdf3562a61c963541e9a41417c6a1ee98e6e1933ef1acedf7436'
        : clock?.codeHash === '0x013d916344de3ecc07a7ff5f690bfdddc16b76ae1f44768e95382400828c695d';
      reviewedTimingRelease = reviewedClock
        && transition?.historicalManifestSha256 === '2974bfdce5e574db5df0a2ca49c4fd8d5f8f78adb9845ba3f741125a0d0c7529'
        && transition.runtimeBundleSha256 === 'b8d100d8c69746070d02b497ee3e4c2837f9020981d036eff7d5a94ef61a5275'
        && transition.readBoundsFromChain === true && transition.historicalEpochsUnchanged === true;
    } catch { reviewedTimingRelease = false; }
  }
  let reviewedMainnet=false;
  if(chainId===1404){try{reviewedMainnet=Boolean(parseEpochRelease(m,1404)?.mainnetProfile);}catch{reviewedMainnet=false;}}
  const supported = reviewedMainnet || chainId === 8008 && m.fixtureRevision === 5
    || chainId === 1043 && m.fixtureRevision === 7 && m.version === 3 && (m.network === 'bdag-community-testnet-bootstrap' || reviewedTimingRelease);
  if (m.chainId !== chainId || !supported || !Array.isArray(m.stakers) || !Array.isArray(m.pools)) throw unavailable('Eligibility release manifest is incomplete');
  const pools = m.pools.map(pool => typeof pool === 'string' ? normalize(pool) : (()=>{throw unavailable('Invalid release pool');})());
  const stakers = m.stakers.map(item => {
    if (!item || typeof item !== 'object' || typeof item.staker !== 'string' || typeof item.pool !== 'string') throw unavailable('Invalid release staker');
    return {staker:normalize(item.staker), pool:normalize(item.pool)};
  });
  return {stakers, pools};
}

/**
 * Builds only server-derived voting material at one 64-confirmed canonical header.
 * Each source keeps its own pool list: EpochCredential expects the two encoded arrays
 * to have matching indexes. Both published weight fields contain the full native
 * earned-reward weight. The legacy governorEquivalentWeight name is retained for
 * API compatibility, but no wallet or delegation cap is applied.
 */
export async function buildEligibilitySnapshot(input: EligibilityInput) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.genesisHash)
    || !/^[0-9a-f]{64}$/i.test(input.manifestHash)
    || !Number.isSafeInteger(input.epoch) || input.epoch < 0) throw unavailable('Eligibility provenance is invalid');

  const [network, genesis, head] = await Promise.all([input.rpc.network(), input.rpc.block(0), input.rpc.head()]);
  if (network !== input.chainId || genesis?.hash.toLowerCase() !== input.genesisHash.toLowerCase()) throw unavailable('Eligibility chain identity mismatch');
  const blockNumber = input.blockNumber ?? (head - 64);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0 || head < blockNumber + 64) throw unavailable('Eligibility confirmation boundary is unavailable');
  const before = await input.rpc.block(blockNumber);
  if (!before) throw unavailable('Eligibility confirmed block is unavailable');
  if (input.indexedBlockHash && before.hash.toLowerCase() !== input.indexedBlockHash.toLowerCase()) throw unavailable('Indexed eligibility branch does not match RPC snapshot');

  const sources: Record<Chamber, Set<string>> = { mining: new Set(), staking: new Set() };
  const sourcePools = new Map<string, Set<string>>();
  const add = (chamber: Chamber, rawSource: string, rawPool?: string) => {
    const source = normalize(rawSource);
    sources[chamber].add(source);
    const key = sourceKey(chamber, source);
    const pools = sourcePools.get(key) ?? new Set<string>();
    if (rawPool !== undefined) pools.add(normalize(rawPool));
    sourcePools.set(key, pools);
  };
  for (const pool of input.manifest.pools) add('mining', pool);
  for (const item of input.manifest.stakers) add('staking', item.staker, item.pool);
  for (const value of input.indexed.miningSources) add('mining', value);
  for (const value of input.indexed.stakingSources) add('staking', value);
  for (const item of input.indexed.stakingSourcePools) add('staking', item.wallet, item.pool);
  for (const chamber of ['mining', 'staking'] as const) {
    for (const value of input.indexed.delegationSources[chamber] ?? []) add(chamber, value);
  }

  const totals = await mapBounded(['mining', 'staking'] as Chamber[], 4, async chamber => {
    const address = normalize(input.credentialAddresses[chamber]);
    // Keep aggregate RPC concurrency at mapBounded's limit; these reads are sequential.
    const epoch = await input.rpc.credential(address, 'currentEpoch', [], blockNumber);
    const ready = await input.rpc.credential(address, 'votingReady', [], blockNumber);
    const total = await input.rpc.credential(address, 'totalSupplyAt', [BigInt(input.epoch)], blockNumber);
    if (BigInt(epoch as bigint) !== BigInt(input.epoch) || ready !== true || BigInt(total as bigint) <= 0n) throw unavailable('Eligibility credential is not ready at fixed snapshot');
    return [chamber, { address, total: BigInt(total as bigint) }] as const;
  });
  const config = Object.fromEntries(totals) as Record<Chamber, { address: string; total: bigint }>;

  const candidates = (['mining', 'staking'] as const).flatMap(chamber => [...sources[chamber]].sort().map(source => ({ chamber, source })));
  const groups = new Map<string, { chamber: Chamber; wallet: string; sourcePools: Map<string, Set<string>> }>();
  await mapBounded(candidates, 4, async ({ chamber, source }) => {
    const credential = config[chamber];
    const delegate = await input.rpc.credential(credential.address, 'delegateAt', [source, BigInt(input.epoch)], blockNumber);
    const registeredPools = chamber === 'staking'
      ? await input.rpc.credential(credential.address, 'poolsOf', [source], blockNumber)
      : [];
    if (typeof delegate !== 'string' || !ethers.isAddress(delegate) || !Array.isArray(registeredPools) || registeredPools.length > 200) throw unavailable('Eligibility source evidence is invalid');
    const wallet = normalize(delegate);
    const key = `${chamber}:${wallet}`;
    const group = groups.get(key) ?? { chamber, wallet, sourcePools: new Map<string, Set<string>>() };
    const pools = new Set<string>(sourcePools.get(sourceKey(chamber, source)) ?? []);
    for (const pool of registeredPools as string[]) pools.add(normalize(pool));
    group.sourcePools.set(source, pools);
    groups.set(key, group);
  });

  const entries = await mapBounded([...groups.values()].sort((a, b) => `${a.chamber}:${a.wallet}`.localeCompare(`${b.chamber}:${b.wallet}`)), 4, async group => {
    const credential = config[group.chamber];
    const identities = [...group.sourcePools.keys()].sort();
    const sourcePoolLists = identities.map(source => [...(group.sourcePools.get(source) ?? new Set<string>())].sort());
    const uniquePools = new Set(sourcePoolLists.flat());
    if (identities.length === 0 || identities.length > 32 || uniquePools.size > 200 || sourcePoolLists.some(pools => pools.length > 200)) throw unavailable('Eligibility source evidence exceeds bounds');
    // Mining must retain source identities too: delegated mining votes are source-based even with no pools.
    const voteParams = ethers.AbiCoder.defaultAbiCoder().encode(['address[]', 'address[][]'], [identities, sourcePoolLists]);
    const raw = await input.rpc.credential(credential.address, 'getVotes', [group.wallet, BigInt(input.epoch), voteParams], blockNumber);
    const isDelegate = await input.rpc.credential(credential.address, 'isDelegate', [group.wallet, BigInt(input.epoch)], blockNumber);
    const rawGetVotesWeight = BigInt(raw as bigint);
    if (rawGetVotesWeight < 0n || typeof isDelegate !== 'boolean') throw unavailable('Eligibility vote evidence is invalid');
    const delegated = isDelegate;
    if (rawGetVotesWeight > credential.total) throw unavailable('Eligibility weight exceeds the chamber total');
    const governorEquivalentWeight = rawGetVotesWeight;
    return {
      wallet: group.wallet,
      chamber: group.chamber,
      credentialAddress: credential.address,
      rawGetVotesWeight: rawGetVotesWeight.toString(),
      eligibleRewardWeight: rawGetVotesWeight.toString(),
      governorEquivalentWeight: governorEquivalentWeight.toString(),
      delegated,
      sourceIdentities: identities.map(source => `${group.chamber}:${source}`),
      sourcePools: identities.map((source, index) => ({ source, pools: sourcePoolLists[index] })),
      voteParams,
    };
  });

  // These are exact native ledger units, not rounded BDAG display amounts.
  // Pool accumulator residuals remain in the ledger and are not vote entries.
  // Never label an incomplete (or duplicated) indexed census as complete.
  for (const chamber of ['mining', 'staking'] as const) {
    const accounted = entries.filter(entry => entry.chamber === chamber)
      .reduce((sum, entry) => sum + BigInt(entry.eligibleRewardWeight), 0n);
    if (accounted !== config[chamber].total) throw unavailable('Indexed eligibility census does not conserve native chamber rewards');
  }

  const after = await input.rpc.block(blockNumber);
  if (!after || after.hash.toLowerCase() !== before.hash.toLowerCase()) throw unavailable('Eligibility snapshot changed during reads');
  const finalHead = await input.rpc.head();
  if (finalHead < blockNumber + 64) throw unavailable('Eligibility confirmation boundary changed during reads');
  return {
    interfaceVersion: '1' as const,
    provenance: {
      chainId: input.chainId, genesisHash: input.genesisHash.toLowerCase(), manifestHash: input.manifestHash.toLowerCase(), epoch: input.epoch,
      blockNumber, blockHash: before.hash.toLowerCase(), confirmations: finalHead - blockNumber,
      scope: 'native-reward-complete' as const, complete: true,
    },
    eligibleTotals: { mining: config.mining.total.toString(), staking: config.staking.total.toString() },
    epochs: { sourceEpoch: Math.max(0, input.epoch - 1), activeVotingEpoch: input.epoch, expiresAfterEpoch: input.epoch + 1 },
    // Zero-weight sources remain evidence only and never become ballot entries.
    entries: entries.filter(entry => BigInt(entry.governorEquivalentWeight) > 0n),
  };
}
