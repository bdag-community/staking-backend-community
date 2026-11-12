import { PoolStatus } from "../constants/blockchain.constants";

export interface ApyResult {
  yearlyApy: number;
  weeklyApy: number;
  totalStaked: string;
  yearlyYield: string;
  weeklyYield: string;
}

export interface StakerPoolDetail {
  poolAddress: string;
  amount: string;
  weeklyEarnings?: string;
  unbondingAmount?: string;
}

export interface StakerTotalStakedResponse {
  totalStaked: string;
  weeklyEarnings: string;
  totalClaimedAmount: string;
  rewardsClaimed: string;
  stakedFundsReclaimed: string;
  totalUnbonding: string;
  pools: StakerPoolDetail[];
}

export interface StakingActivityAttributes {
  txHash: string;
  blockNumber: number;
  timestamp: number;
  eventType:
    | "Staked"
    | "Unstaked"
    | "StakeClaimed"
    | "StakeReallocated"
    | "Redelegated";
  stakerAddress: string;
  poolAddress: string;
  fromPoolAddress?: string;
  toPoolAddress?: string;
  amount: string;
  rawAmount: string;
  unbondingPayout?: string;
  unbondingPayoutRaw?: string;
  logIndex: number;
  contractVersion: string;
}

export interface UnresolvedTransactionAttributes {
  txHash: string;
  stakerAddress: string;
  poolAddress?: string | null;
  nonce?: number | null;
  action?: string | null;
  status:
    | "pending"
    | "stuck"
    | "missing"
    | "nonce_gap"
    | "replaced"
    | "confirmed"
    | "reverted";
  blockNumber?: number | null;
  receiptStatus?: string | null;
  chainNonce?: number | null;
  pendingNonce?: number | null;
  gapFromNonce?: number | null;
  repairStatus?:
    | "checking"
    | "not_needed"
    | "skipped"
    | "unavailable"
    | "signature_required"
    | "submitted"
    | "confirmed"
    | "failed"
    | null;
  repairReason?: string | null;
  repairTxPlan?:
    | {
        nonce: number;
        kind: "claim" | "cancel";
        to: string;
        data: string;
        value: string;
        gasLimit: string;
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
      }[]
    | null;
  repairTxHashes?: { nonce: number; hash: string; kind: string }[] | null;
  repairNonceStart?: number | null;
  repairNonceEnd?: number | null;
  repairLastAttemptAt?: Date | null;
  firstSeenAt: Date;
  lastCheckedAt?: Date | null;
}

export enum PoolTag {
  FAST_HARVEST = "fast harvest",
  TRENDING = "trending",
  FOUNDATION = "foundation",
  HIGH_STABILITY = "high stability",
}

export interface PoolQueryFilters {
  search?: string;
  minLastSeenTimestamp?: number;
  maxLastSeenTimestamp?: number;
  addresses?: string[];
  status?: PoolStatus;
}

export interface PoolDetail {
  poolAddress: string;
  name: string;
  subtitle: string;
  status: "active" | "inactive";
  tags: PoolTag[];
  apy: ApyResult;
  totalStakers: number;
  totalStaked: string;
}

export interface PoolListResponse {
  pools: PoolDetail[];
  nextCursor: string | null;
  totalPools: number;
  activePoolsCount: number;
  inactivePoolsCount: number;
}

export interface PoolDetailResponse extends PoolDetail {
  totalYield: string;
  totalAssets: string;
  firstSeenTimestamp?: number;
}

export interface ContractInfo {
  address: string;
  chainId: number;
  version: string;
  minStake: string;
  minStakeBdag: string;
  minerSplit: number;
  stakerSplit: number;
  implementation: string;
  v2ActivatedAt: number;
  genesisTime: number;
}
