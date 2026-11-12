import { ethers } from "ethers";
import stakingRepository from "../repositories/staking.repository";
import blockchainService from "./blockchain.service";
import apyService from "./apy.service";
import logger from "../helpers/logger.helper";
import {
  StakerPoolDetail,
  StakerTotalStakedResponse,
  PoolQueryFilters,
  PoolDetail,
  PoolListResponse,
  PoolDetailResponse,
  PoolTag,
} from "../interfaces/staking.interface";
import { decodeCursor, encodeCursor } from "../helpers/pagination.helper";
import { PAGINATION_CONSTANTS } from "../constants";
import { PoolStatus } from "../constants/blockchain.constants";
import { AppError } from "../helpers/appError.helper";
import transactionRecoveryService from "./transactionRecovery.service";
import visibilityService from "./visibility.service";

class StakingService {
  private getRejectedReasons(results: PromiseSettledResult<any>[]): string[] {
    return results
      .filter((res): res is PromiseRejectedResult => res.status === "rejected")
      .map((res) => res.reason?.message || String(res.reason));
  }

  public async getPoolTotalStaked(poolAddress: string): Promise<string> {
    try {
      const totalStaked = await blockchainService.getPoolTotalStaked(
        poolAddress
      );

      return ethers.formatEther(totalStaked);
    } catch (error: any) {
      logger.error("Error fetching data from contract", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getStakerTotalStaked(
    stakerAddress: string
  ): Promise<StakerTotalStakedResponse> {
    try {
      const allPools = await stakingRepository.getAllPools();
      const poolAddresses = allPools.map((p) => p.address);
      const claimedTotals = await stakingRepository.getClaimedTotals(
        stakerAddress
      );

      if (!poolAddresses || poolAddresses.length === 0) {
        return {
          totalStaked: "0",
          weeklyEarnings: "0",
          totalClaimedAmount: ethers.formatEther(
            BigInt(claimedTotals.totalClaimedRaw)
          ),
          rewardsClaimed: ethers.formatEther(
            BigInt(claimedTotals.rewardsClaimedRaw)
          ),
          stakedFundsReclaimed: ethers.formatEther(
            BigInt(claimedTotals.stakedFundsReclaimedRaw)
          ),
          totalUnbonding: "0",
          pools: [],
        };
      }

      const [pooladdress, unbondingRequests] = await Promise.all([
        this.getPoolAddresses({ addresses: poolAddresses }),
        blockchainService.getUnbondingRequests(stakerAddress),
      ]);

      const detailsResults = await Promise.allSettled(
        pooladdress?.pool?.map(async (pool) => {
          const amount = await blockchainService.getPoolStakerAmount(
            pool.poolAddress,
            stakerAddress
          );

          const amountEther = ethers.formatEther(amount);
          let weeklyEarnings = "0";

          if (amount > 0n && ethers.parseEther(pool.apy.totalStaked) > 0n) {
            const poolTotalStaked = ethers.parseEther(pool.apy.totalStaked);
            const poolWeeklyYield = ethers.parseEther(pool.apy.weeklyYield);
            const earnings = (amount * poolWeeklyYield) / poolTotalStaked;
            weeklyEarnings = ethers.formatEther(earnings);
          }

          const poolUnbonding = unbondingRequests
            .filter(
              (r) =>
                r.pool.toLowerCase() === pool.poolAddress.toLowerCase() &&
                !r.isClaimed
            )
            .reduce((acc: bigint, r: any) => acc + BigInt(r.amount), 0n);

          return {
            poolAddress: pool.poolAddress,
            amount: amountEther,
            weeklyEarnings,
            unbondingAmount: ethers.formatEther(poolUnbonding),
          };
        })
      );

      const details: StakerPoolDetail[] =
        detailsResults
          .filter(
            (res): res is PromiseFulfilledResult<any> =>
              res.status === "fulfilled"
          )
          .map((res: any) => res.value);

      const failedReads = this.getRejectedReasons(detailsResults);
      if (failedReads.length > 0) {
        logger.error("Failed to fetch complete staker balances", {
          stakerAddress,
          failures: failedReads,
        });
        throw new AppError(
          "Unable to fetch complete staking balances. Please try again shortly.",
          503
        );
      }

      const activePools = details.filter(
        (d) =>
          BigInt(ethers.parseEther(d.amount)) > 0n ||
          BigInt(ethers.parseEther(d.unbondingAmount || "0")) > 0n
      );

      const totalValue = details.reduce(
        (acc, d) => acc + ethers.parseEther(d.amount),
        0n
      );

      const totalWeeklyEarnings = details.reduce(
        (acc, d) => acc + ethers.parseEther(d.weeklyEarnings || "0"),
        0n
      );

      const totalUnbonding = details.reduce(
        (acc, d) => acc + ethers.parseEther(d.unbondingAmount || "0"),
        0n
      );

      return {
        totalStaked: ethers.formatEther(totalValue),
        weeklyEarnings: ethers.formatEther(totalWeeklyEarnings),
        totalClaimedAmount: ethers.formatEther(
          BigInt(claimedTotals.totalClaimedRaw)
        ),
        rewardsClaimed: ethers.formatEther(
          BigInt(claimedTotals.rewardsClaimedRaw)
        ),
        stakedFundsReclaimed: ethers.formatEther(
          BigInt(claimedTotals.stakedFundsReclaimedRaw)
        ),
        totalUnbonding: ethers.formatEther(totalUnbonding),
        pools: activePools,
      };
    } catch (error: any) {
      logger.error("Error fetching total staked amount across pools", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getEpochStatus() {
    try {
      return await blockchainService.getEpochStatus();
    } catch (error: any) {
      logger.error("Error fetching epoch status", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getPendingReward(
    stakerAddress: string,
    poolAddress: string
  ): Promise<string> {
    try {
      const reward = await blockchainService.getPoolStakerYield(
        poolAddress,
        stakerAddress
      );
      return ethers.formatEther(reward);
    } catch (error: any) {
      logger.error("Error fetching pending reward", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getStakerAmount(
    poolAddress: string,
    stakerAddress: string
  ): Promise<string> {
    try {
      const amount = await blockchainService.getPoolStakerAmount(
        poolAddress,
        stakerAddress
      );
      return ethers.formatEther(amount);
    } catch (error: any) {
      logger.error("Error fetching staker amount", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getPoolAddresses(filters?: PoolQueryFilters) {
    try {
      const [pools, latestBlock] = await Promise.all([
        stakingRepository.getAllPools(undefined, undefined, filters),
        blockchainService.getLatestBlock(),
      ]);

      if (!latestBlock) throw new Error("Could not fetch latest block");

      const [globalTally, minerSplit] = await Promise.all([
        apyService.getGlobalTally(),
        apyService.getMinerSplit(),
      ]);

      const details = await Promise.all(
        pools.map(async (pool) => {
          const apy = await apyService.calculateApy(
            pool.address,
            latestBlock,
            globalTally,
            minerSplit
          );
          return {
            poolAddress: pool.address,
            apy,
          };
        })
      );
      return { pool: details };
    } catch (error: any) {
      logger.error("Error fetching pool addresses", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getPools(
    limit: number = 10,
    cursor?: string,
    status: PoolStatus = PoolStatus.ALL,
    search?: string
  ): Promise<PoolListResponse> {
    try {
      const decodedCursor = decodeCursor(
        cursor,
        PAGINATION_CONSTANTS.MINERS_CURSOR_KEYS
      );

      const filters: PoolQueryFilters = { search, status };

      const [pools, matchingTotalCount, matchingActiveCount, latestBlock] =
        await Promise.all([
          stakingRepository.getAllPools(limit + 1, decodedCursor, filters),
          stakingRepository.countPools({ search }),
          stakingRepository.countPools({
            search,
            status: PoolStatus.ACTIVE,
          }),
          blockchainService.getLatestBlock(),
        ]);

      const inactivePoolsCount = matchingTotalCount - matchingActiveCount;

      if (!latestBlock) throw new Error("Could not fetch latest block");

      const [globalTally, minerSplit] = await Promise.all([
        apyService.getGlobalTally(),
        apyService.getMinerSplit(),
      ]);

      const details: PoolDetail[] = await Promise.all(
        pools.map(async (pool) => {
          const [apy, totalStakers] = await Promise.all([
            apyService.calculateApy(
              pool.address,
              latestBlock,
              globalTally,
              minerSplit
            ),
            blockchainService.getPoolTotalStakers(pool.address),
          ]);

          return {
            poolAddress: pool.address,
            name: pool.name || "",
            subtitle: pool.subtitle || "",
            status: pool.status as "active" | "inactive",
            tags: (pool.tags || []) as PoolTag[],
            apy,
            totalStakers: Number(totalStakers),
            totalStaked: apy.totalStaked,
          };
        })
      );

      const nextCursor = encodeCursor(
        pools,
        PAGINATION_CONSTANTS.MINERS_CURSOR_KEYS,
        limit
      );

      return {
        pools: details.slice(0, limit),
        nextCursor,
        totalPools: matchingTotalCount,
        activePoolsCount: matchingActiveCount,
        inactivePoolsCount,
      };
    } catch (error: any) {
      logger.error("Error fetching pools list", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getPoolDetail(
    poolAddress: string,
    options?: {
      latestBlock?: any;
      cutoffTimestamp?: number;
      globalTally?: any;
      minerSplit?: bigint;
    }
  ): Promise<PoolDetailResponse | null> {
    try {
      const pool = await stakingRepository.findPoolByAddress(poolAddress);
      if (!pool) return null;

      const latestBlock = options?.latestBlock
        ? options.latestBlock
        : await blockchainService.getLatestBlock();

      const [apy, totalStakers, totalStaked, totalAssets, firstSeenBlockData] =
        await Promise.all([
          apyService.calculateApy(
            pool.address,
            latestBlock,
            options?.globalTally,
            options?.minerSplit
          ),
          blockchainService.getPoolTotalStakers(pool.address),
          blockchainService.getPoolTotalStaked(pool.address),
          blockchainService.getPoolTotalAssets(pool.address),
          blockchainService.getBlock(pool.firstSeenBlock),
        ]);

      const firstSeenTimestamp = firstSeenBlockData
        ? firstSeenBlockData.timestamp
        : undefined;

      const finalYield =
        totalAssets > totalStaked ? totalAssets - totalStaked : 0n;

      const poolDetail: PoolDetail = {
        poolAddress: pool.address,
        name: pool.name || "",
        subtitle: pool.subtitle || "",
        status: pool.status as "active" | "inactive",
        tags: (pool.tags || []) as PoolTag[],
        apy,
        totalStakers: Number(totalStakers),
        totalStaked: ethers.formatEther(totalStaked),
      };

      return {
        ...poolDetail,
        totalYield: ethers.formatEther(finalYield),
        totalAssets: ethers.formatEther(totalAssets),
        firstSeenTimestamp,
      };
    } catch (error: any) {
      logger.error("Error fetching pool detail", {
        error: error.message,
        stack: error.stack,
        poolAddress,
      });
      throw error;
    }
  }

  private globalStatsCache: {
    data: any;
    timestamp: number;
  } | null = null;
  private readonly CACHE_TTL = 30 * 1000;

  public async getGlobalStats() {
    const now = Date.now();
    if (
      this.globalStatsCache &&
      now - this.globalStatsCache.timestamp < this.CACHE_TTL
    ) {
      return this.globalStatsCache.data;
    }

    try {
      const activeFilters = { status: PoolStatus.ACTIVE };

      const [
        { pool: details },
        epochStatus,
        totalPoolsCount,
        activePoolsCount,
      ] = await Promise.all([
        this.getPoolAddresses(activeFilters),
        this.getEpochStatus(),
        stakingRepository.countPools(),
        stakingRepository.countPools(activeFilters),
      ]);

      const inactivePoolsCount = totalPoolsCount - activePoolsCount;

      const { totalStaked, weightedApySum } = details.reduce(
        (acc, item) => {
          const stake = ethers.parseEther(item.apy.totalStaked);
          return {
            totalStaked: acc.totalStaked + stake,
            weightedApySum:
              acc.weightedApySum +
              BigInt(Math.round(item.apy.yearlyApy * 100)) * stake,
          };
        },
        { totalStaked: 0n, weightedApySum: 0n }
      );

      const avgApy =
        totalStaked > 0n ? Number(weightedApySum / totalStaked) / 100 : 0;

      const avgWeeklyApy = (avgApy * 7) / 365;

      const stats = {
        totalStaked: ethers.formatEther(totalStaked),
        weeklyApy: avgWeeklyApy,
        totalPoolsCount,
        activePoolsCount,
        inactivePoolsCount,
        epoch: epochStatus.currentEpoch,
        avgApy,
      };

      this.globalStatsCache = {
        data: stats,
        timestamp: now,
      };

      return stats;
    } catch (error: any) {
      logger.error("Error fetching global stats", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getRecentHistory(
    address: string,
    limit: number = 10,
    cursor?: string
  ) {
    try {
      const decodedCursor = decodeCursor(
        cursor,
        PAGINATION_CONSTANTS.HISTORY_CURSOR_KEYS
      );

      const activities = await stakingRepository.getUserRecentActivity(
        address,
        limit + 1,
        decodedCursor
      );

      const nextCursor = encodeCursor(
        activities,
        PAGINATION_CONSTANTS.HISTORY_CURSOR_KEYS,
        limit
      );

      const activityRows = activities.slice(0, limit);
      const activityRowsWithBalances = await Promise.all(
        activityRows.map(async (activity: any) => {
          const stakedBalanceAfterRaw = activity.stakedBalanceAfterRaw;
          let walletBalanceAfterRaw: string | null = null;

          try {
            walletBalanceAfterRaw = (
              await blockchainService.getNativeBalance(
                activity.stakerAddress,
                Number(activity.blockNumber)
              )
            ).toString();
          } catch (balanceError: any) {
            logger.warn("Unable to fetch wallet balance for activity", {
              stakerAddress: activity.stakerAddress,
              blockNumber: activity.blockNumber,
              txHash: activity.txHash,
              error: balanceError.message,
            });
          }

          return {
            ...activity,
            stakedBalanceAfterRaw,
            stakedBalanceAfter: ethers.formatEther(
              BigInt(stakedBalanceAfterRaw)
            ),
            balanceAfterRaw: walletBalanceAfterRaw,
            balanceAfter: walletBalanceAfterRaw
              ? ethers.formatEther(BigInt(walletBalanceAfterRaw))
              : null,
          };
        })
      );

      return {
        activities: activityRowsWithBalances,
        nextCursor,
      };
    } catch (error: any) {
      logger.error("Error fetching user recent activity", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
  public async getUserRewardsAcrossPools(address: string) {
    try {
      const userPools = await stakingRepository.findUniquePoolsByStaker(
        address
      );

      if (!userPools || userPools.length === 0) {
        return {
          totalPendingRewards: "0",
          pools: [],
        };
      }

      const { pool: uniquePoolsWithActivity } = await this.getPoolAddresses({
        addresses: userPools,
      });
      const rewardsResults = await Promise.allSettled(
        uniquePoolsWithActivity.map(async (item) => {
          const poolAddr = item.poolAddress;
          const [stakerYield, stakedAmount] = await Promise.all([
            blockchainService.getPoolStakerYield(poolAddr, address),
            blockchainService.getPoolStakerAmount(poolAddr, address),
          ]);

          return {
            poolAddress: poolAddr,
            pendingReward: ethers.formatEther(stakerYield),
            stakedAmount: ethers.formatEther(stakedAmount),
          };
        })
      );

      const failedReads = this.getRejectedReasons(rewardsResults);
      if (failedReads.length > 0) {
        logger.error("Failed to fetch complete user rewards", {
          stakerAddress: address,
          failures: failedReads,
        });
        throw new AppError(
          "Unable to fetch complete staking rewards. Please try again shortly.",
          503
        );
      }

      const pools = rewardsResults
        .filter(
          (res): res is PromiseFulfilledResult<any> =>
            res.status === "fulfilled" &&
            BigInt(ethers.parseEther(res.value.stakedAmount)) > 0n
        )
        .map((res: any) => res.value);

      const totalPendingRewards = pools.reduce(
        (acc, p) => acc + ethers.parseEther(p.pendingReward),
        0n
      );

      return {
        totalPendingRewards: ethers.formatEther(totalPendingRewards),
        pools,
      };
    } catch (error: any) {
      logger.error("Error fetching user rewards across pools", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getUserStakedPoolsHistory(
    stakerAddress: string,
    limit: number = 10,
    cursor?: string
  ) {
    try {
      const decodedCursor = decodeCursor(
        cursor,
        PAGINATION_CONSTANTS.ACTIVE_POOLS_CURSOR_KEYS
      );

      const uniquePoolsWithActivity =
        await stakingRepository.getUserStakedPoolsWithPagination(
          stakerAddress,
          limit + 1,
          decodedCursor
        );

      const [latestBlock, unbondingRequests] = await Promise.all([
        blockchainService.getLatestBlock(),
        blockchainService.getUnbondingRequests(stakerAddress),
      ]);
      if (!latestBlock) throw new Error("Could not fetch latest block");

      const [globalTally, minerSplit] = await Promise.all([
        apyService.getGlobalTally(),
        apyService.getMinerSplit(),
      ]);

      const historyResults = await Promise.allSettled(
        uniquePoolsWithActivity.map(async (item) => {
          const poolAddr = item.poolAddress;
          const [amount, apy, reward, poolData] = await Promise.all([
            blockchainService.getPoolStakerAmount(poolAddr, stakerAddress),
            apyService.calculateApy(
              poolAddr,
              latestBlock,
              globalTally,
              minerSplit
            ),
            blockchainService.getPoolStakerYield(poolAddr, stakerAddress),
            stakingRepository.findPoolByAddress(poolAddr),
          ]);

          const hasUnbonding = unbondingRequests.some(
            (r) =>
              r.pool.toLowerCase() === poolAddr.toLowerCase() && !r.isClaimed
          );

          if (amount === 0n && reward === 0n && !hasUnbonding) return null;

          const status = (poolData?.status || "inactive") as
            | "active"
            | "inactive";
          return {
            poolAddress: poolAddr,
            poolName: poolData?.name || "",
            poolSubtitle: poolData?.subtitle || "",
            stakedAmount: ethers.formatEther(amount),
            pendingReward: ethers.formatEther(reward),
            status,
            apy,
            lastActivityBlock: Number(item.lastActivityBlock),
          };
        })
      );

      const pools = historyResults
        .filter(
          (res): res is PromiseFulfilledResult<any> =>
            res.status === "fulfilled" && res.value !== null
        )
        .map((res) => res.value);

      const totalPendingRewards = pools.reduce(
        (acc, p) => acc + ethers.parseEther(p.pendingReward || "0"),
        0n
      );

      const nextCursor = encodeCursor(
        uniquePoolsWithActivity,
        PAGINATION_CONSTANTS.ACTIVE_POOLS_CURSOR_KEYS,
        limit
      );

      return {
        pools: pools.slice(0, limit),
        totalPendingRewards: ethers.formatEther(totalPendingRewards),
        nextCursor,
      };
    } catch (error: any) {
      logger.error("Error fetching user staked pools history", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
  public async getTopPools(limit: number = 4) {
    try {
      const pools = await stakingRepository.getAllPools();

      const [latestBlock, globalTally, minerSplit] = await Promise.all([
        blockchainService.getLatestBlock(),
        apyService.getGlobalTally(),
        apyService.getMinerSplit(),
      ]);

      const detailsWithRaw = await Promise.all(
        pools.map(async (pool) => {
          const detail = await this.getPoolDetail(pool.address, {
            latestBlock,
            globalTally,
            minerSplit,
          });
          if (!detail) return null;

          return {
            ...detail,
            totalStakedRaw: ethers.parseEther(detail.totalStaked),
          };
        })
      );

      return detailsWithRaw
        .filter(
          (d): d is Exclude<typeof d, null> =>
            d !== null && d.status === "active"
        )
        .sort((a, b) => (b.totalStakedRaw > a.totalStakedRaw ? 1 : -1))
        .slice(0, limit)
        .map(({ totalStakedRaw, ...rest }) => rest);
    } catch (error: any) {
      logger.error("Error fetching top pools", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  public async getUserPortfolioHistory(address: string, range: string = "7D") {
    try {
      const end = new Date();
      const start = new Date();
      const rangeMap: Record<
        string,
        {
          days?: number;
          months?: number;
          years?: number;
          granularity: "hour" | "day" | "month";
        }
      > = {
        "1D": { hours: 23, granularity: "hour" } as any,
        "7D": { days: 6, granularity: "day" },
        "1M": { days: 29, granularity: "day" },
        "3M": { months: 3, granularity: "day" },
        "1Y": { months: 11, granularity: "month" },
      };

      const config = rangeMap[range.toUpperCase()] || rangeMap["7D"];
      if ((config as any).hours)
        start.setUTCHours(start.getUTCHours() - (config as any).hours);
      if (config.days) start.setUTCDate(start.getUTCDate() - config.days);
      if (config.months) start.setUTCMonth(start.getUTCMonth() - config.months);
      if (config.years)
        start.setUTCFullYear(start.getUTCFullYear() - config.years);
      const granularity = config.granularity;

      const results = await stakingRepository.getPortfolioHistory(
        address,
        start,
        end,
        granularity
      );

      const history = results.map((h: any) => ({
        timestamp: h.timestamp,
        totalValue: h.totalValue,
      }));
      try {
        const { totalStaked } = await this.getStakerTotalStaked(address);
        const liveValue = totalStaked;

        if (Number(liveValue) > 0 || history.length > 0) {
          const liveTs = new Date();
          if (granularity === "hour") {
            liveTs.setUTCMinutes(0, 0, 0);
          } else if (granularity === "day") {
            liveTs.setUTCHours(0, 0, 0, 0);
          } else if (granularity === "month") {
            liveTs.setUTCDate(1);
            liveTs.setUTCHours(0, 0, 0, 0);
          }

          history.push({
            timestamp: liveTs,
            totalValue: liveValue,
          });
        }
      } catch (e: any) {
        logger.warn("Failed to append live point to portfolio history", {
          error: e.message,
        });
      }

      return {
        count: history.length,
        history,
      };
    } catch (error: any) {
      logger.error("Error fetching user portfolio history", {
        error: error.message,
        address,
        range,
      });
      throw error;
    }
  }

  public async getUserAssetAllocation(address: string) {
    try {
      const { totalStaked, pools } = await this.getStakerTotalStaked(address);
      const total = ethers.parseEther(totalStaked);

      if (total === 0n) {
        return { totalStaked, allocations: [] };
      }

      const allocations = await Promise.all(
        pools.map(async (pool) => {
          const amount = ethers.parseEther(pool.amount);
          const percentage = Number((amount * 10000n) / total) / 100;
          const poolData = await stakingRepository.findPoolByAddress(
            pool.poolAddress
          );
          return {
            poolAddress: pool.poolAddress,
            poolName: poolData?.name || "",
            amount: pool.amount,
            percentage,
          };
        })
      );

      return {
        totalStaked,
        allocations,
      };
    } catch (error: any) {
      logger.error("Error fetching user asset allocation", {
        error: error.message,
        address,
      });
      throw error;
    }
  }

  public async updatePoolMetadata(
    poolAddress: string,
    metadata: { name?: string; subtitle?: string }
  ) {
    try {
      await stakingRepository.updatePoolMetadata(poolAddress, metadata);
    } catch (error: any) {
      logger.error("Error updating pool metadata", {
        error: error.message,
        poolAddress,
      });
      throw error;
    }
  }

  public async checkWalletNonceRepair(stakerAddress: string) {
    if (!ethers.isAddress(stakerAddress)) {
      throw new AppError("Invalid staker address", 400);
    }

    const normalizedAddress = ethers.getAddress(stakerAddress);
    const openTransactions =
      await stakingRepository.findOpenUnresolvedTransactionsForStaker(
        normalizedAddress,
      );
    const repairCandidate = openTransactions
      .filter((tx) => {
        const hasRepairState =
          tx.repairStatus !== null && tx.repairStatus !== undefined;
        const hasRepairTrigger = ["stuck", "missing", "nonce_gap"].includes(
          tx.status,
        );

        return hasRepairState || hasRepairTrigger;
      })
      .sort((a, b) => {
        const priority = (tx: (typeof openTransactions)[number]) => {
          if (
            tx.repairStatus === "signature_required" &&
            Array.isArray(tx.repairTxPlan) &&
            tx.repairTxPlan.length > 0
          ) {
            return 0;
          }
          if (tx.repairStatus === "submitted") return 1;
          if (tx.repairStatus === "checking") return 2;
          if (tx.status === "nonce_gap") return 3;
          if (tx.status === "stuck") return 4;
          if (tx.status === "missing") return 5;
          return 6;
        };

        return priority(a) - priority(b);
      })[0];

    if (repairCandidate) {
      const readyForSignature =
        repairCandidate.repairStatus === "signature_required" &&
        Array.isArray(repairCandidate.repairTxPlan) &&
        repairCandidate.repairTxPlan.length > 0;

      if (
        readyForSignature ||
        repairCandidate.repairStatus === "checking" ||
        repairCandidate.repairStatus === "submitted"
      ) {
        return repairCandidate;
      }

      const checked = await transactionRecoveryService.checkTrackedNonceRepair(
        repairCandidate,
        "wallet_connect",
      );
      if (checked) return checked;
    }

    return await transactionRecoveryService.checkAddressNonceRepair(
      normalizedAddress,
    );
  }

  public async trackTransaction(data: {
    attemptId?: string | null;
    txHash: string;
    stakerAddress: string;
    poolAddress?: string | null;
    nonce?: number | null;
    action?: string | null;
    status?: "pending" | "stuck" | "missing" | "nonce_gap";
  }) {
    if (!ethers.isHexString(data.txHash, 32)) {
      throw new AppError("Invalid transaction hash", 400);
    }

    if (!ethers.isAddress(data.stakerAddress)) {
      throw new AppError("Invalid staker address", 400);
    }

    if (data.poolAddress && !ethers.isAddress(data.poolAddress)) {
      throw new AppError("Invalid pool address", 400);
    }

    const nonce =
      typeof data.nonce === "number" && Number.isFinite(data.nonce)
        ? data.nonce
        : null;

    const transaction = await stakingRepository.upsertUnresolvedTransaction({
      txHash: data.txHash,
      stakerAddress: data.stakerAddress,
      poolAddress: data.poolAddress ?? null,
      nonce,
      action: data.action ?? null,
      status: data.status ?? "pending",
    });

    void visibilityService
      .recordTransactionStatus({
        attemptId: data.attemptId,
        txHash: transaction.txHash,
        stakerAddress: transaction.stakerAddress,
        poolAddress: transaction.poolAddress,
        nonce: transaction.nonce,
        action: transaction.action,
        status: transaction.status,
        source: "api",
      })
      .catch((error: any) =>
        logger.warn("Failed to record visibility transaction status", {
          txHash: transaction.txHash,
          error: error.message,
        }),
      );

    if (data.status === "stuck") {
      transactionRecoveryService.scheduleNonceRepairCheck(
        transaction,
        "api_timeout",
      );
    }

    return transaction;
  }

  public async getTrackedTransaction(txHash: string) {
    if (!ethers.isHexString(txHash, 32)) {
      throw new AppError("Invalid transaction hash", 400);
    }

    return await stakingRepository.findUnresolvedTransaction(txHash);
  }

  public async trackTransactionRepair(
    txHash: string,
    data: {
      repairTxHashes: { nonce: number; hash: string; kind: string }[];
    },
  ) {
    if (!ethers.isHexString(txHash, 32)) {
      throw new AppError("Invalid transaction hash", 400);
    }

    const existing = await stakingRepository.findUnresolvedTransaction(txHash);
    if (!existing) {
      throw new AppError("Tracked transaction not found", 404);
    }

    const repairTxHashes = Array.isArray(data.repairTxHashes)
      ? data.repairTxHashes
      : [];

    if (repairTxHashes.length === 0) {
      throw new AppError("Missing repair transaction hashes", 400);
    }

    const normalized = repairTxHashes.map((tx) => {
      if (!ethers.isHexString(tx.hash, 32)) {
        throw new AppError("Invalid repair transaction hash", 400);
      }
      if (!Number.isInteger(tx.nonce) || tx.nonce < 0) {
        throw new AppError("Invalid repair transaction nonce", 400);
      }
      if (tx.kind !== "claim" && tx.kind !== "cancel") {
        throw new AppError("Invalid repair transaction kind", 400);
      }

      return {
        nonce: tx.nonce,
        hash: tx.hash.toLowerCase(),
        kind: tx.kind,
      };
    });

    await stakingRepository.updateUnresolvedTransaction(txHash, {
      repairStatus: "submitted",
      repairReason:
        "Connected wallet submitted nonce replacement transactions.",
      repairTxHashes: normalized,
      repairLastAttemptAt: new Date(),
      lastCheckedAt: new Date(),
    });

    return await stakingRepository.findUnresolvedTransaction(txHash);
  }
}

export default new StakingService();
export { StakingService };
