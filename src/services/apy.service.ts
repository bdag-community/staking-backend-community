import { ethers } from "ethers";
import config from "../config/app.config";
import { ApyResult } from "../interfaces/staking.interface";
import blockchainService from "./blockchain.service";
import logger from "../helpers/logger.helper";

const BLOCKS_PER_YEAR = 3600n * 24n * 365n;
const BLOCKS_PER_WEEK = 3600n * 24n * 7n;
const DEFAULT_MINER_SPLIT = 70n;
const MINER_SPLIT_CACHE_TTL_MS = 30 * 1000;

class ApyService {
  private minerSplitCache: { value: bigint; timestamp: number } | null = null;

  public async getGlobalTally(): Promise<{
    currentBaseHash: string;
    lastBaseHash: string;
  }> {
    const slotCurrentTallyBase = ethers.zeroPadValue("0x02", 32);
    const slotLastTallyBase = ethers.zeroPadValue("0x03", 32);

    const [currentBaseHash, lastBaseHash] = await Promise.all([
      blockchainService.getStorage(
        config.CHAIN_TALLY_ADDRESS,
        slotCurrentTallyBase,
      ),
      blockchainService.getStorage(
        config.CHAIN_TALLY_ADDRESS,
        slotLastTallyBase,
      ),
    ]);

    return { currentBaseHash, lastBaseHash };
  }

  /**
   * Miner share (percent) of block rewards, read from the staking contract's
   * minerSplit() (storage slot 1, the value the consensus engine uses). Cached
   * for a short TTL so a batch of APY calculations costs a single RPC read;
   * falls back to the last known value, or 70, if the read fails.
   */
  public async getMinerSplit(): Promise<bigint> {
    const now = Date.now();
    if (
      this.minerSplitCache &&
      now - this.minerSplitCache.timestamp < MINER_SPLIT_CACHE_TTL_MS
    ) {
      return this.minerSplitCache.value;
    }

    try {
      const value = await blockchainService.getMinerSplit();
      if (value > 100n) {
        throw new Error(`Unexpected minerSplit value: ${value.toString()}`);
      }
      this.minerSplitCache = { value, timestamp: now };
      return value;
    } catch (error: any) {
      const fallback = this.minerSplitCache?.value ?? DEFAULT_MINER_SPLIT;
      logger.warn("Failed to read minerSplit from contract, using fallback", {
        error: error.message,
        fallback: fallback.toString(),
      });
      return fallback;
    }
  }

  public async calculateApy(
    poolAddr: string,
    cachedBlock?: ethers.Block | null,
    cachedGlobalTally?: { currentBaseHash: string; lastBaseHash: string },
    cachedMinerSplit?: bigint,
  ): Promise<ApyResult> {
    try {
      const latestBlock =
        cachedBlock ?? (await blockchainService.getLatestBlock());
      if (!latestBlock) throw new Error("Could not fetch latest block");

      // Constants from Consensus
      const subsidyReductionInterval = config.SUBSIDY_REDUCTION_INTERVAL;
      const minerSplit = cachedMinerSplit ?? (await this.getMinerSplit());
      const stakerSplit = 100n - minerSplit;

      const [poolTotalAssets, poolTotalStaked, globalTally] = await Promise.all(
        [
          blockchainService.getPoolTotalAssets(poolAddr),
          blockchainService.getPoolTotalStaked(poolAddr),
          cachedGlobalTally ?? this.getGlobalTally(),
        ],
      );

      if (poolTotalAssets === 0n) {
        return {
          ...this.getDefaultApy(),
          totalStaked: ethers.formatEther(poolTotalStaked),
        };
      }

      const { currentBaseHash, lastBaseHash } = globalTally;
      const paddedPoolAddr = ethers.zeroPadValue(poolAddr, 32);

      const currentTallySlot = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "bytes32"],
          [paddedPoolAddr, currentBaseHash],
        ),
      );

      let currentTallyWei = 0n;
      if (currentBaseHash !== ethers.ZeroHash) {
        const hex = await blockchainService.getStorage(
          config.CHAIN_TALLY_ADDRESS,
          currentTallySlot,
        );
        currentTallyWei = ethers.toBigInt(hex || "0x0");
      }

      const lastTallySlot = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "bytes32"],
          [paddedPoolAddr, lastBaseHash],
        ),
      );

      let lastTallyWei = 0n;
      if (lastBaseHash !== ethers.ZeroHash) {
        const hex = await blockchainService.getStorage(
          config.CHAIN_TALLY_ADDRESS,
          lastTallySlot,
        );
        lastTallyWei = ethers.toBigInt(hex || "0x0");
      }

      const blocksInEpoch =
        BigInt(latestBlock.number) % subsidyReductionInterval;

      let sampleRewards = currentTallyWei;
      let sampleBlocks = blocksInEpoch;

      if (blocksInEpoch < 500n && lastTallyWei > 0n) {
        sampleRewards = lastTallyWei;
        sampleBlocks = subsidyReductionInterval;
      }

      if (sampleBlocks === 0n) sampleBlocks = 1n;

      const grossRewardPerBlock = sampleRewards / sampleBlocks;
      const stakerTotalRewardPerBlock =
        (grossRewardPerBlock * stakerSplit) / 100n;

      const yearlyYield = stakerTotalRewardPerBlock * BLOCKS_PER_YEAR;
      const weeklyYield = stakerTotalRewardPerBlock * BLOCKS_PER_WEEK;

      const totalApyBasisPoints = (yearlyYield * 10000n) / poolTotalAssets;
      const weeklyApyBasisPoints = (weeklyYield * 1000000n) / poolTotalAssets;

      return {
        yearlyApy: Number(totalApyBasisPoints) / 100,
        weeklyApy: Number(weeklyApyBasisPoints) / 10000,
        totalStaked: ethers.formatEther(poolTotalStaked),
        yearlyYield: ethers.formatEther(yearlyYield),
        weeklyYield: ethers.formatEther(weeklyYield),
      };
    } catch (error: any) {
      logger.error(`Error calculating APY for pool ${poolAddr}:`, {
        error: error.message,
        stack: error.stack,
      });
      return this.getDefaultApy();
    }
  }

  private getDefaultApy(): ApyResult {
    return {
      yearlyApy: 0,
      weeklyApy: 0,
      totalStaked: "0",
      yearlyYield: "0",
      weeklyYield: "0",
    };
  }
}

export default new ApyService();
