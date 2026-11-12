import { Op, Transaction } from "sequelize";
import { ethers } from "ethers";
import sequelize from "../models/db.model";
import {
  Activation, ContractEvent, Credential, CredentialPool, Epoch, GovernanceProposal,
  IndexedBlock, IndexerState, PoolEpochStat, PoolTerms, StrandedRepair, PoolRegistrationNonce, PoolAddress,
} from "../models/index.model";
import { AppError } from "../helpers/appError.helper";
import StakingActivity from "../models/stakingActivity.model";

export interface CanonicalBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  miner: string | null;
}

export class GovernanceRepository {
  public async recordBlock(block: CanonicalBlock): Promise<void> {
    await IndexedBlock.upsert({
      blockNumber: block.number, blockHash: block.hash.toLowerCase(), parentHash: block.parentHash.toLowerCase(),
      timestamp: block.timestamp, miner: block.miner?.toLowerCase() ?? null,
    });
  }

  public async recentBlocks(limit: number): Promise<IndexedBlock[]> {
    return IndexedBlock.findAll({ order: [["blockNumber", "DESC"]], limit });
  }

  public async indexingBoundary(block:number):Promise<{number:number;hash:string}|null> {
    const row=await IndexedBlock.findOne({where:{blockNumber:block}});
    return row ? {number:row.blockNumber,hash:row.blockHash} : null;
  }

  /** Remove orphaned history, then replay retained events into every derived projection. */
  public async rollbackAbove(blockNumber: number): Promise<void> {
    await sequelize.transaction(async (transaction) => {
      const above = { blockNumber: { [Op.gt]: blockNumber } };
      await IndexedBlock.destroy({ where: { blockNumber: { [Op.gt]: blockNumber } }, transaction });
      await ContractEvent.destroy({ where: above, transaction });
      await StakingActivity.destroy({ where: above, transaction });
      await this.restoreCanonicalProjections(transaction, blockNumber);
      await this.restoreCanonicalPoolBounds(transaction, blockNumber);
      await IndexerState.upsert({ key: "last_indexed_block", lastBlock: Math.max(0, blockNumber) }, { transaction });
    });
  }

  private async restoreCanonicalProjections(transaction: Transaction, blockNumber: number): Promise<void> {
    const above = { blockNumber: { [Op.gt]: blockNumber } };
    // These rows have event-unique identities, so deleting only the orphan range preserves
    // their original contract kind without needing to infer it from an ABI version string.
    await Credential.destroy({ where: above, transaction });
    await CredentialPool.destroy({ where: above, transaction });
    await Epoch.destroy({ where: { finalizedBlock: { [Op.gt]: blockNumber } }, transaction });
    await PoolEpochStat.destroy({ where: { confirmedBlock: { [Op.gt]: blockNumber } }, transaction });
    // Proposal and activation rows are current-state projections. A later event can overwrite
    // an earlier retained state, so replay their retained event history in canonical order.
    await GovernanceProposal.destroy({ where: {}, transaction });
    await Activation.destroy({ where: {}, transaction });
    const events = await ContractEvent.findAll({ where: { blockNumber: { [Op.lte]: blockNumber } }, order: [["blockNumber", "ASC"], ["logIndex", "ASC"]], transaction });
    for (const event of events) {
      const payload = event.payload as Record<string, string>;
      // Event names overlap between GovernanceHub release notices and Governor lifecycle events.
      // Only the latter may rebuild the Governor projection after a rollback.
      if (payload.__contractKind !== "governance") continue;
      const proposalId = payload.proposalId ?? payload.id;
      if (event.eventName === "Armed") {
        await Activation.upsert({ key: "current", armed: true, armedAt: Number(payload.timestamp), observedBlock: event.blockNumber }, { transaction });
      } else if (event.eventName === "Disarmed") {
        await Activation.upsert({ key: "current", armed: false, armedAt: null, observedBlock: event.blockNumber }, { transaction });
      } else if (event.eventName === "ProposalCreated" && proposalId) {
        await GovernanceProposal.upsert({ proposalId, contractVersion: event.contractVersion, status: "created", proposer: String(payload.proposer).toLowerCase(), blockNumber: event.blockNumber, metadata: payload } as any, { transaction });
      } else if ((event.eventName === "ProposalExecuted" || event.eventName === "ProposalCanceled") && proposalId) {
        const proposal = await GovernanceProposal.findOne({ where: { proposalId, contractVersion: event.contractVersion }, transaction, lock: transaction.LOCK.UPDATE });
        const status = event.eventName === "ProposalExecuted" ? "executed" : "canceled";
        if (proposal) await proposal.update({ status, blockNumber: event.blockNumber, metadata: payload }, { transaction });
        else await GovernanceProposal.create({ proposalId, contractVersion: event.contractVersion, status, proposer: null, blockNumber: event.blockNumber, metadata: payload } as any, { transaction });
      }
    }
  }

  private async restoreCanonicalPoolBounds(transaction: Transaction, blockNumber: number): Promise<void> {
    const blocks = await IndexedBlock.findAll({ where: { blockNumber: { [Op.lte]: blockNumber }, miner: { [Op.not]: null } }, order: [["blockNumber", "ASC"]], transaction });
    const bounds = new Map<string, { first: number; last: number; timestamp: number }>();
    for (const block of blocks) {
      const miner = block.miner?.toLowerCase();
      if (!miner || /^0x0{40}$/.test(miner)) continue;
      const current = bounds.get(miner);
      if (current) { current.last = block.blockNumber; current.timestamp = block.timestamp; }
      else bounds.set(miner, { first: block.blockNumber, last: block.blockNumber, timestamp: block.timestamp });
    }
    const pools = await PoolAddress.findAll({ transaction, lock: transaction.LOCK.UPDATE });
    for (const pool of pools) {
      const canonical = bounds.get(pool.address.toLowerCase());
      if (canonical) await pool.update({ firstSeenBlock: canonical.first, lastSeenBlock: canonical.last, lastSeenTimestamp: canonical.timestamp }, { transaction });
      else if (pool.firstSeenBlock > blockNumber) await pool.destroy({ transaction });
    }
  }

  public async replaceEvents(events: Array<Record<string, unknown>>): Promise<void> {
    if (events.length === 0) return;
    await ContractEvent.bulkCreate(events as any[], {
      updateOnDuplicate: ["blockNumber", "blockHash", "contractAddress", "eventName", "payload"],
      conflictAttributes: ["txHash", "logIndex", "contractVersion"],
    });
  }

  public async recordCredential(data: Record<string, unknown>): Promise<void> {
    await Credential.upsert(data as any);
  }
  public async recordCredentialPool(data: Record<string, unknown>): Promise<void> { await CredentialPool.upsert(data as any); }

  public async finalizeEpoch(epoch: number, eligibleTotal: string, minerCount: number, finalizedBlock: number): Promise<void> {
    await Epoch.upsert({ epoch, finalized: true, eligibleTotal, minerCount, finalizedBlock });
  }

  public async registerMiner(epoch: number, miner: string, blockNumber: number): Promise<void> {
    await PoolEpochStat.findOrCreate({
      where: { poolAddress: miner.toLowerCase(), epoch },
      defaults: { poolAddress: miner.toLowerCase(), epoch, blocks: 0, rewardTally: "0", confirmedBlock: blockNumber } as any,
    });
  }

  public async upsertProposal(data: Record<string, unknown>): Promise<void> { await GovernanceProposal.upsert(data as any); }

  public async setActivation(armed: boolean, armedAt: number | null, observedBlock: number): Promise<void> {
    await Activation.upsert({ key: "current", armed, armedAt, observedBlock });
  }

  /** Canonical, indexed additions to the immutable private-fixture census. */
  public async eligibilityCensus(epoch: number, confirmedHead: number): Promise<{ blockNumber: number; blockHash: string; miningSources: string[]; stakingSources: string[]; stakingSourcePools: Array<{ wallet: string; pool: string }>; delegationSources: { mining: string[]; staking: string[] } }> {
    return sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ }, async transaction => {
      const [watermark, canonicalBlock] = await Promise.all([
        IndexerState.findByPk("last_indexed_block", { transaction }),
        IndexedBlock.findOne({ where: { blockNumber: { [Op.lte]: confirmedHead } }, order: [["blockNumber", "DESC"]], transaction }),
      ]);
      if (!watermark || !canonicalBlock || !/^0x[0-9a-fA-F]{64}$/.test(canonicalBlock.blockHash) || confirmedHead - canonicalBlock.blockNumber > 200) throw new AppError("Indexed eligibility evidence is not caught up", 503);
      const throughBlock = canonicalBlock.blockNumber;
      const [credentials, pools, observedMiners, activities, delegations] = await Promise.all([
        Credential.findAll({ where: { credentialEpoch: epoch, blockNumber: { [Op.lte]: throughBlock } }, attributes: ["wallet", "kind"], transaction }),
        CredentialPool.findAll({ where: { blockNumber: { [Op.lte]: throughBlock } }, attributes: ["wallet", "poolAddress", "kind"], transaction }),
        PoolAddress.findAll({ where: { firstSeenBlock: { [Op.lte]: throughBlock } }, attributes: ["address"], transaction }),
        StakingActivity.findAll({ where: { blockNumber: { [Op.lte]: throughBlock } }, attributes: ["stakerAddress", "poolAddress", "fromPoolAddress", "toPoolAddress"], transaction }),
        ContractEvent.findAll({ where: { eventName: "DelegationChanged", blockNumber: { [Op.lte]: throughBlock } }, attributes: ["payload"], transaction }),
      ]);
      if (Number(watermark.lastBlock) < throughBlock) throw new AppError("Indexed eligibility evidence is not caught up", 503);
      const output = { miningSources: new Set<string>(), stakingSources: new Set<string>(), stakingSourcePools: new Map<string, { wallet: string; pool: string }>(), delegationSources: { mining: new Set<string>(), staking: new Set<string>() } };
      const address = (value: string, message: string) => {
        if (!ethers.isAddress(value)) throw new AppError(message, 503);
        return ethers.getAddress(value).toLowerCase();
      };
      const add = (kind: string, value: string, target: Set<string>) => {
        if (kind !== "miningCredential" && kind !== "stakingCredential") throw new AppError("Indexed eligibility contract kind is invalid", 503);
        target.add(address(value, "Indexed eligibility identity is invalid"));
      };
      const addStakingPool = (wallet: string, pool: string) => {
        const normalizedWallet = address(wallet, "Indexed staking source identity is invalid");
        const normalizedPool = address(pool, "Indexed staking pool identity is invalid");
        output.stakingSources.add(normalizedWallet);
        output.stakingSourcePools.set(`${normalizedWallet}:${normalizedPool}`, { wallet: normalizedWallet, pool: normalizedPool });
      };
      for (const row of credentials) add(row.kind, row.wallet, row.kind === "miningCredential" ? output.miningSources : output.stakingSources);
      // Coinbase recipients are discovered from canonical headers. Claiming a
      // receipt or registering with a keeper is never required for inclusion.
      for (const row of observedMiners) {
        const operator = address(row.address, "Indexed coinbase identity is invalid");
        output.miningSources.add(operator);
        // Locked operator auto-stake has no user Staked event. Include its
        // self-pool; only the fixed-block native earned-reward read grants votes.
        addStakingPool(operator, operator);
      }
      for (const row of pools) {
        if (row.kind === "stakingCredential") addStakingPool(row.wallet, row.poolAddress);
        else add(row.kind, row.wallet, output.miningSources);
      }
      // Do not filter by event type or remaining principal: source-epoch reward
      // history survives withdrawal and migration, including both pool endpoints.
      for (const row of activities) {
        for (const pool of [row.poolAddress, row.fromPoolAddress, row.toPoolAddress]) {
          if (pool && pool.toLowerCase() !== ethers.ZeroAddress) addStakingPool(row.stakerAddress, pool);
        }
      }
      for (const row of delegations) {
        const payload = row.payload as Record<string, string>;
        const kind = payload.__contractKind;
        const effectiveEpoch = Number(payload.effectiveCredentialEpoch);
        if (!Number.isSafeInteger(effectiveEpoch) || (kind !== "miningCredential" && kind !== "stakingCredential")) throw new AppError("Indexed delegation evidence is invalid", 503);
        // A scheduled change is valid evidence, but cannot affect this older credential epoch.
        if (effectiveEpoch > epoch) continue;
        const target = kind === "miningCredential" ? output.delegationSources.mining : output.delegationSources.staking;
        add(kind, payload.account, target);
        add(kind, payload.newDelegate, target);
      }
      return {
        blockNumber: throughBlock, blockHash: canonicalBlock.blockHash.toLowerCase(),
        miningSources: [...output.miningSources].sort(), stakingSources: [...output.stakingSources].sort(),
        stakingSourcePools: [...output.stakingSourcePools.values()].sort((a, b) => `${a.wallet}:${a.pool}`.localeCompare(`${b.wallet}:${b.pool}`)),
        delegationSources: { mining: [...output.delegationSources.mining].sort(), staking: [...output.delegationSources.staking].sort() },
      };
    });
  }

  public async getEpoch(epoch: number): Promise<Epoch | null> { return Epoch.findByPk(epoch); }
  public async stakingSourcePools(wallet:string):Promise<{blockNumber:number;blockHash:string;pools:string[]}> {
    return sequelize.transaction({isolationLevel:Transaction.ISOLATION_LEVELS.REPEATABLE_READ},async transaction=>{
      const watermark=await IndexerState.findByPk('last_indexed_block',{transaction});
      if(!watermark)throw new AppError('Voting source index is not available',503);
      const boundary=await IndexedBlock.findByPk(watermark.lastBlock,{transaction});
      if(!boundary)throw new AppError('Voting source index boundary is not available',503);
      const normalized=ethers.getAddress(wallet).toLowerCase();
      const [activities,operator]=await Promise.all([
        StakingActivity.findAll({where:{stakerAddress:normalized,blockNumber:{[Op.lte]:boundary.blockNumber}},attributes:['poolAddress','fromPoolAddress','toPoolAddress'],transaction}),
        PoolAddress.findOne({where:{address:normalized,firstSeenBlock:{[Op.lte]:boundary.blockNumber}},transaction}),
      ]);
      // Do not filter by remaining stake: completed source-epoch rewards survive an exit.
      const pools=new Set<string>();
      if(operator)pools.add(normalized);
      for(const activity of activities)for(const value of [activity.poolAddress,activity.fromPoolAddress,activity.toPoolAddress]){
        if(value && value!==ethers.ZeroAddress){if(!ethers.isAddress(value))throw new AppError('Indexed voting pool is invalid',503);pools.add(ethers.getAddress(value).toLowerCase());}
      }
      return {blockNumber:boundary.blockNumber,blockHash:boundary.blockHash,pools:[...pools].sort()};
    });
  }
  public async getActivation(): Promise<Activation | null> { return Activation.findByPk("current"); }
  public async getCredentials(wallet: string): Promise<Credential[]> {
    return Credential.findAll({ where: { wallet: ethers.getAddress(wallet).toLowerCase() }, order: [["credentialEpoch", "DESC"], ["blockNumber", "DESC"]] });
  }
  public async getCredentialPools(wallet: string): Promise<CredentialPool[]> { return CredentialPool.findAll({ where: { wallet: ethers.getAddress(wallet).toLowerCase() }, order: [["blockNumber", "ASC"]] }); }
  public async getRepair(wallet: string): Promise<StrandedRepair | null> { return StrandedRepair.findByPk(ethers.getAddress(wallet).toLowerCase()); }
  public async getPoolTerms(address: string): Promise<PoolTerms | null> { return PoolTerms.findByPk(ethers.getAddress(address).toLowerCase()); }

  public async upsertPoolTerms(data: Record<string, unknown>): Promise<PoolTerms> {
    return sequelize.transaction(async transaction => {
      // Serialize updates against the existing pool row, including its first metadata registration.
      const pool = await PoolAddress.findByPk(String(data.poolAddress), {transaction,lock:transaction.LOCK.UPDATE});
      if (!pool) throw new AppError("Confirmed pool is no longer indexed",404);
      const prior = await PoolTerms.findByPk(String(data.poolAddress),{transaction});
      if (prior && Number(data.issuedAt) <= Number(prior.issuedAt)) throw new AppError("A newer registration already exists; stale signature rejected",409);
      await PoolRegistrationNonce.create({poolAddress:data.poolAddress,nonce:data.registrationNonce},{transaction});
      const [record] = await PoolTerms.upsert(data as any,{returning:true,transaction});
      await pool.update({name:String(data.name),subtitle:String(data.subtitle ?? ""),tags:data.tags as string[],tagsUpdatedAt:new Date()},{transaction});
      return record;
    });
  }

  public async hasRegistrationNonce(nonce: string, poolAddress?: string): Promise<boolean> {
    return Boolean(await PoolRegistrationNonce.findOne({where:{nonce,...(poolAddress?{poolAddress}: {})}}));
  }

  public async legacyActivity(wallet: string, beforeBlock: number): Promise<StakingActivity[]> {
    return StakingActivity.findAll({ where: { stakerAddress: ethers.getAddress(wallet).toLowerCase(), blockNumber: { [Op.lte]: beforeBlock } }, order: [["blockNumber", "DESC"], ["logIndex", "DESC"]] });
  }
}

export default new GovernanceRepository();
