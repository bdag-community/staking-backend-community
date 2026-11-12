import sequelize from "./db.model";
import config from "../config/app.config";
import logger from "../helpers/logger.helper";
import PoolAddress from "./poolAddress.model";
import IndexerState from "./indexerState.model";
import StakingActivity from "./stakingActivity.model";
import PortfolioHistory from "./portfolioHistory.model";
import UnresolvedTransaction from "./unresolvedTransaction.model";
import VisibilityActionAttempt from "./visibilityActionAttempt.model";
import VisibilityActionEvent from "./visibilityActionEvent.model";
import { ContractEvent } from "./contractEvent.model";
import { IndexedBlock } from "./indexedBlock.model";
import { Activation, Credential, CredentialPool, Epoch, GovernanceProposal, PoolEpochStat, PoolTerms, StrandedRepair, PoolRegistrationNonce } from "./governance.model";

const initDB = async (): Promise<void> => {
  try {
    await sequelize.authenticate();
    logger.info("Database connection established successfully.");

    // Create schema if it doesn't exist
    if (config.DB.SCHEMA && config.DB.SCHEMA !== "public") {
      logger.info(`Ensuring schema ${config.DB.SCHEMA} exists...`);
      try {
        await sequelize.createSchema(config.DB.SCHEMA, { logging: false });
        logger.info(`Schema ${config.DB.SCHEMA} created or already exists.`);
      } catch (error: any) {
        // Ignore if error is 'already exists'
        if (!error.message.includes("already exists")) {
          logger.warn(
            `Potential issue creating schema ${config.DB.SCHEMA}: ${error.message}`,
          );
        }
      }
    }

    // Sync models
    logger.info("Syncing database models...");
    await sequelize.sync({ alter: true });
    logger.info("Database models synced successfully.");
  } catch (error) {
    logger.error("Database initialization failed:", error);
    throw error;
  }
};

export {
  sequelize,
  PoolAddress,
  IndexerState,
  initDB,
  StakingActivity,
  PortfolioHistory,
  UnresolvedTransaction,
  VisibilityActionAttempt,
  VisibilityActionEvent,
  ContractEvent,
  IndexedBlock,
  Epoch,
  PoolEpochStat,
  Credential,
  CredentialPool,
  StrandedRepair,
  PoolTerms,
  PoolRegistrationNonce,
  GovernanceProposal,
  Activation,
};
