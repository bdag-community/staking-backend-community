import * as cron from "node-cron";
import { ethers } from "ethers";
import stakingRepository from "../repositories/staking.repository";
import logger from "../helpers/logger.helper";

class PortfolioWorker {
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning: boolean = false;

  async start(): Promise<void> {
    logger.info("Portfolio worker starting.");

    this.cronJob = cron.schedule("*/2 * * * *", async () => {
      await this.run();
    });

    this.run();

    logger.info("Portfolio worker scheduled to run every 2 minutes.");
  }

  private async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      logger.info("Starting sparse portfolio snapshot sync...");

      const now = new Date();
      now.setUTCMinutes(0, 0, 0);

      const lookback = new Date(Date.now() - 1 * 60 * 60 * 1000);
      const activeStakers =
        await stakingRepository.getRecentlyActiveStakers(lookback);

      if (activeStakers.length === 0) {
        logger.info("No recent activity found — skipping snapshot run.");
        return;
      }

      logger.info(
        `Found ${activeStakers.length} active stakers to snapshot. Recalculating balances...`,
      );

      const stakerBalances =
        await stakingRepository.getBalancesForStakers(activeStakers);

      const snapshots = stakerBalances.map(
        ({ stakerAddress, currentBalance }) => ({
          stakerAddress: stakerAddress.toLowerCase(),
          totalValue: ethers.formatEther(BigInt(currentBalance)),
          timestamp: now,
        }),
      );

      await stakingRepository.bulkCreatePortfolioHistory(snapshots);

      logger.info(
        `Portfolio snapshot sync completed — ${snapshots.length} active users updated.`,
      );
    } catch (error: any) {
      logger.error("Portfolio worker failed:", {
        error: error.message,
        stack: error.stack,
      });
    } finally {
      this.isRunning = false;
    }
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      logger.info("Portfolio worker stopped.");
    }
  }
}

const portfolioWorkerInstance = new PortfolioWorker();
export default portfolioWorkerInstance;
