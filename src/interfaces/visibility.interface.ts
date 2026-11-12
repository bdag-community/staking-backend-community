export type VisibilityAction =
  | "stake"
  | "unstakeRewards"
  | "claimRewards"
  | "unstakeStake"
  | "claimUnstakedStake";

export type VisibilityStage =
  | "started"
  | "simulation_succeeded"
  | "simulation_failed"
  | "wallet_rejected"
  | "tx_submitted"
  | "confirmation_pending"
  | "confirmed"
  | "reverted"
  | "failed"
  | "stuck"
  | "replaced";

export type VisibilityAttemptStatus =
  | "started"
  | "submitted"
  | "pending"
  | "confirmed"
  | "failed"
  | "reverted"
  | "stuck"
  | "replaced";

export interface VisibilityActionAttemptAttributes {
  attemptId: string;
  action: VisibilityAction;
  status: VisibilityAttemptStatus;
  success: boolean;
  stakerAddress?: string | null;
  poolAddress?: string | null;
  txHash?: string | null;
  amountRaw?: string | null;
  amountFormatted?: string | null;
  firstStageAt: Date;
  lastStageAt: Date;
  durationMs?: number | null;
  finalErrorCode?: string | null;
  finalErrorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface VisibilityActionEventAttributes {
  id?: number;
  attemptId: string;
  action: VisibilityAction;
  stage: VisibilityStage;
  success: boolean;
  stakerAddress?: string | null;
  poolAddress?: string | null;
  txHash?: string | null;
  amountRaw?: string | null;
  amountFormatted?: string | null;
  nonce?: number | null;
  blockNumber?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface VisibilityEventInput {
  attemptId?: string | null;
  action: string;
  stage: string;
  success?: boolean;
  stakerAddress?: string | null;
  poolAddress?: string | null;
  txHash?: string | null;
  amountRaw?: string | null;
  amountFormatted?: string | null;
  nonce?: number | null;
  blockNumber?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface VisibilityDateRange {
  from?: Date;
  to?: Date;
}
