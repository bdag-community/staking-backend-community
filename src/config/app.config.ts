import * as dotenv from "dotenv";

dotenv.config();

const getEnv = (key: string): string | undefined => process.env[key];
const getBigIntEnv = (key: string, fallback: string): bigint =>
  BigInt(getEnv(key) ?? fallback);

const config = {
  PORT: Number(getEnv("PORT")),
  RPC_URL: getEnv("RPC_URL") as string,
  STAKING_CONTRACT_ADDRESS: getEnv("STAKING_CONTRACT_ADDRESS") as string,
  EXPECTED_GENESIS_HASH: getEnv("EXPECTED_GENESIS_HASH"),
  STAKING_CONTRACTS_JSON: getEnv("STAKING_CONTRACTS_JSON"),
  GOVERNANCE_FIXTURE_MANIFEST_PATH: getEnv("GOVERNANCE_FIXTURE_MANIFEST_PATH"),
  GOVERNANCE_FIXTURE_MANIFEST_HASH: getEnv("GOVERNANCE_FIXTURE_MANIFEST_HASH"),
  CHAIN_TALLY_ADDRESS: getEnv("CHAIN_TALLY_ADDRESS") as string,
  INDEXER_CONFIRMATIONS: Number(getEnv("INDEXER_CONFIRMATIONS") ?? "64"),
  INDEXER_START_BLOCK: Number(getEnv("INDEXER_START_BLOCK") ?? "0"),
  INDEXER_START_BLOCK_HASH: getEnv("INDEXER_START_BLOCK_HASH"),
  INDEXER_REORG_HISTORY: Number(getEnv("INDEXER_REORG_HISTORY") ?? "200"),
  NETWORK_ID: getEnv("NETWORK_ID") as string,
  UNRESOLVED_TX_STUCK_MINUTES: Number(
    getEnv("UNRESOLVED_TX_STUCK_MINUTES") ?? "15",
  ),
  NONCE_REPAIR: {
    MIN_FEE_WEI: getBigIntEnv("STAKING_REPAIR_MIN_FEE_WEI", "500000000"),
    FEE_MULTIPLIER: getBigIntEnv("STAKING_REPAIR_FEE_MULTIPLIER", "2"),
    CLAIM_GAS_LIMIT: getBigIntEnv("STAKING_REPAIR_CLAIM_GAS", "500000"),
    CANCEL_GAS_LIMIT: getBigIntEnv("STAKING_REPAIR_CANCEL_GAS", "21000"),
  },
  SUBSIDY_REDUCTION_INTERVAL: BigInt(
    getEnv("SUBSIDY_REDUCTION_INTERVAL") ?? "604800",
  ),
  DB: {
    HOST: getEnv("DB_HOST") as string,
    USER: getEnv("DB_USER") as string,
    PASS: getEnv("DB_PASS") as string,
    NAME: getEnv("DB_NAME") as string,
    PORT: Number(getEnv("DB_PORT")),
    SCHEMA: getEnv("DB_SCHEMA") as string,
    SSL: getEnv("DB_SSL") as string,
  },
};

export default config;
