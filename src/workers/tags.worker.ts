import poolTagsService from "../services/poolTags.service";
import logger from "../helpers/logger.helper";
import * as cron from "node-cron";

class TagsWorker {
  private cronJob: cron.ScheduledTask | null = null;

  async start(): Promise<void> {
    logger.info("Tags worker starting — running initial tag recalculation...");

    await this.run();

    this.cronJob = cron.schedule("30 * * * *", async () => {
      await this.run();
    });

    logger.info(
      `Tags worker scheduled to run at the 30th minute of every hour.`,
    );
  }

  private async run(): Promise<void> {
    try {
      await poolTagsService.recalculateAllTags();
    } catch (error: any) {
      logger.error("Tags worker failed:", {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      logger.info("Tags worker stopped.");
    }
  }
}

const tagsWorkerInstance = new TagsWorker();
export default tagsWorkerInstance;
