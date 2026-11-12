import stakingRepository from "../repositories/staking.repository";
import blockchainService from "./blockchain.service";
import apyService from "./apy.service";
import logger from "../helpers/logger.helper";
import { PoolTag } from "../interfaces/staking.interface";
import { BLOCKCHAIN_CONSTANTS } from "../constants";
import { PoolMetrics } from "../interfaces/tags.interface";
import { ONE_DAY_MS } from "../constants/tags.constant";
import { PoolStatus } from "../constants/blockchain.constants";

class PoolTagsService {
  public async recalculateAllTags(): Promise<void> {
    try {
      logger.info("Starting pool tags recalculation...");

      const pools = await stakingRepository.getAllPools();
      if (!pools.length) return;

      const latestBlock = await blockchainService.getLatestBlock();
      const nowTs = latestBlock?.timestamp
        ? Number(latestBlock.timestamp) * 1000
        : Date.now();

      const currentDayStart = new Date(nowTs - ONE_DAY_MS);
      const activityCutoff =
        Math.floor(nowTs / 1000) -
        BLOCKCHAIN_CONSTANTS.ACTIVE_POOL_WINDOW_HOURS * 3600;

      const [currentVolumes, unstakeRatios] = await Promise.all([
        stakingRepository.getGlobalPoolVolumes(
          currentDayStart,
          new Date(nowTs)
        ),
        stakingRepository.getGlobalPoolUnstakeRatios(),
      ]);

      const metricsResults = await Promise.allSettled(
        pools.map(async (pool): Promise<PoolMetrics> => {
          const addr = pool.address.toLowerCase();
          const apy = await apyService.calculateApy(addr, latestBlock!);

          const currentVol = currentVolumes[addr];
          const ratios = unstakeRatios[addr];

          return {
            address: pool.address,
            weeklyApy: apy.weeklyApy,
            lastSeenTimestamp: pool.lastSeenTimestamp,
            currentDayNetInflow:
              BigInt(currentVol?.stakedVolume || 0) -
              BigInt(currentVol?.unstakedVolume || 0),
            totalStakedVolume: BigInt(ratios?.totalStaked || 0),
          };
        })
      );

      let maxApy = 0;
      let maxInflow = 0n;
      let maxStaked = 0n;
      const metricsMap = new Map<string, PoolMetrics>();

      metricsResults.forEach((res) => {
        if (res.status === "fulfilled") {
          const m = res.value;
          metricsMap.set(m.address, m);

          const isActive =
            m.lastSeenTimestamp && m.lastSeenTimestamp >= activityCutoff;

          if (isActive) {
            if (m.weeklyApy > maxApy) maxApy = m.weeklyApy;
            if (m.currentDayNetInflow > maxInflow)
              maxInflow = m.currentDayNetInflow;
            if (m.totalStakedVolume > maxStaked)
              maxStaked = m.totalStakedVolume;
          }
        }
      });

      const context = { maxApy, maxInflow, maxStaked, activityCutoff };
      let activeCount = 0;
      let inactiveCount = 0;

      const updatePromises = pools.map(async (pool) => {
        const metrics = metricsMap.get(pool.address);

        const isActive =
          !!metrics?.lastSeenTimestamp &&
          metrics.lastSeenTimestamp >= activityCutoff;
        const status = isActive ? PoolStatus.ACTIVE : PoolStatus.INACTIVE;

        const tags =
          isActive && metrics ? this.getPoolTags(metrics, context) : [];

        if (isActive) {
          activeCount++;
        } else {
          inactiveCount++;
        }

        return stakingRepository.updatePoolTags(pool.address, tags, status);
      });

      await Promise.all(updatePromises);
      logger.info(
        `Pool tags recalculated: ${activeCount} active pools updated, ${inactiveCount} inactive pools cleared tags.`
      );
    } catch (error: any) {
      logger.error("Error recalculating pool tags", { error: error.message });
      throw error;
    }
  }

  private getPoolTags(
    metrics: PoolMetrics,
    winners: {
      maxApy: number;
      maxInflow: bigint;
      maxStaked: bigint;
      activityCutoff: number;
    }
  ): string[] {
    const tags: string[] = [];
    const { maxApy, maxInflow, maxStaked, activityCutoff } = winners;

    // Strict check: only active pools get tags
    const isActive =
      !!metrics.lastSeenTimestamp &&
      metrics.lastSeenTimestamp >= activityCutoff;

    if (!isActive) return [];

    if (metrics.weeklyApy > 0 && metrics.weeklyApy === maxApy) {
      tags.push(PoolTag.FAST_HARVEST);
    }

    if (
      metrics.currentDayNetInflow > 0n &&
      metrics.currentDayNetInflow === maxInflow
    ) {
      tags.push(PoolTag.TRENDING);
    }

    if (
      metrics.totalStakedVolume > 0n &&
      metrics.totalStakedVolume === maxStaked
    ) {
      tags.push(PoolTag.HIGH_STABILITY);
    }

    return tags;
  }
}

export default new PoolTagsService();
