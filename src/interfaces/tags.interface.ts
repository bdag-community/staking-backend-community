export interface PoolMetrics {
  address: string;
  weeklyApy: number;
  lastSeenTimestamp?: number;
  currentDayNetInflow: bigint;
  totalStakedVolume: bigint;
}
