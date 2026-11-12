import { ethers } from "ethers";
import { randomUUID } from "crypto";
import { AppError } from "../helpers/appError.helper";
import logger from "../helpers/logger.helper";
import visibilityRepository from "../repositories/visibility.repository";
import stakingRepository from "../repositories/staking.repository";
import blockchainService from "./blockchain.service";
import {
  VisibilityAction,
  VisibilityAttemptStatus,
  VisibilityDateRange,
  VisibilityEventInput,
  VisibilityStage,
} from "../interfaces/visibility.interface";

const ACTIONS = new Set<VisibilityAction>([
  "stake",
  "unstakeRewards",
  "claimRewards",
  "unstakeStake",
  "claimUnstakedStake",
]);

const STAGES = new Set<VisibilityStage>([
  "started",
  "simulation_succeeded",
  "simulation_failed",
  "wallet_rejected",
  "tx_submitted",
  "confirmation_pending",
  "confirmed",
  "reverted",
  "failed",
  "stuck",
  "replaced",
]);

class VisibilityService {
  private normalizeAction(action: string): VisibilityAction {
    const aliases: Record<string, VisibilityAction> = {
      unstake: "unstakeRewards",
      claim: "claimRewards",
      claimStake: "claimUnstakedStake",
    };

    const normalized = aliases[action] ?? action;
    if (!ACTIONS.has(normalized as VisibilityAction)) {
      throw new AppError(`Invalid visibility action: ${action}`, 400);
    }

    return normalized as VisibilityAction;
  }

  private normalizeStage(stage: string): VisibilityStage {
    if (!STAGES.has(stage as VisibilityStage)) {
      throw new AppError(`Invalid visibility stage: ${stage}`, 400);
    }

    return stage as VisibilityStage;
  }

  private statusFromStage(stage: VisibilityStage): VisibilityAttemptStatus {
    switch (stage) {
      case "tx_submitted":
        return "submitted";
      case "confirmation_pending":
        return "pending";
      case "confirmed":
        return "confirmed";
      case "replaced":
        return "replaced";
      case "reverted":
        return "reverted";
      case "stuck":
        return "stuck";
      case "simulation_failed":
      case "wallet_rejected":
      case "failed":
        return "failed";
      case "started":
      case "simulation_succeeded":
      default:
        return "started";
    }
  }

  private inferSuccess(stage: VisibilityStage, success?: boolean): boolean {
    if (typeof success === "boolean") return success;
    return ["started", "simulation_succeeded", "tx_submitted", "confirmed", "replaced"].includes(stage);
  }

  private sanitizeNullableString(value?: string | null): string | null {
    if (!value || typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private validateAddress(value: string | null, label: string) {
    if (value && !ethers.isAddress(value)) {
      throw new AppError(`Invalid ${label}`, 400);
    }
  }

  private validateTxHash(value: string | null) {
    if (value && !ethers.isHexString(value, 32)) {
      throw new AppError("Invalid transaction hash", 400);
    }
  }

  private async resolveAttemptId(
    inputAttemptId: string | null,
    txHash: string | null,
  ): Promise<string> {
    if (inputAttemptId) return inputAttemptId;

    if (txHash) {
      const existing = await visibilityRepository.findAttemptByTxHash(txHash);
      if (existing) return existing.attemptId;
      return `tx:${txHash.toLowerCase()}`;
    }

    return `evt:${randomUUID()}`;
  }

  private parseDate(value: unknown, fallback?: Date): Date | undefined {
    if (!value || typeof value !== "string") return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }

  public getDateRange(query: Record<string, any>): VisibilityDateRange {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    return {
      from: this.parseDate(query.from, defaultFrom),
      to: this.parseDate(query.to),
    };
  }

  public async recordEvent(input: VisibilityEventInput) {
    const action = this.normalizeAction(input.action);
    const stage = this.normalizeStage(input.stage);
    const stakerAddress = this.sanitizeNullableString(
      input.stakerAddress,
    )?.toLowerCase() ?? null;
    const poolAddress = this.sanitizeNullableString(
      input.poolAddress,
    )?.toLowerCase() ?? null;
    const txHash = this.sanitizeNullableString(input.txHash)?.toLowerCase() ?? null;
    const attemptId = await this.resolveAttemptId(
      this.sanitizeNullableString(input.attemptId),
      txHash,
    );

    this.validateAddress(stakerAddress, "staker address");
    this.validateAddress(poolAddress, "pool address");
    this.validateTxHash(txHash);

    const now = new Date();
    const success = this.inferSuccess(stage, input.success);
    const status = this.statusFromStage(stage);
    const isFailureStatus = ["failed", "reverted", "stuck"].includes(status);
    const finalErrorCode = isFailureStatus
      ? this.sanitizeNullableString(input.errorCode) ?? status.toUpperCase()
      : null;
    const finalErrorMessage = isFailureStatus
      ? this.sanitizeNullableString(input.errorMessage) ?? status
      : null;

    const event = await visibilityRepository.appendEvent({
      attemptId,
      action,
      stage,
      success,
      stakerAddress,
      poolAddress,
      txHash,
      amountRaw: this.sanitizeNullableString(input.amountRaw),
      amountFormatted: this.sanitizeNullableString(input.amountFormatted),
      nonce:
        typeof input.nonce === "number" && Number.isFinite(input.nonce)
          ? input.nonce
          : null,
      blockNumber:
        typeof input.blockNumber === "number" &&
        Number.isFinite(input.blockNumber)
          ? input.blockNumber
          : null,
      durationMs:
        typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
          ? Math.max(0, Math.round(input.durationMs))
          : null,
      errorCode: this.sanitizeNullableString(input.errorCode),
      errorMessage: this.sanitizeNullableString(input.errorMessage),
      metadata: input.metadata ?? null,
    });

    await visibilityRepository.upsertAttempt({
      attemptId,
      action,
      status,
      success: status === "confirmed" || status === "replaced",
      stakerAddress,
      poolAddress,
      txHash,
      amountRaw: this.sanitizeNullableString(input.amountRaw),
      amountFormatted: this.sanitizeNullableString(input.amountFormatted),
      firstStageAt: now,
      lastStageAt: now,
      durationMs:
        typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
          ? Math.max(0, Math.round(input.durationMs))
          : null,
      finalErrorCode,
      finalErrorMessage,
      metadata: input.metadata ?? null,
    });

    logger.info("Visibility event recorded", {
      attemptId,
      action,
      stage,
      txHash,
      stakerAddress,
      status,
    });

    return event;
  }

  public async recordTransactionStatus(input: {
    attemptId?: string | null;
    txHash: string;
    stakerAddress: string;
    poolAddress?: string | null;
    action?: string | null;
    nonce?: number | null;
    status:
      | "pending"
      | "stuck"
      | "missing"
      | "nonce_gap"
      | "replaced"
      | "confirmed"
      | "reverted";
    blockNumber?: number | null;
    source: "api" | "indexer" | "repair";
  }) {
    const stageByStatus: Record<typeof input.status, VisibilityStage> = {
      pending: "confirmation_pending",
      stuck: "stuck",
      missing: "stuck",
      nonce_gap: "stuck",
      replaced: "replaced",
      confirmed: "confirmed",
      reverted: "reverted",
    };

    const errorMessageByStatus: Partial<Record<typeof input.status, string>> = {
      stuck: "Transaction is still pending or underpriced.",
      missing: "Transaction was not found on the network.",
      nonce_gap: "Transaction is blocked by an earlier missing nonce.",
      reverted: "Transaction reverted on-chain.",
    };

    return await this.recordEvent({
      attemptId: input.attemptId,
      action: input.action || "stake",
      stage: stageByStatus[input.status],
      success: input.status === "confirmed" || input.status === "replaced",
      txHash: input.txHash,
      stakerAddress: input.stakerAddress,
      poolAddress: input.poolAddress,
      nonce: input.nonce ?? null,
      blockNumber: input.blockNumber ?? null,
      errorCode: errorMessageByStatus[input.status]
        ? input.status.toUpperCase()
        : null,
      errorMessage: errorMessageByStatus[input.status] ?? null,
      metadata: { source: input.source, backendStatus: input.status },
    });
  }

  public async getSummary(query: Record<string, any>) {
    const range = this.getDateRange(query);
    const [totals, actions, topErrors] = await Promise.all([
      visibilityRepository.getTotals(range),
      visibilityRepository.getActionSummary(range),
      visibilityRepository.getTopErrors(range, 10),
    ]);

    return { range, totals, actions, topErrors };
  }

  public async getFailures(query: Record<string, any>) {
    const range = this.getDateRange(query);
    return {
      range,
      topErrors: await visibilityRepository.getTopErrors(range, 25),
    };
  }

  public async getAttempts(query: Record<string, any>) {
    const range = this.getDateRange(query);
    const statusParam = this.sanitizeNullableString(query.status);
    const statuses = statusParam
      ? (statusParam.split(",") as VisibilityAttemptStatus[])
      : undefined;
    const action = query.action
      ? this.normalizeAction(String(query.action))
      : undefined;
    const limit = Math.min(Number(query.limit) || 25, 100);

    return await visibilityRepository.findAttempts({
      ...range,
      action,
      statuses,
      stakerAddress: this.sanitizeNullableString(query.stakerAddress) ?? undefined,
      txHash: this.sanitizeNullableString(query.txHash) ?? undefined,
      limit,
    });
  }

  public async getHealth() {
    const [latestIndexedBlock, latestBlock, unresolvedStatusCounts, lastEventAt] =
      await Promise.all([
        stakingRepository.getLatestIndexedBlock(),
        blockchainService.getLatestBlock().catch((error: any) => {
          logger.warn("Unable to fetch latest block for visibility health", {
            error: error.message,
          });
          return null;
        }),
        visibilityRepository.getUnresolvedStatusCounts(),
        visibilityRepository.getLastEventAt(),
      ]);

    const chainHeadBlock = latestBlock ? Number(latestBlock.number) : null;

    return {
      latestIndexedBlock,
      chainHeadBlock,
      indexerLag:
        chainHeadBlock === null ? null : Math.max(0, chainHeadBlock - latestIndexedBlock),
      unresolvedStatusCounts,
      lastEventAt,
    };
  }
}

export default new VisibilityService();
