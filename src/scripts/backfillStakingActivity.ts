import "../helpers/ethers-fetch.helper";
import { initDB } from "../models/index.model";
import indexerInstance from "../workers/indexer.worker";
import logger from "../helpers/logger.helper";

const [fromArg, toArg] = process.argv.slice(2);
const fromBlock = Number(fromArg);
const toBlock = toArg === undefined ? fromBlock : Number(toArg);

async function backfillStakingActivity() {
  try {
    if (!Number.isInteger(fromBlock) || fromBlock < 0) {
      throw new Error(
        "Usage: npm run backfill:staking -- <fromBlock> [toBlock]",
      );
    }

    if (!Number.isInteger(toBlock) || toBlock < fromBlock) {
      throw new Error(
        "toBlock must be an integer greater than or equal to fromBlock",
      );
    }

    await initDB();
    logger.info(
      `Backfilling staking activity from block ${fromBlock} to ${toBlock}`,
    );
    await indexerInstance.indexStakingActivity(fromBlock, toBlock);
    logger.info("Staking activity backfill completed");
    process.exit(0);
  } catch (error: any) {
    logger.error("Staking activity backfill failed:", error);
    process.exit(1);
  }
}

backfillStakingActivity();
