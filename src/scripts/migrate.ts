import { QueryInterface, DataTypes } from "sequelize";
import sequelize from "../models/db.model";
import config from "../config/app.config";
import logger from "../helpers/logger.helper";
import { PoolStatus } from "../constants/blockchain.constants";

async function migrate() {
  const queryInterface: QueryInterface = sequelize.getQueryInterface();
  const schema = config.DB.SCHEMA;

  try {
    logger.info(`Starting migration for schema: ${schema}`);

    // Create schema if it doesn't exist
    await sequelize.createSchema(schema, {
      logging: (msg) => logger.info(msg),
    });
    logger.info(`Schema ${schema} ensured.`);
  } catch (error: any) {
    if (error.message.includes("already exists")) {
      logger.info(`Schema ${schema} already exists.`);
    } else {
      logger.error(`Error creating schema ${schema}:`, error);
    }
  }

  const columnExists = async (table: string, column: string) => {
    try {
      const tableDesc = await queryInterface.describeTable({
        tableName: table,
        schema,
      });
      return !!tableDesc[column];
    } catch (e) {
      return false;
    }
  };

  try {
    await queryInterface.createTable(
      { tableName: "PoolAddresses", schema },
      {
        address: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true,
          primaryKey: true,
        },
        name: {
          type: DataTypes.STRING,
          allowNull: true,
        },
        subtitle: {
          type: DataTypes.STRING,
          allowNull: true,
        },
        firstSeenBlock: {
          type: DataTypes.INTEGER,
          allowNull: false,
        },
        lastSeenBlock: {
          type: DataTypes.INTEGER,
          allowNull: false,
        },
        lastSeenTimestamp: {
          type: DataTypes.INTEGER,
          allowNull: true,
        },
        status: {
          type: DataTypes.ENUM(PoolStatus.ACTIVE, PoolStatus.INACTIVE),
          allowNull: false,
          defaultValue: PoolStatus.INACTIVE,
        },
        tags: {
          type: DataTypes.JSON,
          allowNull: true,
          defaultValue: [],
        },
        tagsUpdatedAt: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        createdAt: {
          type: DataTypes.DATE,
          allowNull: false,
        },
        updatedAt: {
          type: DataTypes.DATE,
          allowNull: false,
        },
      },
      { logging: (msg) => logger.info(msg) }
    );
    logger.info("Table PoolAddresses ensured.");
  } catch (error: any) {
    if (error.message.includes("already exists")) {
      logger.info(
        "Table PoolAddresses already exists, checking for missing columns..."
      );

      const columnsToAdd = [
        { name: "name", type: DataTypes.STRING, allowNull: true },
        { name: "subtitle", type: DataTypes.STRING, allowNull: true },
        { name: "lastSeenTimestamp", type: DataTypes.INTEGER, allowNull: true },
        {
          name: "status",
          type: DataTypes.ENUM(PoolStatus.ACTIVE, PoolStatus.INACTIVE),
          allowNull: false,
          defaultValue: PoolStatus.INACTIVE,
        },
        {
          name: "tags",
          type: DataTypes.JSON,
          allowNull: true,
          defaultValue: [],
        },
        { name: "tagsUpdatedAt", type: DataTypes.DATE, allowNull: true },
      ];

      for (const col of columnsToAdd) {
        if (!(await columnExists("PoolAddresses", col.name))) {
          logger.info(`Adding column ${col.name} to PoolAddresses...`);
          await queryInterface.addColumn(
            { tableName: "PoolAddresses", schema },
            col.name,
            col as any
          );
        }
      }
    } else {
      logger.error("Error ensuring table PoolAddresses:", error);
    }
  }

  try {
    await queryInterface.createTable(
      { tableName: "StakingActivities", schema },
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        txHash: { type: DataTypes.STRING, allowNull: false },
        blockNumber: { type: DataTypes.INTEGER, allowNull: false },
        timestamp: { type: DataTypes.DATE, allowNull: false },
        logIndex: { type: DataTypes.INTEGER, allowNull: false },
        eventType: { type: DataTypes.STRING, allowNull: false },
        stakerAddress: { type: DataTypes.STRING, allowNull: false },
        poolAddress: { type: DataTypes.STRING, allowNull: false },
        fromPoolAddress: { type: DataTypes.STRING, allowNull: true },
        toPoolAddress: { type: DataTypes.STRING, allowNull: true },
        amount: { type: DataTypes.STRING, allowNull: false },
        rawAmount: { type: DataTypes.STRING, allowNull: false },
        unbondingPayout: { type: DataTypes.STRING, allowNull: true },
        unbondingPayoutRaw: { type: DataTypes.STRING, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      { logging: (msg) => logger.info(msg) }
    );
    logger.info("Table StakingActivities ensured.");
  } catch (error: any) {
    if (!error.message.includes("already exists")) {
      logger.error("Error ensuring table StakingActivities:", error);
    }
  }

  try {
    // PortfolioHistories table
    await queryInterface.createTable(
      { tableName: "PortfolioHistories", schema },
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        stakerAddress: { type: DataTypes.STRING, allowNull: false },
        totalValue: { type: DataTypes.STRING, allowNull: false },
        timestamp: { type: DataTypes.DATE, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      { logging: (msg) => logger.info(msg) }
    );
    logger.info("Table PortfolioHistories ensured.");
  } catch (error: any) {
    if (!error.message.includes("already exists")) {
      logger.error("Error ensuring table PortfolioHistories:", error);
    }
  }

  try {
    await queryInterface.createTable(
      { tableName: "IndexerStates", schema },
      {
        key: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true,
          primaryKey: true,
        },
        lastBlock: {
          type: DataTypes.INTEGER,
          defaultValue: 0,
        },
        createdAt: {
          type: DataTypes.DATE,
          allowNull: false,
        },
        updatedAt: {
          type: DataTypes.DATE,
          allowNull: false,
        },
      },
      { logging: (msg) => logger.info(msg) }
    );
    logger.info("Table IndexerStates ensured.");
  } catch (error: any) {
    if (!error.message.includes("already exists")) {
      logger.error("Error ensuring table IndexerStates:", error);
    }
  }

  try {
    await queryInterface.createTable(
      { tableName: "UnresolvedTransactions", schema },
      {
        txHash: {
          type: DataTypes.STRING,
          allowNull: false,
          primaryKey: true,
        },
        stakerAddress: { type: DataTypes.STRING, allowNull: false },
        poolAddress: { type: DataTypes.STRING, allowNull: true },
        nonce: { type: DataTypes.INTEGER, allowNull: true },
        action: { type: DataTypes.STRING, allowNull: true },
        status: {
          type: DataTypes.STRING,
          allowNull: false,
          defaultValue: "pending",
        },
        blockNumber: { type: DataTypes.INTEGER, allowNull: true },
        receiptStatus: { type: DataTypes.STRING, allowNull: true },
        chainNonce: { type: DataTypes.INTEGER, allowNull: true },
        pendingNonce: { type: DataTypes.INTEGER, allowNull: true },
        gapFromNonce: { type: DataTypes.INTEGER, allowNull: true },
        repairStatus: { type: DataTypes.STRING, allowNull: true },
        repairReason: { type: DataTypes.TEXT, allowNull: true },
        repairTxPlan: { type: DataTypes.JSON, allowNull: true },
        repairTxHashes: { type: DataTypes.JSON, allowNull: true },
        repairNonceStart: { type: DataTypes.INTEGER, allowNull: true },
        repairNonceEnd: { type: DataTypes.INTEGER, allowNull: true },
        repairLastAttemptAt: { type: DataTypes.DATE, allowNull: true },
        firstSeenAt: { type: DataTypes.DATE, allowNull: false },
        lastCheckedAt: { type: DataTypes.DATE, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      { logging: (msg) => logger.info(msg) }
    );
    logger.info("Table UnresolvedTransactions ensured.");
  } catch (error: any) {
    if (error.message.includes("already exists")) {
      logger.info(
        "Table UnresolvedTransactions already exists, checking for missing columns..."
      );

      const columnsToAdd = [
        { name: "poolAddress", type: DataTypes.STRING, allowNull: true },
        { name: "nonce", type: DataTypes.INTEGER, allowNull: true },
        { name: "action", type: DataTypes.STRING, allowNull: true },
        {
          name: "status",
          type: DataTypes.STRING,
          allowNull: false,
          defaultValue: "pending",
        },
        { name: "blockNumber", type: DataTypes.INTEGER, allowNull: true },
        { name: "receiptStatus", type: DataTypes.STRING, allowNull: true },
        { name: "chainNonce", type: DataTypes.INTEGER, allowNull: true },
        { name: "pendingNonce", type: DataTypes.INTEGER, allowNull: true },
        { name: "gapFromNonce", type: DataTypes.INTEGER, allowNull: true },
        { name: "repairStatus", type: DataTypes.STRING, allowNull: true },
        { name: "repairReason", type: DataTypes.TEXT, allowNull: true },
        { name: "repairTxPlan", type: DataTypes.JSON, allowNull: true },
        { name: "repairTxHashes", type: DataTypes.JSON, allowNull: true },
        { name: "repairNonceStart", type: DataTypes.INTEGER, allowNull: true },
        { name: "repairNonceEnd", type: DataTypes.INTEGER, allowNull: true },
        { name: "repairLastAttemptAt", type: DataTypes.DATE, allowNull: true },
        { name: "firstSeenAt", type: DataTypes.DATE, allowNull: false },
        { name: "lastCheckedAt", type: DataTypes.DATE, allowNull: true },
      ];

      for (const col of columnsToAdd) {
        if (!(await columnExists("UnresolvedTransactions", col.name))) {
          logger.info(`Adding column ${col.name} to UnresolvedTransactions...`);
          await queryInterface.addColumn(
            { tableName: "UnresolvedTransactions", schema },
            col.name,
            col as any
          );
        }
      }
    } else {
      logger.error("Error ensuring table UnresolvedTransactions:", error);
    }
  }

  try {
    await queryInterface.createTable(
      { tableName: "VisibilityActionAttempts", schema },
      {
        attemptId: {
          type: DataTypes.STRING,
          allowNull: false,
          primaryKey: true,
        },
        action: { type: DataTypes.STRING, allowNull: false },
        status: {
          type: DataTypes.STRING,
          allowNull: false,
          defaultValue: "started",
        },
        success: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        stakerAddress: { type: DataTypes.STRING, allowNull: true },
        poolAddress: { type: DataTypes.STRING, allowNull: true },
        txHash: { type: DataTypes.STRING, allowNull: true },
        amountRaw: { type: DataTypes.STRING, allowNull: true },
        amountFormatted: { type: DataTypes.STRING, allowNull: true },
        firstStageAt: { type: DataTypes.DATE, allowNull: false },
        lastStageAt: { type: DataTypes.DATE, allowNull: false },
        durationMs: { type: DataTypes.INTEGER, allowNull: true },
        finalErrorCode: { type: DataTypes.STRING, allowNull: true },
        finalErrorMessage: { type: DataTypes.TEXT, allowNull: true },
        metadata: { type: DataTypes.JSON, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      { logging: (msg) => logger.info(msg) },
    );
    logger.info("Table VisibilityActionAttempts ensured.");
  } catch (error: any) {
    if (error.message.includes("already exists")) {
      logger.info(
        "Table VisibilityActionAttempts already exists, checking for missing columns...",
      );

      const columnsToAdd = [
        { name: "status", type: DataTypes.STRING, allowNull: false, defaultValue: "started" },
        { name: "success", type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        { name: "stakerAddress", type: DataTypes.STRING, allowNull: true },
        { name: "poolAddress", type: DataTypes.STRING, allowNull: true },
        { name: "txHash", type: DataTypes.STRING, allowNull: true },
        { name: "amountRaw", type: DataTypes.STRING, allowNull: true },
        { name: "amountFormatted", type: DataTypes.STRING, allowNull: true },
        { name: "durationMs", type: DataTypes.INTEGER, allowNull: true },
        { name: "finalErrorCode", type: DataTypes.STRING, allowNull: true },
        { name: "finalErrorMessage", type: DataTypes.TEXT, allowNull: true },
        { name: "metadata", type: DataTypes.JSON, allowNull: true },
      ];

      for (const col of columnsToAdd) {
        if (!(await columnExists("VisibilityActionAttempts", col.name))) {
          logger.info(`Adding column ${col.name} to VisibilityActionAttempts...`);
          await queryInterface.addColumn(
            { tableName: "VisibilityActionAttempts", schema },
            col.name,
            col as any,
          );
        }
      }
    } else {
      logger.error("Error ensuring table VisibilityActionAttempts:", error);
    }
  }

  try {
    await queryInterface.createTable(
      { tableName: "VisibilityActionEvents", schema },
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        attemptId: { type: DataTypes.STRING, allowNull: false },
        action: { type: DataTypes.STRING, allowNull: false },
        stage: { type: DataTypes.STRING, allowNull: false },
        success: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        stakerAddress: { type: DataTypes.STRING, allowNull: true },
        poolAddress: { type: DataTypes.STRING, allowNull: true },
        txHash: { type: DataTypes.STRING, allowNull: true },
        amountRaw: { type: DataTypes.STRING, allowNull: true },
        amountFormatted: { type: DataTypes.STRING, allowNull: true },
        nonce: { type: DataTypes.INTEGER, allowNull: true },
        blockNumber: { type: DataTypes.INTEGER, allowNull: true },
        durationMs: { type: DataTypes.INTEGER, allowNull: true },
        errorCode: { type: DataTypes.STRING, allowNull: true },
        errorMessage: { type: DataTypes.TEXT, allowNull: true },
        metadata: { type: DataTypes.JSON, allowNull: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      { logging: (msg) => logger.info(msg) },
    );
    logger.info("Table VisibilityActionEvents ensured.");
  } catch (error: any) {
    if (!error.message.includes("already exists")) {
      logger.error("Error ensuring table VisibilityActionEvents:", error);
    }
  }

  logger.info("Migration completed.");
  process.exit(0);
}

migrate().catch((error) => {
  logger.error("Migration failed:", error);
  process.exit(1);
});
