import { ethers } from "ethers";
import logger from "../helpers/logger.helper";
import UnresolvedTransaction from "../models/unresolvedTransaction.model";
import stakingRepository from "../repositories/staking.repository";
import nonceRepairService, { SentRepairTx } from "./nonceRepair.service";
import visibilityService from "./visibility.service";

type RecoveryCandidate = Pick<
  UnresolvedTransaction,
  | "txHash"
  | "stakerAddress"
  | "poolAddress"
  | "nonce"
  | "action"
  | "status"
  | "repairStatus"
>;

type RecoverySource = "api_timeout" | "indexer" | "wallet_connect";

const RECOVERY_TRIGGER_STATUSES = new Set(["stuck", "missing", "nonce_gap"]);
const REPAIR_BUSY_OR_TERMINAL_STATUSES = new Set([
  "checking",
  "not_needed",
  "skipped",
  "unavailable",
  "signature_required",
  "submitted",
  "confirmed",
  "failed",
]);

class TransactionRecoveryService {
  private provider = nonceRepairService.createProvider();

  public scheduleNonceRepairCheck(
    transaction: RecoveryCandidate,
    source: RecoverySource,
  ) {
    if (!this.shouldAttemptRepair(transaction)) return;

    void this.runNonceRepairCheck(transaction, source).catch((error: any) => {
      logger.error("Nonce repair fallback failed", {
        txHash: transaction.txHash,
        source,
        error: error.message,
      });
    });
  }

  public async checkTrackedNonceRepair(
    transaction: RecoveryCandidate,
    source: RecoverySource = "wallet_connect",
  ): Promise<UnresolvedTransaction | null> {
    return await this.runNonceRepairCheck(transaction, source, true);
  }

  public async checkAddressNonceRepair(
    stakerAddress: string,
  ): Promise<UnresolvedTransaction | null> {
    try {
      const result = await nonceRepairService.attemptAutoRepairForTimeout({
        stakerAddress,
      });

      if (result.status === "not_needed") return null;

      const replacementTx = result.state?.plan.find(
        (tx) =>
          tx.replaces?.hash && ethers.isHexString(tx.replaces.hash, 32),
      )?.replaces;

      if (!replacementTx) return null;

      const nonce = Number(replacementTx.nonce);
      const transaction = await stakingRepository.upsertUnresolvedTransaction({
        txHash: replacementTx.hash,
        stakerAddress,
        poolAddress: result.state?.poolAddress ?? null,
        nonce: Number.isInteger(nonce)
          ? nonce
          : result.state?.latestNonce ?? null,
        action: result.state?.currentTxIsClaim ? "claimStake" : null,
        status: "stuck",
      });

      await stakingRepository.updateUnresolvedTransaction(transaction.txHash, {
        repairStatus: result.status,
        repairReason: result.reason,
        repairTxPlan: result.transactions ?? null,
        repairTxHashes: null,
        repairNonceStart: result.state?.latestNonce ?? null,
        repairNonceEnd: result.state?.maxNonce ?? null,
        repairLastAttemptAt: new Date(),
        lastCheckedAt: new Date(),
      });

      logger.info("Nonce repair fallback checked connected wallet", {
        stakerAddress,
        txHash: transaction.txHash,
        repairStatus: result.status,
        repairReason: result.reason,
      });

      return await stakingRepository.findUnresolvedTransaction(
        transaction.txHash,
      );
    } catch (error: any) {
      logger.warn("Connected wallet nonce repair check failed", {
        stakerAddress,
        error: error.message,
      });
      return null;
    }
  }

  public async refreshSubmittedRepair(
    transaction: UnresolvedTransaction,
  ): Promise<boolean> {
    if (transaction.repairStatus !== "submitted") return false;

    const repairTxs = this.getRepairTxHashes(transaction.repairTxHashes);
    if (repairTxs.length === 0) return false;

    const receipts = await Promise.all(
      repairTxs.map((tx) => this.provider.getTransactionReceipt(tx.hash)),
    );

    if (receipts.some((receipt) => receipt === null)) return false;

    const failedReceipt = receipts.find((receipt) => receipt?.status !== 1);
    if (failedReceipt) {
      await stakingRepository.updateUnresolvedTransaction(transaction.txHash, {
        repairStatus: "failed",
        repairReason:
          "A replacement transaction was mined but did not complete successfully.",
        lastCheckedAt: new Date(),
      });
      return true;
    }

    const blockNumber = receipts.reduce(
      (latest, receipt) =>
        receipt && Number(receipt.blockNumber) > latest
          ? Number(receipt.blockNumber)
          : latest,
      0,
    );

    await stakingRepository.updateUnresolvedTransaction(transaction.txHash, {
      status: "replaced",
      receiptStatus: "repaired",
      blockNumber: blockNumber || null,
      repairStatus: "confirmed",
      repairReason: "Nonce repair transactions were mined successfully.",
      lastCheckedAt: new Date(),
    });

    void visibilityService
      .recordTransactionStatus({
        txHash: transaction.txHash,
        stakerAddress: transaction.stakerAddress,
        poolAddress: transaction.poolAddress,
        nonce: transaction.nonce,
        action: transaction.action,
        status: "replaced",
        blockNumber: blockNumber || null,
        source: "repair",
      })
      .catch((error: any) =>
        logger.warn("Failed to record repaired transaction visibility", {
          txHash: transaction.txHash,
          error: error.message,
        }),
      );

    return true;
  }

  private shouldAttemptRepair(
    transaction: RecoveryCandidate,
    force = false,
  ): boolean {
    if (!RECOVERY_TRIGGER_STATUSES.has(transaction.status)) return false;
    if (
      !force &&
      transaction.repairStatus &&
      REPAIR_BUSY_OR_TERMINAL_STATUSES.has(transaction.repairStatus)
    ) {
      return false;
    }
    if (
      force &&
      (transaction.repairStatus === "submitted" ||
        transaction.repairStatus === "confirmed")
    ) {
      return false;
    }

    return ethers.isAddress(transaction.stakerAddress);
  }

  private async runNonceRepairCheck(
    transaction: RecoveryCandidate,
    source: RecoverySource,
    force = false,
  ): Promise<UnresolvedTransaction | null> {
    const current = await stakingRepository.findUnresolvedTransaction(
      transaction.txHash,
    );
    const candidate = current ?? transaction;

    if (!this.shouldAttemptRepair(candidate, force)) return current;

    await stakingRepository.updateUnresolvedTransaction(transaction.txHash, {
      repairStatus: "checking",
      repairReason: "Checking txpool for low-gas nonce replacement.",
      repairLastAttemptAt: new Date(),
      lastCheckedAt: new Date(),
    });

    try {
      const result = await nonceRepairService.attemptAutoRepairForTimeout({
        stakerAddress: candidate.stakerAddress,
        poolAddress: candidate.poolAddress,
        action: candidate.action,
        nonce: candidate.nonce,
      });

      await stakingRepository.updateUnresolvedTransaction(transaction.txHash, {
        repairStatus: result.status,
        repairReason: result.reason,
        repairTxPlan: result.transactions ?? null,
        repairTxHashes: null,
        repairNonceStart: result.state?.latestNonce ?? null,
        repairNonceEnd: result.state?.maxNonce ?? null,
        repairLastAttemptAt: new Date(),
        lastCheckedAt: new Date(),
      });

      logger.info("Nonce repair fallback checked timed-out transaction", {
        txHash: transaction.txHash,
        source,
        repairStatus: result.status,
        repairReason: result.reason,
        repairTxCount: result.sent?.length ?? 0,
      });

      return await stakingRepository.findUnresolvedTransaction(
        transaction.txHash,
      );
    } catch (error: any) {
      const message = error.message || String(error);
      const repairStatus = message.includes("txpool_contentFrom")
        ? "unavailable"
        : "failed";

      await stakingRepository.updateUnresolvedTransaction(transaction.txHash, {
        repairStatus,
        repairReason: message,
        repairLastAttemptAt: new Date(),
        lastCheckedAt: new Date(),
      });

      return await stakingRepository.findUnresolvedTransaction(
        transaction.txHash,
      );
    }
  }

  private getRepairTxHashes(value: unknown): SentRepairTx[] {
    if (!Array.isArray(value)) return [];

    return value.filter(
      (tx): tx is SentRepairTx =>
        tx &&
        typeof tx === "object" &&
        typeof tx.hash === "string" &&
        ethers.isHexString(tx.hash, 32) &&
        typeof tx.nonce === "number" &&
        (tx.kind === "claim" || tx.kind === "cancel"),
    );
  }
}

export default new TransactionRecoveryService();
