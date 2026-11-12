import { Transaction } from "sequelize";
import { PoolStatus } from "../constants";
import sequelize from "../models/db.model";
import { Activation, ContractEvent, Credential, CredentialPool, Epoch, GovernanceProposal, IndexedBlock, IndexerState, PoolAddress, PoolEpochStat } from "../models/index.model";
import StakingActivity from "../models/stakingActivity.model";
import type { CanonicalBlock } from "../repositories/governance.repository";
import { assertCanonicalRange, CanonicalRangeObservation } from "./canonical-range.validation";

export type RangeProjection =
  | { type: "credential"; data: Record<string, unknown> }
  | { type: "credentialPool"; data: Record<string, unknown> }
  | { type: "epoch"; data: Record<string, unknown> }
  | { type: "miner"; data: Record<string, unknown> }
  | { type: "activation"; data: Record<string, unknown> }
  | { type: "proposal"; data: Record<string, unknown> };

export interface CanonicalRange {
  watermark: number;
  blocks: CanonicalBlock[];
  previousBlock?: CanonicalBlock;
  observations: CanonicalRangeObservation[];
  pools: Array<{ address: string; blockNumber: number; timestamp: number }>;
  stakingActivities: Record<string, unknown>[];
  events: Record<string, unknown>[];
  projections: RangeProjection[];
}

/** Commit one confirmed range and its cursor together; callers may retry the whole range safely. */
export async function persistCanonicalRange(range: CanonicalRange): Promise<void> {
  assertCanonicalRange(range);
  await sequelize.transaction(async (transaction) => {
    if (range.stakingActivities.length) {
      const activities = range.stakingActivities.map(({ blockHash: _blockHash, ...activity }) => activity);
      await StakingActivity.bulkCreate(activities as any[], {
        transaction,
        updateOnDuplicate: ["eventType", "stakerAddress", "poolAddress", "amount", "rawAmount", "unbondingPayout", "unbondingPayoutRaw", "blockNumber", "timestamp", "contractVersion"],
        conflictAttributes: ["txHash", "logIndex", "contractVersion"],
      });
    }
    if (range.events.length) {
      await ContractEvent.bulkCreate(range.events as any[], {
        transaction,
        updateOnDuplicate: ["blockNumber", "blockHash", "contractAddress", "eventName", "payload"],
        conflictAttributes: ["txHash", "logIndex", "contractVersion"],
      });
    }
    for (const projection of range.projections) await applyProjection(projection, transaction);
    for (const pool of range.pools) await updatePool(pool, transaction);
    for (const block of range.blocks) {
      await IndexedBlock.upsert({ blockNumber: block.number, blockHash: block.hash.toLowerCase(), parentHash: block.parentHash.toLowerCase(), timestamp: block.timestamp, miner: block.miner?.toLowerCase() ?? null }, { transaction });
    }
    await IndexerState.upsert({ key: "last_indexed_block", lastBlock: range.watermark }, { transaction });
  });
}

async function updatePool(pool: CanonicalRange["pools"][number], transaction: Transaction): Promise<void> {
  const address = pool.address.toLowerCase();
  const record = await PoolAddress.findByPk(address, { transaction, lock: transaction.LOCK.UPDATE });
  if (!record) {
    await PoolAddress.create({ address, firstSeenBlock: pool.blockNumber, lastSeenBlock: pool.blockNumber, lastSeenTimestamp: pool.timestamp, status: PoolStatus.ACTIVE } as any, { transaction });
  } else if (record.lastSeenBlock < pool.blockNumber) {
    await record.update({ lastSeenBlock: pool.blockNumber, lastSeenTimestamp: pool.timestamp, status: PoolStatus.ACTIVE }, { transaction });
  }
}

async function applyProjection(projection: RangeProjection, transaction: Transaction): Promise<void> {
  const data = projection.data;
  if (projection.type === "credential") await Credential.upsert(data as any, { transaction });
  else if (projection.type === "credentialPool") await CredentialPool.upsert(data as any, { transaction });
  else if (projection.type === "epoch") await Epoch.upsert(data as any, { transaction });
  else if (projection.type === "miner") {
    await PoolEpochStat.findOrCreate({ where: { poolAddress: String(data.poolAddress), epoch: Number(data.epoch) }, defaults: data as any, transaction });
  } else if (projection.type === "activation") await Activation.upsert(data as any, { transaction });
  else {
    const proposalId = String(data.proposalId), contractVersion = String(data.contractVersion);
    const current = await GovernanceProposal.findOne({ where: { proposalId, contractVersion }, transaction, lock: transaction.LOCK.UPDATE });
    if (current) await current.update(data, { transaction });
    else await GovernanceProposal.create(data as any, { transaction });
  }
}
