import { RpcReadProvider } from "../services/rpc-read-provider";
import { ethers } from "ethers";
import config from "../config/app.config";
import logger from "../helpers/logger.helper";
import { abi } from "../contract/abi.contract";
import { BLOCKCHAIN_CONSTANTS } from "../constants";
import stakingRepository from "../repositories/staking.repository";
import transactionRecoveryService from "../services/transactionRecovery.service";
import visibilityService from "../services/visibility.service";
import governanceRepository from "../repositories/governance.repository";
import { ContractDefinition, ContractRegistry, eventAbiFor, registryFromEnvironment } from "../contracts/contract-registry";
import { confirmedHead, findReorgAncestor } from "../indexing/canonical";
import { persistCanonicalRange, CanonicalRange, RangeProjection } from "../indexing/canonical-range.persistence";
import { assertCanonicalRange, assertCanonicalRangeTail, CanonicalRangeObservation } from "../indexing/canonical-range.validation";
import { mapBounded } from "../indexing/bounded-reads";
import { verifyNetworkIdentity } from "../indexing/network-identity";
import { nextIndexBlock, verifyIndexingBoundary } from '../indexing/start-boundary';

interface CollectedStakingActivities {
  activities: Record<string, unknown>[];
  observations: CanonicalRangeObservation[];
}

class Indexer {
  private provider: ethers.JsonRpcProvider;
  private isIndexing: boolean;
  private readonly registry: ContractRegistry;
  private boundary = 0;

  constructor() {
    this.provider = new RpcReadProvider(
      config.RPC_URL,
      Number(config.NETWORK_ID),
      { staticNetwork: true, batchMaxCount: 1 }
    );
    this.isIndexing = false;
    this.registry = registryFromEnvironment(config.STAKING_CONTRACTS_JSON, config.STAKING_CONTRACT_ADDRESS);
  }

  async start(): Promise<void> {
    if (this.isIndexing) return;
    await verifyNetworkIdentity(this.provider, Number(config.NETWORK_ID), config.EXPECTED_GENESIS_HASH);
    const retainedBoundary=config.INDEXER_START_BLOCK ? await governanceRepository.indexingBoundary(config.INDEXER_START_BLOCK) : null;
    this.boundary = await verifyIndexingBoundary(this.provider, config.INDEXER_START_BLOCK, config.INDEXER_START_BLOCK_HASH, this.registry.contracts,retainedBoundary);
    this.isIndexing = true;
    logger.info("Starting indexer sync...");

    let startBlock = 0;
    try {
      startBlock = nextIndexBlock(this.boundary, await stakingRepository.getLatestIndexedBlock());
    } catch (e: any) {
      logger.error("Error fetching latest indexed block:", e);
    }

    this.indexPastBlocks(startBlock);
  }

  async indexPastBlocks(fromBlock: number): Promise<void> {
    try {
      await verifyNetworkIdentity(this.provider, Number(config.NETWORK_ID), config.EXPECTED_GENESIS_HASH);
      await this.reconcileCanonicalHistory();
      fromBlock = nextIndexBlock(this.boundary, await stakingRepository.getLatestIndexedBlock());
      let latestBlock = await this.confirmedHead();
      const step = 20;

      logger.info(`Indexing from block ${fromBlock} to ${latestBlock}`);

      for (let i = fromBlock; i <= latestBlock; i += step) {
        const toBlock = Math.min(i + step - 1, latestBlock);
        await this.persistRange(await this.collectRange(i, toBlock));

        if (i % 500 < step || toBlock >= latestBlock) {
          logger.info(
            `Progress: Indexed up to block ${toBlock}/${latestBlock}`,
          );
        }

        if (toBlock >= latestBlock) {
          latestBlock = await this.confirmedHead();
        }
      }

      logger.info("Past blocks indexing completed.");
      this.isIndexing = false;
      this.pollNewBlocks();
    } catch (error: any) {
      logger.error("Error indexing past blocks:", {
        message: error.message,
        detail: error.original?.detail,
        sql: error.sql,
      });
      this.isIndexing = false;
      // Retry after 30 seconds
      setTimeout(() => this.start(), 30000);
    }
  }

  private async pollNewBlocks(): Promise<void> {
    const poll = async () => {
      try {
        await verifyNetworkIdentity(this.provider, Number(config.NETWORK_ID), config.EXPECTED_GENESIS_HASH);
        await this.reconcileCanonicalHistory();
        const lastBlock = await stakingRepository.getLatestIndexedBlock();
        const currentBlock = await this.confirmedHead();

        if (currentBlock > lastBlock) {
          const fromBlock = lastBlock + 1;
          logger.info(`Polling: indexing from ${fromBlock} to ${currentBlock}`);

          await this.persistRange(await this.collectRange(fromBlock, currentBlock));
        }

        await this.indexUnresolvedTransactions();
      } catch (error: any) {
        logger.error("Error in block polling:", {
          message: error.message,
          detail: error.original?.detail,
          sql: error.sql,
        });
      }
      setTimeout(poll, 10000);
    };
    poll();
  }

  private async collectBlock(blockNumber: number): Promise<{ block: { number: number; hash: string; parentHash: string; timestamp: number; miner: string | null }; pool: { address: string; blockNumber: number; timestamp: number } | null }> {
    try {
      const block = await this.callWithRetry(() => this.provider.getBlock(blockNumber));
      if (!block || !block.hash || !block.parentHash) throw new Error(`Missing canonical block ${blockNumber}`);
      const miner = block.miner?.toLowerCase() ?? null;
      const pool = miner && miner !== BLOCKCHAIN_CONSTANTS.ZERO_ADDRESS
        ? { address: miner, blockNumber, timestamp: Number(block.timestamp) }
        : null;
      return { block: { number: blockNumber, hash: block.hash, parentHash: block.parentHash, timestamp: Number(block.timestamp), miner }, pool };
    } catch (error: any) {
      logger.error(`Error collecting block ${blockNumber}:`, error);
      throw error;
    }
  }

  async indexPoolAddress(blockNumber: number): Promise<void> {
    const { pool } = await this.collectBlock(blockNumber);
    if (pool) await stakingRepository.updatePoolAddress(pool.address, pool.blockNumber, pool.timestamp);
  }

  private async collectRange(fromBlock: number, toBlock: number): Promise<CanonicalRange> {
    const prior = (await governanceRepository.recentBlocks(1))[0];
    const [staking, governance, collected] = await Promise.all([
      this.collectStakingActivities(fromBlock, toBlock),
      this.indexGovernanceEvents(fromBlock, toBlock),
      mapBounded(Array.from({ length: toBlock - fromBlock + 1 }, (_, offset) => fromBlock + offset), 4, (number) => this.collectBlock(number)),
    ]);
    const previousBlock = prior?.blockNumber === fromBlock - 1
      ? { number: prior.blockNumber, hash: prior.blockHash, parentHash: prior.parentHash, timestamp: prior.timestamp, miner: prior.miner }
      : undefined;
    const range: CanonicalRange = {
      watermark: toBlock,
      blocks: collected.map((entry) => entry.block),
      pools: collected.flatMap((entry) => entry.pool ? [entry.pool] : []),
      previousBlock,
      observations: [...staking.observations, ...governance.observations],
      stakingActivities: staking.activities,
      events: governance.events,
      projections: governance.projections,
    };
    assertCanonicalRange(range);
    assertCanonicalRangeTail(range, (await this.collectBlock(toBlock)).block);
    return range;
  }

  private async persistRange(range: CanonicalRange): Promise<void> {
    await persistCanonicalRange(range);
    if (range.stakingActivities.length > 0) {
      const stakers = [...new Set(range.stakingActivities.map((activity: any) => String(activity.stakerAddress)))];
      await stakingRepository.updatePortfolioSnapshots(stakers);
    }
  }

  async indexStakingActivity(fromBlock: number, toBlock: number, timestamp?: number): Promise<void> {
    const { activities } = await this.collectStakingActivities(fromBlock, toBlock, timestamp);
    if (activities.length === 0) return;
    await stakingRepository.bulkCreateStakingActivities(activities);
    await stakingRepository.updatePortfolioSnapshots([...new Set(activities.map((activity: any) => String(activity.stakerAddress)))]);
  }

  private async collectStakingActivities(
    fromBlock: number,
    toBlock: number,
    timestamp?: number,
  ): Promise<CollectedStakingActivities> {
    try {
      const eventTopics = [
        ethers.id("Staked(address,uint256,address)"),
        ethers.id("Unstaked(address,uint256,uint256,address)"),
        ethers.id("StakeClaimed(address,uint256,uint256)"),
        ethers.id("StakeReallocated(address,uint256,address,address)"),
        ethers.id("Redelegated(address,uint256,address,address)"),
        ethers.id("Upgraded(address)"),
      ];
      const stakingActivities: any[] = [];
      const observations: CanonicalRangeObservation[] = [];
      for (const definition of this.definitionsOverlapping(fromBlock, toBlock, "staking")) {
        const iface = new ethers.Interface(eventAbiFor(definition.kind, definition.version));
        const filter = {
        address: definition.address,
        fromBlock: Math.max(fromBlock, definition.fromBlock), toBlock: definition.toBlock === undefined ? toBlock : Math.min(toBlock, definition.toBlock), topics: [eventTopics],
        };

      const logs = await this.callWithRetry(() =>
        this.provider.getLogs(filter),
      );
      if (logs.length === 0) continue;
      for (const log of logs) {
        if (!log.blockHash) throw new Error(`Missing block hash for staking log ${log.transactionHash}`);
        observations.push({ blockNumber: Number(log.blockNumber), blockHash: log.blockHash });
      }

      logger.info(
        `Found ${logs.length} logs in block range ${fromBlock}-${toBlock}`,
      );

      const blockTimestamps = new Map<number, number>();

      if (fromBlock !== toBlock) {
        const uniqueBlocks = [
          ...new Set(logs.map((l) => Number(l.blockNumber))),
        ];
        await Promise.all(
          uniqueBlocks.map(async (bn) => {
            const b = await this.callWithRetry(() =>
              this.provider.getBlock(bn),
            );
            if (b) blockTimestamps.set(bn, b.timestamp);
            else throw new Error(`Could not fetch block ${bn}`);
          }),
        );
      } else if (timestamp !== undefined) {
        blockTimestamps.set(fromBlock, timestamp);
      } else {
        const b = await this.callWithRetry(() =>
          this.provider.getBlock(fromBlock),
        );
        if (b) blockTimestamps.set(fromBlock, b.timestamp);
        else throw new Error(`Could not fetch block ${fromBlock}`);
      }

      for (const log of logs) {
        try {
          const parsedLog = iface.parseLog(log);
          if (!parsedLog) continue;

          if (parsedLog.name === "Upgraded") {
            logger.info("Staking contract implementation upgraded", {
              blockNumber: Number(log.blockNumber),
              txHash: log.transactionHash,
              implementation: parsedLog.args.implementation,
            });
            continue;
          }

          let rawAmount = "0";
          let unbondingPayoutRaw = "0";
          if (
            ["Staked", "StakeReallocated", "Redelegated", "Unstaked"].includes(
              parsedLog.name,
            )
          ) {
            rawAmount = parsedLog.args.amount.toString();
            if (parsedLog.name === "Unstaked") {
              unbondingPayoutRaw = (
                parsedLog.args.principalAmount ??
                parsedLog.args.shares ??
                0n
              ).toString();
            }
          } else if (parsedLog.name === "StakeClaimed") {
            rawAmount = parsedLog.args.totalPayout.toString();
            unbondingPayoutRaw = parsedLog.args.unbondingPayout.toString();
          }
          const stakerAddress = parsedLog.args.staker;
          let poolAddress = BLOCKCHAIN_CONSTANTS.ZERO_ADDRESS;
          let fromPoolAddress;
          let toPoolAddress;

          if (
            parsedLog.name === "StakeReallocated" ||
            parsedLog.name === "Redelegated"
          ) {
            fromPoolAddress = (parsedLog.args.fromPool || "").toLowerCase();
            toPoolAddress = (parsedLog.args.toPool || "").toLowerCase();
          } else {
            poolAddress = (
              parsedLog.args.pool || BLOCKCHAIN_CONSTANTS.ZERO_ADDRESS
            ).toLowerCase();
          }
          const amount = ethers.formatEther(rawAmount);
          const unbondingPayout = ethers.formatEther(unbondingPayoutRaw);

          const blockTs = blockTimestamps.get(Number(log.blockNumber));
          if (blockTs === undefined) {
            throw new Error(
              `Missing timestamp for block ${log.blockNumber} at tx ${log.transactionHash}`,
            );
          }

          stakingActivities.push({
            txHash: log.transactionHash,
            blockNumber: Number(log.blockNumber),
            timestamp: new Date(blockTs * 1000),
            eventType: parsedLog.name,
            stakerAddress: stakerAddress.toLowerCase(),
            poolAddress,
            fromPoolAddress,
            toPoolAddress,
            amount,
            rawAmount,
            unbondingPayout,
            unbondingPayoutRaw,
            logIndex: log.index,
            contractVersion: definition.version,
          });
        } catch (e: any) {
          logger.error(
            `Error parsing log for transaction ${log.transactionHash}:`,
            { error: e.message },
          );
          if (e.message.includes("Missing timestamp")) throw e;
        }
      }
      }

      if (stakingActivities.length > 0) {
        logger.info(`Collected ${stakingActivities.length} activities for blocks ${fromBlock}-${toBlock}`);
      }
      return { activities: stakingActivities, observations };
    } catch (error: any) {
      logger.error(
        `Error indexing staking activity for range ${fromBlock}-${toBlock}:`,
        error,
      );
      throw error;
    }
  }

  private definitionsOverlapping(fromBlock: number, toBlock: number, kind?: ContractDefinition["kind"]): ContractDefinition[] {
    return this.registry.contracts.filter((definition) =>
      (!kind || definition.kind === kind) && definition.fromBlock <= toBlock && (definition.toBlock === undefined || definition.toBlock >= fromBlock),
    );
  }

  private async confirmedHead(): Promise<number> {
    const head = await this.provider.getBlockNumber();
    return confirmedHead(head, config.INDEXER_CONFIRMATIONS);
  }

  private async reconcileCanonicalHistory(): Promise<void> {
    const stored = await governanceRepository.recentBlocks(config.INDEXER_REORG_HISTORY);
    if (stored.length === 0) return;
    const ancestor = await findReorgAncestor(stored.map((block) => ({ blockNumber: block.blockNumber, blockHash: block.blockHash })), async (blockNumber) => (await this.callWithRetry(() => this.provider.getBlock(blockNumber)))?.hash ?? null);
    if (ancestor === null) return;
    const rewindTo = ancestor;
    logger.warn("Canonical parent mismatch; deleting derived data and rescanning", { rewindTo });
    await governanceRepository.rollbackAbove(rewindTo);
  }

  private async indexGovernanceEvents(fromBlock: number, toBlock: number): Promise<{ events: Array<Record<string, unknown>>; projections: RangeProjection[]; observations: CanonicalRangeObservation[] }> {
    const events: Array<Record<string, unknown>> = [];
    const projections: RangeProjection[] = [];
    const observations: CanonicalRangeObservation[] = [];
    for (const definition of this.definitionsOverlapping(fromBlock, toBlock)) {
      const eventAbi = eventAbiFor(definition.kind, definition.version);
      const iface = new ethers.Interface(eventAbi);
      const topics = iface.fragments.flatMap((fragment) => fragment.type === "event" ? [iface.getEvent(fragment.format())!.topicHash] : []);
      if (topics.length === 0) continue;
      const logs = await this.callWithRetry(() => this.provider.getLogs({ address: definition.address, fromBlock: Math.max(fromBlock, definition.fromBlock), toBlock: definition.toBlock === undefined ? toBlock : Math.min(toBlock, definition.toBlock), topics: [topics] }));
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (!log.blockHash) throw new Error(`Missing block hash for governance log ${log.transactionHash}`);
        observations.push({ blockNumber: Number(log.blockNumber), blockHash: log.blockHash });
        if (!parsed) continue;
        const payload: Record<string, string> = {};
        parsed.fragment.inputs.forEach((input, index) => { payload[input.name || String(index)] = String(parsed.args[index]); });
        payload.__contractKind = definition.kind;
        events.push({ txHash: log.transactionHash, logIndex: log.index, blockNumber: Number(log.blockNumber), blockHash: log.blockHash, contractAddress: definition.address, contractVersion: definition.version, eventName: parsed.name, payload });
        const blockNumber = Number(log.blockNumber);
        if (parsed.name === "CredentialClaimed") projections.push({ type: "credential", data: { wallet: String(parsed.args.account).toLowerCase(), credentialEpoch: Number(parsed.args.credentialEpoch), kind: definition.kind, rawWeight: String(parsed.args.rawWeight), mintedDelta: String(parsed.args.mintedDelta), txHash: log.transactionHash, logIndex: log.index, contractVersion: definition.version, blockNumber } });
        else if (parsed.name === "PoolRegistered") projections.push({ type: "credentialPool", data: { wallet: String(parsed.args.account).toLowerCase(), poolAddress: String(parsed.args.pool).toLowerCase(), kind: definition.kind, txHash: log.transactionHash, logIndex: log.index, contractVersion: definition.version, blockNumber } });
        else if (parsed.name === "EpochFinalized") projections.push({ type: "epoch", data: { epoch: Number(parsed.args.epoch), finalized: true, eligibleTotal: String(parsed.args.eligibleTotal), minerCount: Number(parsed.args.minerCount), finalizedBlock: blockNumber } });
        else if (parsed.name === "MinerRegistered") projections.push({ type: "miner", data: { poolAddress: String(parsed.args.miner).toLowerCase(), epoch: Number(parsed.args.epoch), blocks: 0, rewardTally: "0", confirmedBlock: blockNumber } });
        else if (parsed.name === "Armed") projections.push({ type: "activation", data: { key: "current", armed: true, armedAt: Number(parsed.args.timestamp), observedBlock: blockNumber } });
        else if (parsed.name === "Disarmed") projections.push({ type: "activation", data: { key: "current", armed: false, armedAt: null, observedBlock: blockNumber } });
        else if (definition.kind === "governance" && parsed.name === "ProposalCreated") projections.push({ type: "proposal", data: { proposalId: String(parsed.args.proposalId), contractVersion: definition.version, status: "created", proposer: String(parsed.args.proposer).toLowerCase(), blockNumber, metadata: payload } });
        else if (definition.kind === "governance" && parsed.name === "ProposalExecuted") projections.push({ type: "proposal", data: { proposalId: String(parsed.args.id ?? parsed.args.proposalId), contractVersion: definition.version, status: "executed", blockNumber, metadata: payload } });
        else if (definition.kind === "governance" && parsed.name === "ProposalCanceled") projections.push({ type: "proposal", data: { proposalId: String(parsed.args.proposalId), contractVersion: definition.version, status: "canceled", blockNumber, metadata: payload } });
      }
    }
    return { events, projections, observations };
  }

  private async indexUnresolvedTransactions(): Promise<void> {
    const transactions = await stakingRepository.getOpenUnresolvedTransactions();
    if (transactions.length === 0) return;

    const now = new Date();
    const staleAfterMs = config.UNRESOLVED_TX_STUCK_MINUTES * 60 * 1000;
    const groupedByStaker = new Map<string, typeof transactions>();

    for (const tx of transactions) {
      const key = tx.stakerAddress.toLowerCase();
      const group = groupedByStaker.get(key) ?? [];
      group.push(tx);
      groupedByStaker.set(key, group);
    }

    const nonceDiagnostics = new Map<
      string,
      {
        chainNonce: number;
        pendingNonce: number | null;
        gapFromNonce: number | null;
      }
    >();

    for (const [stakerAddress, stakerTransactions] of groupedByStaker) {
      const [chainNonce, pendingNonce] = await Promise.all([
        this.callWithRetry(() =>
          this.provider.getTransactionCount(stakerAddress, "latest"),
        ),
        this.callWithRetry(() =>
          this.provider.getTransactionCount(stakerAddress, "pending"),
        ).catch(() => null),
      ]);
      const knownNonces = new Set(
        stakerTransactions
          .map((tx) => tx.nonce)
          .filter((nonce): nonce is number => typeof nonce === "number"),
      );

      for (const tx of stakerTransactions) {
        let gapFromNonce: number | null = null;

        if (typeof tx.nonce === "number" && tx.nonce > chainNonce) {
          for (let nonce = chainNonce; nonce < tx.nonce; nonce++) {
            if (!knownNonces.has(nonce)) {
              gapFromNonce = nonce;
              break;
            }
          }
        }

        nonceDiagnostics.set(tx.txHash.toLowerCase(), {
          chainNonce,
          pendingNonce,
          gapFromNonce,
        });
      }
    }

    for (const tx of transactions) {
      const diagnostics = nonceDiagnostics.get(tx.txHash.toLowerCase());
      const firstSeenAt =
        tx.firstSeenAt instanceof Date
          ? tx.firstSeenAt
          : new Date(tx.firstSeenAt);
      const isStale = now.getTime() - firstSeenAt.getTime() >= staleAfterMs;

      try {
        if (await transactionRecoveryService.refreshSubmittedRepair(tx)) {
          continue;
        }

        const receipt = await this.provider.getTransactionReceipt(tx.txHash);
        if (receipt) {
          const status = receipt.status === 1 ? "confirmed" : "reverted";
          await stakingRepository.updateUnresolvedTransaction(tx.txHash, {
            status,
            blockNumber: Number(receipt.blockNumber),
            receiptStatus: receipt.status === 1 ? "success" : "reverted",
            chainNonce: diagnostics?.chainNonce ?? null,
            pendingNonce: diagnostics?.pendingNonce ?? null,
            gapFromNonce: null,
            lastCheckedAt: now,
          });
          void visibilityService
            .recordTransactionStatus({
              txHash: tx.txHash,
              stakerAddress: tx.stakerAddress,
              poolAddress: tx.poolAddress,
              nonce: tx.nonce,
              action: tx.action,
              status,
              blockNumber: Number(receipt.blockNumber),
              source: "indexer",
            })
            .catch((error: any) =>
              logger.warn("Failed to record indexed transaction visibility", {
                txHash: tx.txHash,
                error: error.message,
              }),
            );
          continue;
        }

        const networkTx = await this.provider.getTransaction(tx.txHash);
        const hasNonceGap =
          diagnostics?.gapFromNonce !== null &&
          diagnostics?.gapFromNonce !== undefined;
        const status = hasNonceGap
          ? "nonce_gap"
          : networkTx
          ? isStale
            ? "stuck"
            : "pending"
          : isStale
          ? "missing"
          : "pending";

        await stakingRepository.updateUnresolvedTransaction(tx.txHash, {
          status,
          chainNonce: diagnostics?.chainNonce ?? null,
          pendingNonce: diagnostics?.pendingNonce ?? null,
          gapFromNonce: diagnostics?.gapFromNonce ?? null,
          lastCheckedAt: now,
        });

        if (status !== tx.status) {
          void visibilityService
            .recordTransactionStatus({
              txHash: tx.txHash,
              stakerAddress: tx.stakerAddress,
              poolAddress: tx.poolAddress,
              nonce: tx.nonce,
              action: tx.action,
              status,
              source: "indexer",
            })
            .catch((error: any) =>
              logger.warn("Failed to record transaction visibility status", {
                txHash: tx.txHash,
                error: error.message,
              }),
            );
        }

        if (["stuck", "missing", "nonce_gap"].includes(status)) {
          transactionRecoveryService.scheduleNonceRepairCheck(
            {
              txHash: tx.txHash,
              stakerAddress: tx.stakerAddress,
              poolAddress: tx.poolAddress,
              nonce: tx.nonce,
              action: tx.action,
              status,
              repairStatus: tx.repairStatus,
            },
            "indexer",
          );
        }
      } catch (error: any) {
        logger.warn("Failed to refresh unresolved transaction", {
          txHash: tx.txHash,
          error: error.message,
        });
      }
    }
  }

  private async callWithRetry<T>(
    fn: () => Promise<T>,
    retries = 3,
    delay = 5000,
  ): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error: any) {
        if (i === retries - 1) throw error;
        const wait = delay * Math.pow(2, i);
        logger.warn(`RPC call failed, retrying in ${wait}ms...`, {
          error: error.message,
        });
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw new Error("Failed after retries");
  }
}

const indexerInstance = new Indexer();
export default indexerInstance;
