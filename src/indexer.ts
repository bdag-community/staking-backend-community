import "./helpers/ethers-fetch.helper";
import { initDB } from "./models/index.model";
import logger from "./helpers/logger.helper";
import indexer from "./workers/indexer.worker";

const startIndexer = async () => {
  try {
    logger.info("Starting Indexer Worker...");
    await initDB();
    await indexer.start();
    logger.info("Indexer Worker initialized");
  } catch (err) {
    logger.error("Indexer Worker failed to start:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

startIndexer();
