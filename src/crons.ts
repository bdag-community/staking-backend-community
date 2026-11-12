import { initDB } from "./models/index.model";
import logger from "./helpers/logger.helper";
import tagsWorker from "./workers/tags.worker";
import portfolioWorker from "./workers/portfolio.worker";

const startCrons = async () => {
  try {
    await initDB();
    const results = await Promise.allSettled([
      tagsWorker.start(),
      portfolioWorker.start(),
    ]);
    logger.info("Cron Workers initialized");

    results.forEach((res, i) => {
      const name = i === 0 ? "tagsWorker" : "portfolioWorker";

      if (res.status === "rejected") {
        logger.error(`${name} failed`, res.reason);
      } else {
        logger.info(`${name} started`);
      }
    });
  } catch (err) {
    logger.error("Cron Worker failed to start:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

startCrons();
