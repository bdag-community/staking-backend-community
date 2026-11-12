import {verifyMainnetCanonicalHistory} from '../lib/mainnet-profile';
import { ethers } from 'ethers';
import { AppError } from '../helpers/appError.helper';
import { ContractDefinition, ContractRegistry, eventAbiFor } from '../contracts/contract-registry';
import { EpochRelease } from './epoch-release';
import versionedClockAbi from '../contracts/generated/VersionedChainTallyReader.json';

type BlockRef = { number: number; hash: string; timestamp?: bigint };
type IndexedSources = { blockNumber: number; blockHash: string; pools: readonly string[] };
type ReadContext = { head: BlockRef; calls: Map<string, Promise<unknown>>; boundaries: Map<number, string>; epochRelease: EpochRelease | null };
type EpochCheck = { definition: ContractDefinition; epoch: bigint };
type Chamber = { status: 'not-configured' } | { status: 'not-ready'; address: string; pools: string[]; epoch: number } | {
 status: 'ready'; address: string; epoch: number; sourceEpoch: number; expiresAfterEpoch: number; expiresAt: string;
 pools: string[]; rawWeight: string; votes: string; total: string; claimed: string; claimable: boolean;
 delegate: string; isDelegate: boolean; delegated: boolean;
 receipt: { status: 'claimed' | 'available' | 'none'; claimedWeight: string; claimableWeight: string; claimable: boolean };
};

export class GovernanceReader {
 constructor(private provider: ethers.JsonRpcProvider, private registry: ContractRegistry, private chainId: number, private genesis?: string, private epochRelease: () => Promise<EpochRelease | null> = async () => null) {}

 private async block(number: number | 'latest'): Promise<BlockRef | null> {
  const value: unknown = await this.provider.send('eth_getBlockByNumber', [number === 'latest' ? number : ethers.toQuantity(number), false]);
  if (!value || typeof value !== 'object') return null;
  const block = value as { number?: unknown; hash?: unknown; timestamp?: unknown };
  const height = typeof block.number === 'string' && /^0x[0-9a-f]+$/i.test(block.number) ? Number(BigInt(block.number)) : NaN;
  if (!Number.isSafeInteger(height) || height < 0 || (number !== 'latest' && height !== number)
   || typeof block.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new AppError('Governance block evidence is invalid', 503);
  return { number: height, hash: block.hash.toLowerCase(), timestamp: typeof block.timestamp === 'string' && /^0x[0-9a-f]+$/i.test(block.timestamp) ? BigInt(block.timestamp) : undefined };
 }

 private async identity(): Promise<void> {
  if (!this.genesis) throw new AppError('EXPECTED_GENESIS_HASH is required for governance reads', 503);
  const [chain, genesis] = await Promise.all([this.provider.send('eth_chainId', []), this.block(0)]);
  if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== BigInt(this.chainId)
   || genesis?.hash !== this.genesis.toLowerCase()) throw new AppError('Governance chain identity mismatch', 503);
 }

 async head(): Promise<BlockRef> {
  const [, head] = await Promise.all([this.identity(), this.block('latest')]);
  if (!head) throw new AppError('Governance chain identity mismatch', 503);
  return head;
 }

 async assertStable(head: BlockRef): Promise<void> {
  if ((await this.block(head.number))?.hash !== head.hash) throw new AppError('Governance snapshot changed during reads', 503);
 }

 private async context(): Promise<ReadContext> {
  const context: ReadContext = { head: await this.head(), calls: new Map(), boundaries: new Map(), epochRelease: await this.epochRelease() };
  if (context.epochRelease) {
   if(context.epochRelease.mainnetProfile)await verifyMainnetCanonicalHistory(context.epochRelease.mainnetProfile,(method,params)=>this.provider.send(method,params));
   const code = await this.provider.send('eth_getCode', [context.epochRelease.reader, ethers.toQuantity(context.head.number)]);
   if (typeof code !== 'string' || !ethers.isHexString(code) || code === '0x' || ethers.keccak256(code).toLowerCase() !== context.epochRelease.codeHash) throw new AppError('Voting clock runtime does not match the release',503);
   const source = await this.clockCall<string>(context, 'clockSource');
   if (source.toLowerCase() !== context.epochRelease.stakingSource.toLowerCase()) throw new AppError('Voting clock source mismatch',503);
  }
  return context;
 }

 private clockCall<T>(context: ReadContext, method: string, args: readonly unknown[] = []): Promise<T> {
  if (!context.epochRelease) throw new AppError('Versioned voting clock unavailable',503);
  const iface = new ethers.Interface(versionedClockAbi), data = iface.encodeFunctionData(method,args);
  const key = `clock:${context.epochRelease.reader}:${context.head.number}:${data}`;
  const existing = context.calls.get(key);
  if (existing) return existing as Promise<T>;
  const read = this.provider.send('eth_call',[{ to: context.epochRelease.reader, data },ethers.toQuantity(context.head.number)])
   .then(result => iface.decodeFunctionResult(method,result)[0] as T);
  context.calls.set(key,read);
  return read;
 }

 /** The context has already checked chain identity. Dispatch exact calls through
  * the existing paced provider without ethers.Contract's repeated network probes.
  * Reuse is request-local, fixed-block only, and discarded after the response. */
 private call<T>(context: ReadContext, definition: ContractDefinition, method: string, args: readonly unknown[] = [], latest = false): Promise<T> {
  const iface = new ethers.Interface(eventAbiFor(definition.kind, definition.version));
  const data = iface.encodeFunctionData(method, args);
  const block = latest ? 'latest' : ethers.toQuantity(context.head.number);
  const key = `${definition.address}:${block}:${data}`;
  const prior = latest ? undefined : context.calls.get(key);
  if (prior) return prior as Promise<T>;
  const read = this.provider.send('eth_call', [{ to: definition.address, data }, block]).then((result: unknown) => {
   if (typeof result !== 'string') throw new AppError('Governance call evidence is invalid', 503);
   return iface.decodeFunctionResult(method, result)[0] as T;
  });
  if (!latest) context.calls.set(key, read);
  return read;
 }

 private async finish(context: ReadContext, clocks: readonly EpochCheck[]): Promise<void> {
  await Promise.all([
   this.assertStable(context.head),
   ...[...context.boundaries].map(async ([number, hash]) => {
    if ((await this.block(number))?.hash !== hash) throw new AppError('Voting source boundary changed during reads', 503);
   }),
   ...clocks.map(async ({ definition, epoch }) => {
    if (await this.call<bigint>(context, definition, 'currentEpoch', [], true) !== epoch) throw new AppError('Voting period changed during the read. Refresh current power.', 503);
   }),
  ]);
  await this.identity();
 }

 private async discover(context: ReadContext, wallet: string, indexed: IndexedSources) {
  const { head } = context;
  if (indexed.blockNumber < 0 || indexed.blockNumber > head.number || head.number - indexed.blockNumber > 256) throw new AppError('Voting source index is not caught up', 503);
  const boundary = await this.block(indexed.blockNumber);
  if (!boundary || boundary.hash !== indexed.blockHash.toLowerCase()) throw new AppError('Voting source boundary changed on the canonical chain', 503);
  context.boundaries.set(boundary.number, boundary.hash);
  const pools = new Set<string>();
  const add = (value: unknown) => {
   if (typeof value !== 'string' || !ethers.isAddress(value)) throw new AppError('Voting pool evidence is invalid', 503);
   if (value !== ethers.ZeroAddress) pools.add(ethers.getAddress(value).toLowerCase());
  };
  indexed.pools.forEach(add);
  for (const definition of this.registry.contracts.filter(item => item.kind === 'staking')) {
   const fromBlock = Math.max(indexed.blockNumber + 1, definition.fromBlock), toBlock = Math.min(head.number, definition.toBlock ?? head.number);
   if (fromBlock > toBlock) continue;
   const iface = new ethers.Interface(eventAbiFor('staking', definition.version));
   const events = ['Staked', 'Unstaked', 'Redelegated', 'StakeReallocated'].flatMap(name => { const event = iface.getEvent(name); return event ? [event.topicHash] : []; });
   if (!events.length) throw new AppError('Voting source event interface is unavailable', 503);
   const logs: unknown = await this.provider.send('eth_getLogs', [{ address: definition.address, fromBlock: ethers.toQuantity(fromBlock), toBlock: ethers.toQuantity(toBlock), topics: [events, ethers.zeroPadValue(wallet, 32)] }]);
   if (!Array.isArray(logs)) throw new AppError('Voting source log evidence is invalid', 503);
   for (const value of logs) {
    if (!value || typeof value !== 'object') throw new AppError('Voting source event evidence is invalid', 503);
    const log = value as { address?: unknown; topics?: unknown; data?: unknown; removed?: unknown; blockNumber?: unknown };
    const height = typeof log.blockNumber === 'string' ? Number(BigInt(log.blockNumber)) : log.blockNumber;
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== definition.address || !Array.isArray(log.topics)
     || log.topics.some(topic => typeof topic !== 'string') || typeof log.data !== 'string' || log.removed === true
     || typeof height !== 'number' || !Number.isSafeInteger(height) || height < fromBlock || height > toBlock) throw new AppError('Voting source event evidence is invalid', 503);
    const event = iface.parseLog({ topics: log.topics as string[], data: log.data });
    if (!event || String(event.args.staker).toLowerCase() !== wallet.toLowerCase()) throw new AppError('Voting source event evidence is invalid', 503);
    for (const field of ['pool', 'fromPool', 'toPool']) if (event.args[field] !== undefined) add(event.args[field]);
   }
  }
  const definition = this.registry.at(head.number).find(item => item.kind === 'stakingCredential');
  const staking = this.registry.at(head.number).find(item => item.kind === 'staking');
  if (!definition || !staking) throw new AppError('Staking voting is not configured on this network', 503);
  const [epoch, shares] = await Promise.all([this.call<bigint>(context, definition, 'currentEpoch'), this.call<bigint>(context, staking, 'poolTotalShares', [wallet])]);
  if (shares > 0n) add(wallet);
  if (pools.size > 200) throw new AppError('Voting source pool count exceeds the supported contract limit', 503);
  return { sources: { interfaceVersion: '1' as const, complete: true as const, chainId: this.chainId, genesisHash: this.genesis?.toLowerCase(), wallet: wallet.toLowerCase(), pools: [...pools].sort(), activeVotingEpoch: Number(epoch), blockNumber: head.number, blockHash: head.hash, indexedThroughBlock: indexed.blockNumber }, clock: { definition, epoch } };
 }

 async votingSources(wallet: string, indexed: IndexedSources) {
  const context = await this.context();
  const { sources, clock } = await this.discover(context, wallet, indexed);
  await this.finish(context, [clock]);
  return sources;
 }

 async credentialsWithSources(wallet: string, indexed: IndexedSources) {
  const context = await this.context();
  const { sources } = await this.discover(context, wallet, indexed);
  return this.readCredentials(context, wallet, sources.pools, sources.activeVotingEpoch);
 }

 async credentials(wallet: string, discoveredPools: readonly string[] = [], discoveryEpoch?: number) {
  return this.readCredentials(await this.context(), wallet, discoveredPools, discoveryEpoch);
 }

 private async readCredentials(context: ReadContext, wallet: string, discoveredPools: readonly string[], discoveryEpoch?: number) {
  const readChamber = async (key: 'mining' | 'staking', kind: 'miningCredential' | 'stakingCredential'): Promise<{ chamber: Chamber; clock?: EpochCheck }> => {
   const definition = this.registry.at(context.head.number).find(item => item.kind === kind);
   if (!definition) return { chamber: { status: 'not-configured' } };
   const read = <T>(method: string, args: readonly unknown[] = []) => this.call<T>(context, definition, method, args);
   const [epoch, ready, registered] = await Promise.all([read<bigint>('currentEpoch'), read<boolean>('votingReady'), key === 'staking' ? read<string[]>('poolsOf', [wallet]) : Promise.resolve([])]);
   const activeVotingEpoch = Number(epoch), clock = { definition, epoch };
   if (key === 'staking' && discoveryEpoch !== undefined && activeVotingEpoch !== discoveryEpoch) throw new AppError('Voting period changed while discovering sources. Refresh current power.', 503);
   const pools = key === 'staking' ? [...new Set([...registered, ...discoveredPools].map(value => ethers.getAddress(value).toLowerCase()))].sort() : [];
   if (!ready) return { chamber: { status: 'not-ready', address: definition.address, pools, epoch: activeVotingEpoch }, clock };
   const delegate = await read<string>('delegateAt', [wallet, epoch]);
   const voteParams = delegate.toLowerCase() === wallet.toLowerCase() && pools.length > 0
    ? ethers.AbiCoder.defaultAbiCoder().encode(['address[]', 'address[][]'], [[wallet], [pools]]) : '0x';
   const [rawWeight, votes, total, claimed, isDelegate, duration, genesis] = await Promise.all([
    read<bigint>('rawWeightOf', [wallet, epoch, pools]), read<bigint>('getVotes', [wallet, epoch, voteParams]), read<bigint>('totalSupplyAt', [epoch]),
    read<bigint>('balanceOf(address,uint256)', [wallet, epoch]), read<boolean>('isDelegate', [wallet, epoch]), read<bigint>('epochDuration'), read<bigint>('genesisTime'),
   ]);
   if (rawWeight > total || votes > total) throw new AppError('Credential reward weight is inconsistent', 503);
   let expiresAt = genesis + (epoch + 1n) * duration;
   if (context.epochRelease) {
    const bounds = await this.clockCall<{epoch:bigint;version:bigint;start:bigint;end:bigint;duration:bigint}>(context,'epochBounds',[epoch]);
    if ([bounds.epoch,bounds.version,bounds.start,bounds.end,bounds.duration].some(value=>typeof value!=='bigint'||value<0n||value>(1n<<64n)-1n) ||
     bounds.epoch!==epoch || bounds.version===0n || bounds.duration!==duration || bounds.start<genesis || duration<=0n || bounds.end-bounds.start!==duration ||
     context.head.timestamp===undefined || context.head.timestamp>=bounds.end) throw new AppError('Invalid voting clock epoch metadata',503);
    expiresAt=bounds.end;
   }
   const claimableWeight = rawWeight > claimed ? rawWeight - claimed : 0n;
   return { chamber: { status: 'ready', address: definition.address, epoch: activeVotingEpoch, sourceEpoch: Math.max(0, activeVotingEpoch - 1), expiresAfterEpoch: activeVotingEpoch + 1,
    expiresAt: String(expiresAt), pools, rawWeight: String(rawWeight), votes: String(votes), total: String(total), claimed: String(claimed), claimable: claimableWeight > 0n,
    delegate, isDelegate, delegated: delegate.toLowerCase() !== wallet.toLowerCase(), receipt: { status: claimed > 0n ? 'claimed' : claimableWeight > 0n ? 'available' : 'none', claimedWeight: String(claimed), claimableWeight: String(claimableWeight), claimable: claimableWeight > 0n } }, clock };
  };
  const [mining, staking] = await Promise.all([readChamber('mining', 'miningCredential'), readChamber('staking', 'stakingCredential')]);
  const clocks = [mining.clock, staking.clock].filter((clock): clock is EpochCheck => clock !== undefined);
  if (clocks.some(clock => clock.epoch !== clocks[0].epoch)) throw new AppError('Voting chambers disagree on the active epoch', 503);
  await this.finish(context, clocks);
  const epoch = clocks[0] ? Number(clocks[0].epoch) : undefined;
  return { interfaceVersion: '1' as const, status: 'ready' as const, chainId: this.chainId, genesisHash: this.genesis?.toLowerCase(), blockNumber: context.head.number, blockHash: context.head.hash,
   ...(epoch === undefined ? {} : { epoch, sourceEpoch: Math.max(0, epoch - 1), activeVotingEpoch: epoch, expiresAfterEpoch: epoch + 1 }), mining: mining.chamber, staking: staking.chamber };
 }
}
