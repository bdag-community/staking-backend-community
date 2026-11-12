import { Op, QueryTypes } from "sequelize";
import {
  IndexerState,
  PoolAddress,
  PortfolioHistory,
  StakingActivity,
  UnresolvedTransaction,
} from "../models/index.model";
import { BLOCKCHAIN_CONSTANTS, PoolStatus } from "../constants";
import { getCursorWhere } from "../helpers/pagination.helper";
import { PoolQueryFilters } from "../interfaces/staking.interface";
import config from "../config/app.config";
import { ethers } from "ethers";

class StakingRepository {
  private buildPoolWhereClause(
    filters?: PoolQueryFilters,
    cursor?: { lastSeenBlock: number; address: string },
  ): any {
    const andConditions: any[] = [];

    if (cursor) {
      andConditions.push(getCursorWhere(cursor, ["lastSeenBlock", "address"]));
    }

    if (filters?.search) {
      andConditions.push({
        [Op.or]: [
          { address: { [Op.iLike]: `%${filters.search.toLowerCase()}%` } },
          { name: { [Op.iLike]: `%${filters.search.toLowerCase()}%` } },
        ],
      });
    }

    if (filters?.minLastSeenTimestamp || filters?.maxLastSeenTimestamp) {
      if (filters.minLastSeenTimestamp && filters.maxLastSeenTimestamp) {
        andConditions.push({
          lastSeenTimestamp: {
            [Op.gte]: filters.minLastSeenTimestamp,
            [Op.lt]: filters.maxLastSeenTimestamp,
          },
        });
      } else if (filters.minLastSeenTimestamp) {
        andConditions.push({
          lastSeenTimestamp: { [Op.gte]: filters.minLastSeenTimestamp },
        });
      } else if (filters.maxLastSeenTimestamp) {
        andConditions.push({
          [Op.or]: [
            { lastSeenTimestamp: { [Op.is]: null } },
            { lastSeenTimestamp: { [Op.lt]: filters.maxLastSeenTimestamp } },
          ],
        });
      }
    }

    if (filters?.addresses && filters.addresses.length > 0) {
      andConditions.push({
        address: {
          [Op.in]: filters.addresses.map((addr: string) => addr.toLowerCase()),
        },
      });
    }

    if (filters?.status && filters.status !== PoolStatus.ALL) {
      andConditions.push({ status: filters.status });
    }

    return andConditions.length > 0 ? { [Op.and]: andConditions } : {};
  }

  public async getLatestIndexedBlock(): Promise<number> {
    const state = await IndexerState.findOne({
      where: { key: "last_indexed_block" },
    });
    return state ? state.lastBlock : 0;
  }

  public async updateLatestIndexedBlock(blockNumber: number): Promise<void> {
    await IndexerState.upsert({
      key: "last_indexed_block",
      lastBlock: blockNumber,
    });
  }

  public async getResyncState(key: string): Promise<number | null> {
    const state = await IndexerState.findOne({ where: { key } });
    return state ? state.lastBlock : null;
  }

  public async updateResyncState(
    key: string,
    lastBlock: number,
  ): Promise<void> {
    await IndexerState.upsert({ key, lastBlock });
  }

  public async deleteResyncChunks(): Promise<void> {
    const states = await IndexerState.findAll();
    for (const s of states) {
      if (s.key.startsWith("resync_")) {
        await s.destroy();
      }
    }
  }

  public async deleteChunk(key: string): Promise<void> {
    await IndexerState.destroy({ where: { key } });
  }

  public async getAllPools(
    limit?: number,
    cursor?: { lastSeenBlock: number; address: string },
    filters?: PoolQueryFilters,
  ): Promise<PoolAddress[]> {
    const where = this.buildPoolWhereClause(filters, cursor);

    return await PoolAddress.findAll({
      where,
      order: [
        ["lastSeenBlock", "DESC"],
        ["address", "DESC"],
      ],
      ...(limit ? { limit } : {}),
    });
  }

  public async findPoolByAddress(address: string): Promise<PoolAddress | null> {
    return await PoolAddress.findOne({
      where: { address: address.toLowerCase() },
    });
  }

  public async getUserRecentActivity(
    stakerAddress: string,
    limit: number = 10,
    cursor?: { blockNumber: number; logIndex: number },
  ): Promise<any[]> {
    const table = this.getStakingActivityTableName();
    const cursorClause = cursor
      ? `AND (
          "blockNumber" < :cursorBlockNumber OR
          ("blockNumber" = :cursorBlockNumber AND "logIndex" < :cursorLogIndex)
        )`
      : "";

    return await StakingActivity.sequelize!.query(
      `
      WITH activity_with_balances AS (
        SELECT
          a.*,
          GREATEST(
            SUM(
              CASE
                WHEN a."eventType" = 'Staked'   THEN a."rawAmount"::NUMERIC
                WHEN a."eventType" = 'Unstaked' THEN -(a."rawAmount"::NUMERIC)
                ELSE 0
              END
          ) OVER (
              PARTITION BY a."stakerAddress"
              ORDER BY a."blockNumber" ASC, a."logIndex" ASC, a."id" ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ),
            0
          )::TEXT AS "stakedBalanceAfterRaw"
        FROM ${table} a
        WHERE a."stakerAddress" = :stakerAddress
      )
      SELECT *
      FROM activity_with_balances
      WHERE 1 = 1
      ${cursorClause}
      ORDER BY "blockNumber" DESC, "logIndex" DESC
      LIMIT :limit
      `,
      {
        replacements: {
          stakerAddress: stakerAddress.toLowerCase(),
          limit,
          cursorBlockNumber: cursor?.blockNumber,
          cursorLogIndex: cursor?.logIndex,
        },
        type: QueryTypes.SELECT,
      },
    );
  }

  public async getAllStakerActivities(
    stakerAddress: string,
  ): Promise<StakingActivity[]> {
    return await StakingActivity.findAll({
      where: { stakerAddress: stakerAddress.toLowerCase() },
      order: [
        ["timestamp", "ASC"],
        ["logIndex", "ASC"],
      ],
    });
  }

  public async getStakerActivitiesSince(
    stakerAddress: string,
    since: Date,
  ): Promise<StakingActivity[]> {
    return await StakingActivity.findAll({
      where: {
        stakerAddress: stakerAddress.toLowerCase(),
        timestamp: {
          [Op.gt]: since,
        },
      },
      order: [
        ["timestamp", "ASC"],
        ["logIndex", "ASC"],
      ],
    });
  }

  public async getUserStakedPoolsWithPagination(
    stakerAddress: string,
    limit: number = 10,
    cursor?: { lastActivityBlock: number; poolAddress: string },
  ): Promise<any[]> {
    let paginationClause = "";
    if (cursor) {
      paginationClause = `
        HAVING (
          MAX("lastActivityBlock") < :cursorBlock OR 
          (MAX("lastActivityBlock") = :cursorBlock AND "poolAddress" < :cursorPool)
        )
      `;
    }

    const query = `
      WITH user_pools AS (
        SELECT "poolAddress", MAX("blockNumber") AS "lastActivityBlock"
        FROM ${this.getStakingActivityTableName()}
        WHERE "stakerAddress" = :stakerAddress
          AND "poolAddress" != :zeroAddress
        GROUP BY "poolAddress"

        UNION ALL

        SELECT "fromPoolAddress" AS "poolAddress", MAX("blockNumber") AS "lastActivityBlock"
        FROM ${this.getStakingActivityTableName()}
        WHERE "stakerAddress" = :stakerAddress
          AND "fromPoolAddress" IS NOT NULL
          AND "fromPoolAddress" != :zeroAddress
        GROUP BY "fromPoolAddress"

        UNION ALL

        SELECT "toPoolAddress" AS "poolAddress", MAX("blockNumber") AS "lastActivityBlock"
        FROM ${this.getStakingActivityTableName()}
        WHERE "stakerAddress" = :stakerAddress
          AND "toPoolAddress" IS NOT NULL
          AND "toPoolAddress" != :zeroAddress
        GROUP BY "toPoolAddress"
      )
      SELECT "poolAddress", MAX("lastActivityBlock") AS "lastActivityBlock"
      FROM user_pools
      GROUP BY "poolAddress"
      ${paginationClause}
      ORDER BY "lastActivityBlock" DESC, "poolAddress" DESC
      LIMIT :limit
    `;

    return await StakingActivity.sequelize!.query(query, {
      replacements: {
        stakerAddress: stakerAddress.toLowerCase(),
        zeroAddress: BLOCKCHAIN_CONSTANTS.ZERO_ADDRESS,
        cursorBlock: cursor?.lastActivityBlock,
        cursorPool: cursor?.poolAddress,
        limit,
      },
      type: "SELECT" as any,
    });
  }

  public async countPools(filters?: PoolQueryFilters): Promise<number> {
    const where = this.buildPoolWhereClause(filters);
    return await PoolAddress.count({ where });
  }

  public async findUniquePoolsByStaker(
    stakerAddress: string,
  ): Promise<string[]> {
    const table = this.getStakingActivityTableName();
    const zeroAddress = BLOCKCHAIN_CONSTANTS.ZERO_ADDRESS;

    const results: any[] = await StakingActivity.sequelize!.query(
      `
      SELECT DISTINCT "pool" FROM (
        SELECT "poolAddress" AS "pool" FROM ${table} WHERE "stakerAddress" = :stakerAddress AND "poolAddress" != :zeroAddress
        UNION
        SELECT "fromPoolAddress" AS "pool" FROM ${table} WHERE "stakerAddress" = :stakerAddress AND "fromPoolAddress" != :zeroAddress AND "fromPoolAddress" IS NOT NULL
        UNION
        SELECT "toPoolAddress" AS "pool" FROM ${table} WHERE "stakerAddress" = :stakerAddress AND "toPoolAddress" != :zeroAddress AND "toPoolAddress" IS NOT NULL
      ) AS unique_pools
      `,
      {
        replacements: {
          stakerAddress: stakerAddress.toLowerCase(),
          zeroAddress,
        },
        type: QueryTypes.SELECT,
      },
    );

    return results.map((r: any) => r.pool.toLowerCase());
  }

  public async updatePoolAddress(
    address: string,
    blockNumber: number,
    timestamp: number,
  ): Promise<void> {
    const poolAddress = address.toLowerCase();
    const [record, created] = await PoolAddress.findOrCreate({
      where: { address: poolAddress },
      defaults: {
        firstSeenBlock: blockNumber,
        lastSeenBlock: blockNumber,
        lastSeenTimestamp: timestamp,
        status: PoolStatus.ACTIVE,
      } as any,
    });

    if (!created && record.lastSeenBlock < blockNumber) {
      record.lastSeenBlock = blockNumber;
      record.lastSeenTimestamp = timestamp;
      record.status = PoolStatus.ACTIVE;
      await record.save();
    }
  }

  public async bulkCreateStakingActivities(activities: any[]): Promise<void> {
    if (activities.length > 0) {
      await StakingActivity.bulkCreate(activities, {
        updateOnDuplicate: [
          "eventType",
          "stakerAddress",
          "poolAddress",
          "amount",
          "rawAmount",
          "unbondingPayout",
          "unbondingPayoutRaw",
          "blockNumber",
          "timestamp",
          "contractVersion",
        ],
        conflictAttributes: ["txHash", "logIndex", "contractVersion"],
      });
    }
  }

  public async upsertUnresolvedTransaction(data: {
    txHash: string;
    stakerAddress: string;
    poolAddress?: string | null;
    nonce?: number | null;
    action?: string | null;
    status?:
      | "pending"
      | "stuck"
      | "missing"
      | "nonce_gap"
      | "replaced"
      | "confirmed"
      | "reverted";
  }): Promise<UnresolvedTransaction> {
    const txHash = data.txHash.toLowerCase();
    const now = new Date();
    const [record, created] = await UnresolvedTransaction.findOrCreate({
      where: { txHash },
      defaults: {
        txHash,
        stakerAddress: data.stakerAddress.toLowerCase(),
        poolAddress: data.poolAddress?.toLowerCase() ?? null,
        nonce: data.nonce ?? null,
        action: data.action ?? null,
        status: data.status ?? "pending",
        firstSeenAt: now,
        lastCheckedAt: now,
      },
    });

    if (!created) {
      record.stakerAddress = data.stakerAddress.toLowerCase();
      if (data.poolAddress !== undefined) {
        record.poolAddress = data.poolAddress?.toLowerCase() ?? null;
      }
      if (data.nonce !== undefined) record.nonce = data.nonce;
      if (data.action !== undefined) record.action = data.action;
      if (data.status !== undefined) record.status = data.status;
      record.lastCheckedAt = now;
      await record.save();
    }

    return record;
  }

  public async findUnresolvedTransaction(
    txHash: string,
  ): Promise<UnresolvedTransaction | null> {
    return await UnresolvedTransaction.findOne({
      where: { txHash: txHash.toLowerCase() },
    });
  }

  public async findOpenUnresolvedTransactionsForStaker(
    stakerAddress: string,
    limit = 25,
  ): Promise<UnresolvedTransaction[]> {
    return await UnresolvedTransaction.findAll({
      where: {
        stakerAddress: stakerAddress.toLowerCase(),
        status: {
          [Op.notIn]: ["confirmed", "reverted", "replaced"],
        },
      },
      order: [
        ["firstSeenAt", "ASC"],
        ["nonce", "ASC"],
      ],
      limit,
    });
  }

  public async getOpenUnresolvedTransactions(
    limit = 500,
  ): Promise<UnresolvedTransaction[]> {
    return await UnresolvedTransaction.findAll({
      where: {
        status: {
          [Op.notIn]: ["confirmed", "reverted", "replaced"],
        },
      },
      order: [
        ["firstSeenAt", "ASC"],
        ["nonce", "ASC"],
      ],
      limit,
    });
  }

  public async updateUnresolvedTransaction(
    txHash: string,
    data: Partial<{
      status:
        | "pending"
        | "stuck"
        | "missing"
        | "nonce_gap"
        | "replaced"
        | "confirmed"
        | "reverted";
      blockNumber: number | null;
      receiptStatus: string | null;
      chainNonce: number | null;
      pendingNonce: number | null;
      gapFromNonce: number | null;
      repairStatus:
        | "checking"
        | "not_needed"
        | "skipped"
        | "unavailable"
        | "signature_required"
        | "submitted"
        | "confirmed"
        | "failed"
        | null;
      repairReason: string | null;
      repairTxPlan:
        | {
            nonce: number;
            kind: "claim" | "cancel";
            to: string;
            data: string;
            value: string;
            gasLimit: string;
            maxFeePerGas: string;
            maxPriorityFeePerGas: string;
          }[]
        | null;
      repairTxHashes: { nonce: number; hash: string; kind: string }[] | null;
      repairNonceStart: number | null;
      repairNonceEnd: number | null;
      repairLastAttemptAt: Date | null;
      lastCheckedAt: Date;
    }>,
  ): Promise<void> {
    await UnresolvedTransaction.update(data, {
      where: { txHash: txHash.toLowerCase() },
    });
  }

  public async getClaimedTotals(stakerAddress: string): Promise<{
    totalClaimedRaw: string;
    rewardsClaimedRaw: string;
    stakedFundsReclaimedRaw: string;
  }> {
    const table = this.getStakingActivityTableName();
    const activities: any[] = await StakingActivity.sequelize!.query(
      `
      SELECT
        "eventType",
        "rawAmount",
        "unbondingPayoutRaw"
      FROM ${table}
      WHERE "stakerAddress" = :stakerAddress
        AND "eventType" IN ('Unstaked', 'StakeClaimed')
      ORDER BY "blockNumber" ASC, "logIndex" ASC, "id" ASC
      `,
      {
        replacements: { stakerAddress: stakerAddress.toLowerCase() },
        type: QueryTypes.SELECT,
      },
    );

    let totalClaimedRaw = 0n;
    let stakedFundsReclaimedRaw = 0n;
    let outstandingUnstakedPrincipalRaw = 0n;

    for (const activity of activities) {
      const amount = BigInt(activity.rawAmount || "0");

      if (activity.eventType === "Unstaked") {
        const hasPrincipalField =
          activity.unbondingPayoutRaw !== null &&
          activity.unbondingPayoutRaw !== undefined;
        const principalRaw = hasPrincipalField
          ? BigInt(activity.unbondingPayoutRaw || "0")
          : amount;
        outstandingUnstakedPrincipalRaw += principalRaw;
        continue;
      }

      if (activity.eventType !== "StakeClaimed") continue;

      totalClaimedRaw += amount;
      const eventPrincipalRaw =
        activity.unbondingPayoutRaw !== null &&
        activity.unbondingPayoutRaw !== undefined
          ? BigInt(activity.unbondingPayoutRaw || "0")
          : 0n;
      let reclaimedRaw =
        eventPrincipalRaw > 0n
          ? eventPrincipalRaw
          : amount < outstandingUnstakedPrincipalRaw
          ? amount
          : outstandingUnstakedPrincipalRaw;

      if (reclaimedRaw > amount) reclaimedRaw = amount;
      stakedFundsReclaimedRaw += reclaimedRaw;
      outstandingUnstakedPrincipalRaw =
        outstandingUnstakedPrincipalRaw > reclaimedRaw
          ? outstandingUnstakedPrincipalRaw - reclaimedRaw
          : 0n;
    }

    const rewardsClaimedRaw =
      totalClaimedRaw > stakedFundsReclaimedRaw
        ? totalClaimedRaw - stakedFundsReclaimedRaw
        : 0n;

    return {
      totalClaimedRaw: totalClaimedRaw.toString(),
      rewardsClaimedRaw: rewardsClaimedRaw.toString(),
      stakedFundsReclaimedRaw: stakedFundsReclaimedRaw.toString(),
    };
  }

  public async getTotalClaimedAmount(stakerAddress: string): Promise<string> {
    const totals = await this.getClaimedTotals(stakerAddress);
    return totals.totalClaimedRaw;
  }

  public async getUniqueStakers(): Promise<string[]> {
    const table = this.getStakingActivityTableName();
    const result: any[] = await StakingActivity.sequelize!.query(
      `
      SELECT DISTINCT "stakerAddress" 
      FROM ${table} 
      WHERE "stakerAddress" != :zeroAddress`,
      {
        replacements: { zeroAddress: BLOCKCHAIN_CONSTANTS.ZERO_ADDRESS },
        type: QueryTypes.SELECT,
      },
    );

    return result.map((r: any) => r.stakerAddress);
  }
  public async truncatePortfolioHistory(): Promise<void> {
    await PortfolioHistory.destroy({ where: {}, truncate: true });
  }

  public async bulkCreatePortfolioHistory(data: any[]): Promise<void> {
    if (data.length === 0) return;
    await PortfolioHistory.bulkCreate(data, {
      updateOnDuplicate: ["totalValue"],
      conflictAttributes: ["stakerAddress", "timestamp"],
    });
  }

  public async getPortfolioHistory(
    stakerAddress: string,
    fromTimestamp: Date,
    toTimestamp: Date,
    granularity: "hour" | "day" | "month" = "day",
  ): Promise<any[]> {
    const table = `"${config.DB.SCHEMA}"."PortfolioHistories"`;

    return await StakingActivity.sequelize!.query(
      `
      WITH timeline AS (
        SELECT generate_series(
          date_trunc(:granularity, :fromTimestamp::timestamp),
          date_trunc(:granularity, :toTimestamp::timestamp),
          ('1 ' || :granularity)::interval
        ) AS ts
      )
      SELECT 
        ts as "timestamp",
        COALESCE(ph."totalValue", '0') as "totalValue"
      FROM timeline
      LEFT JOIN LATERAL (
        SELECT "totalValue"
        FROM ${table}
        WHERE "stakerAddress" = :stakerAddress
          AND "timestamp" <= ts
        ORDER BY "timestamp" DESC
        LIMIT 1
      ) ph ON TRUE
      ORDER BY ts ASC
      `,
      {
        replacements: {
          stakerAddress: stakerAddress.toLowerCase(),
          fromTimestamp,
          toTimestamp,
          granularity,
        },
        type: QueryTypes.SELECT,
      },
    );
  }

  public async updatePoolTags(
    address: string,
    tags: string[],
    status?: string,
  ): Promise<void> {
    const updateData: any = { tags, tagsUpdatedAt: new Date() };
    if (status) updateData.status = status;

    await PoolAddress.update(updateData, {
      where: { address: address.toLowerCase() },
    });
  }

  public async updatePoolMetadata(
    address: string,
    metadata: { name?: string; subtitle?: string },
  ): Promise<void> {
    await PoolAddress.update(metadata, {
      where: { address: address.toLowerCase() },
    });
  }

  public async getGlobalPoolVolumes(
    fromTimestamp: Date,
    toTimestamp: Date,
  ): Promise<Record<string, { stakedVolume: string; unstakedVolume: string }>> {
    const table = this.getStakingActivityTableName();
    const results: any[] = await StakingActivity.sequelize!.query(
      `
      SELECT
        "poolAddress",
        COALESCE(SUM(CASE 
          WHEN "eventType" = 'Staked' OR ("eventType" = 'StakeReallocated' AND "toPoolAddress" = "poolAddress") 
          THEN "rawAmount"::NUMERIC ELSE 0 END), 0)::TEXT AS "stakedVolume",
        COALESCE(SUM(CASE 
          WHEN "eventType" = 'Unstaked' OR ("eventType" = 'StakeReallocated' AND "fromPoolAddress" = "poolAddress") 
          THEN "rawAmount"::NUMERIC ELSE 0 END), 0)::TEXT AS "unstakedVolume"
      FROM ${table}
      WHERE "timestamp" >= :fromTimestamp
        AND "timestamp" < :toTimestamp
      GROUP BY "poolAddress"
      `,
      {
        replacements: { fromTimestamp, toTimestamp },
        type: QueryTypes.SELECT,
      },
    );

    return results.reduce(
      (map, r) => {
        map[r.poolAddress.toLowerCase()] = {
          stakedVolume: r.stakedVolume,
          unstakedVolume: r.unstakedVolume,
        };
        return map;
      },
      {} as Record<string, { stakedVolume: string; unstakedVolume: string }>,
    );
  }

  public async getGlobalPoolUnstakeRatios(): Promise<
    Record<string, { totalStaked: string; totalUnstaked: string }>
  > {
    const table = this.getStakingActivityTableName();
    const results: any[] = await StakingActivity.sequelize!.query(
      `
      SELECT
        "poolAddress",
        COALESCE(SUM(CASE 
          WHEN "eventType" = 'Staked' OR ("eventType" = 'StakeReallocated' AND "toPoolAddress" = "poolAddress") 
          THEN "rawAmount"::NUMERIC ELSE 0 END), 0)::TEXT AS "totalStaked",
        COALESCE(SUM(CASE 
          WHEN "eventType" = 'Unstaked' OR ("eventType" = 'StakeReallocated' AND "fromPoolAddress" = "poolAddress") 
          THEN "rawAmount"::NUMERIC ELSE 0 END), 0)::TEXT AS "totalUnstaked"
      FROM ${table}
      GROUP BY "poolAddress"
      `,
      {
        type: QueryTypes.SELECT,
      },
    );

    return results.reduce(
      (map, r) => {
        map[r.poolAddress.toLowerCase()] = {
          totalStaked: r.totalStaked,
          totalUnstaked: r.totalUnstaked,
        };
        return map;
      },
      {} as Record<string, { totalStaked: string; totalUnstaked: string }>,
    );
  }

  public getStakingActivityTableName(): string {
    return StakingActivity.getTableName() as string;
  }
  public async getRecentlyActiveStakers(since: Date): Promise<string[]> {
    const table = this.getStakingActivityTableName();
    const result: any[] = await StakingActivity.sequelize!.query(
      `
      SELECT DISTINCT "stakerAddress"
      FROM ${table}
      WHERE "createdAt" >= :since
        AND "stakerAddress" != :zeroAddress`,
      {
        replacements: {
          since,
          zeroAddress: BLOCKCHAIN_CONSTANTS.ZERO_ADDRESS,
        },
        type: QueryTypes.SELECT,
      },
    );

    return result.map((r: any) => r.stakerAddress);
  }

  public async getBalancesForStakers(
    stakerAddresses: string[],
  ): Promise<{ stakerAddress: string; currentBalance: string }[]> {
    if (stakerAddresses.length === 0) return [];

    const table = this.getStakingActivityTableName();
    return (await StakingActivity.sequelize!.query(
      `
      SELECT
        "stakerAddress",
        GREATEST(
          SUM(
            CASE
              WHEN "eventType" = 'Staked'   THEN "rawAmount"::NUMERIC
              WHEN "eventType" = 'Unstaked' THEN -("rawAmount"::NUMERIC)
              ELSE 0
            END
          ), 0
        )::TEXT AS "currentBalance"
      FROM ${table}
      WHERE "stakerAddress" IN (:stakerAddresses)
      GROUP BY "stakerAddress"`,
      {
        replacements: { stakerAddresses },
        type: QueryTypes.SELECT,
      },
    )) as { stakerAddress: string; currentBalance: string }[];
  }

  public async getAllStakerCurrentBalances(): Promise<
    { stakerAddress: string; currentBalance: string }[]
  > {
    const table = this.getStakingActivityTableName();
    return (await StakingActivity.sequelize!.query(
      `
      SELECT
        "stakerAddress",
        GREATEST(
          SUM(
            CASE
              WHEN "eventType" = 'Staked'   THEN "rawAmount"::NUMERIC
              WHEN "eventType" = 'Unstaked' THEN -("rawAmount"::NUMERIC)
              ELSE 0
            END
          ), 0
        )::TEXT AS "currentBalance"
      FROM ${table}
      WHERE "stakerAddress" != :zeroAddress
      GROUP BY "stakerAddress"`,
      {
        replacements: { zeroAddress: BLOCKCHAIN_CONSTANTS.ZERO_ADDRESS },
        type: QueryTypes.SELECT,
      },
    )) as { stakerAddress: string; currentBalance: string }[];
  }

  public async updatePortfolioSnapshots(
    stakerAddresses: string[],
  ): Promise<void> {
    if (stakerAddresses.length === 0) return;

    const balances = await this.getBalancesForStakers(stakerAddresses);
    const now = new Date();
    now.setUTCMinutes(0, 0, 0);

    const snapshots = balances.map((b) => ({
      stakerAddress: b.stakerAddress.toLowerCase(),
      totalValue: ethers.formatEther(BigInt(b.currentBalance)),
      timestamp: now,
    }));

    await this.bulkCreatePortfolioHistory(snapshots);
  }
}

export default new StakingRepository();
