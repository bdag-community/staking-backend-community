import { initDB, IndexerState } from "../models/index.model";
import logger from "../helpers/logger.helper";
import stakingRepository from "../repositories/staking.repository";
import blockchainService from "../services/blockchain.service";
import { ethers } from "ethers";

async function resyncPortfolio() {
  try {
    const args = process.argv.slice(2);
    const manualStartBlock = args[0] ? Number(args[0]) : null;

    logger.info("Starting portfolio history resync...");
    await initDB();

    let startTime: Date;

    if (manualStartBlock !== null) {
      logger.info(
        `Fetching timestamp for manual start block: ${manualStartBlock}`,
      );
      const block = await blockchainService.getBlock(manualStartBlock);
      if (!block) {
        throw new Error(`Could not fetch block ${manualStartBlock}`);
      }
      startTime = new Date(Number(block.timestamp) * 1000);
    } else {
      const earliestActivity = await IndexerState.sequelize!.query(
        'SELECT MIN("timestamp") as "minTs" FROM ' +
          stakingRepository.getStakingActivityTableName(),
        { type: "SELECT" as any },
      );

      const minTs = (earliestActivity[0] as any)?.minTs;
      startTime = minTs ? new Date(minTs) : new Date("2024-01-01T00:00:00Z");
    }

    startTime.setUTCMinutes(0, 0, 0);

    const endTime = new Date();
    endTime.setUTCMinutes(0, 0, 0);

    logger.info(
      `Resyncing from ${startTime.toISOString()} to ${endTime.toISOString()}`,
    );

    const stakers = await stakingRepository.getUniqueStakers();
    logger.info(`Found ${stakers.length} stakers to process.`);

    await stakingRepository.truncatePortfolioHistory();
    logger.info("Existing portfolio history truncated.");

    const CONCURRENCY = 100;
    let stakerIndex = 0;

    async function processWorker(workerId: number) {
      while (stakerIndex < stakers.length) {
        const index = stakerIndex++;
        const staker = stakers[index];
        if (!staker) break;

        try {
          const activities =
            await stakingRepository.getAllStakerActivities(staker);
          const snapshots: any[] = [];

          const parsedActivities = activities.map((a) => ({
            time: new Date(a.timestamp).getTime(),
            amount: BigInt(a.rawAmount),
            type: a.eventType,
          }));

          let currentBalance = 0n;
          let activityIndex = 0;

          const startTimeMs = startTime.getTime();
          const endTimeMs = endTime.getTime();
          const HOUR_MS = 3600 * 1000;

          for (
            let currentMs = startTimeMs;
            currentMs <= endTimeMs;
            currentMs += HOUR_MS
          ) {
            let activityInHour = false;
            while (
              activityIndex < parsedActivities.length &&
              parsedActivities[activityIndex].time <= currentMs
            ) {
              const activity = parsedActivities[activityIndex];
              if (activity.type === "Staked") {
                currentBalance += activity.amount;
              } else if (activity.type === "Unstaked") {
                currentBalance -= activity.amount;
                if (currentBalance < 0n) currentBalance = 0n;
              }
              activityInHour = true;
              activityIndex++;
            }

            if (
              activityInHour ||
              (currentMs === startTimeMs && currentBalance > 0n)
            ) {
              snapshots.push({
                stakerAddress: staker.toLowerCase(),
                totalValue: ethers.formatEther(currentBalance),
                timestamp: new Date(currentMs),
              });
            }
          }

          if (snapshots.length > 0) {
            await stakingRepository.bulkCreatePortfolioHistory(snapshots);
          }
          logger.info(
            `[Worker ${workerId}] Processed staker ${index + 1}/${
              stakers.length
            }: ${staker} (${snapshots.length} units)`,
          );
        } catch (err: any) {
          logger.error(
            `[Worker ${workerId}] Error processing staker ${staker}:`,
            err.message,
          );
        }
      }
    }

    const workerPromises: Promise<void>[] = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workerPromises.push(processWorker(i));
    }

    await Promise.all(workerPromises);

    logger.info("Portfolio history resync completed successfully.");
    process.exit(0);
  } catch (error) {
    logger.error("Portfolio resync failed:", error);
    process.exit(1);
  }
}

resyncPortfolio();
