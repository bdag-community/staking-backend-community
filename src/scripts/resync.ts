import "../helpers/ethers-fetch.helper";
import { initDB, IndexerState } from "../models/index.model";
import indexerInstance from "../workers/indexer.worker";
import logger from "../helpers/logger.helper";
import config from "../config/app.config";
import { ethers } from "ethers";
import stakingRepository from "../repositories/staking.repository";

const WORKERS = 10;

const args = process.argv.slice(2);
const startBlock =
  args[0] !== undefined && args[0] !== "" ? Number(args[0]) : null;

async function resync() {
  try {
    logger.info("Starting full resync process...");

    await initDB();

    const provider = new ethers.JsonRpcProvider(
      config.RPC_URL,
      Number(config.NETWORK_ID),
      { staticNetwork: true }
    );
    const latestBlock = await provider.getBlockNumber();
    if (startBlock !== null) {
      logger.warn(
        `Manual start block ${startBlock} provided. Clearing previous resync state...`
      );
      await stakingRepository.deleteResyncChunks();
    }

    const allStates = await IndexerState.findAll();
    const completedChunks = new Set<number>();
    let latestSafeBlock = -1;

    allStates.forEach((s) => {
      if (s.key.startsWith("resync_chunk_")) {
        completedChunks.add(parseInt(s.key.replace("resync_chunk_", "")));
      }
      if (s.key === "resync_progress") {
        latestSafeBlock = s.lastBlock;
      }
    });

    let currentBlock =
      startBlock !== null
        ? startBlock
        : await stakingRepository.getLatestIndexedBlock();

    if (startBlock !== null && latestSafeBlock < startBlock) {
      latestSafeBlock = startBlock - 1;
    }

    const initialBlock = currentBlock;
    let lastPersistedBlock = latestSafeBlock;
    let completedBlocks = 0;

    const CHUNK_SIZE = 5000;
    const SUB_BATCH_SIZE = 50;
    const TOTAL_TO_SYNC = latestBlock - initialBlock + 1;
    const startTimestamp = Date.now();

    completedChunks.forEach((start) => {
      if (start >= initialBlock) {
        completedBlocks +=
          Math.min(start + CHUNK_SIZE - 1, latestBlock) - start + 1;
      }
    });

    logger.info(
      `Target: Block ${currentBlock} to ${latestBlock} (${TOTAL_TO_SYNC} blocks)`
    );
    logger.info(`Configuration: ${WORKERS} parallel workers`);

    const workerProgress = new Array(WORKERS).fill(0);

    async function worker(workerId: number) {
      while (true) {
        const start = currentBlock;
        currentBlock += CHUNK_SIZE;
        if (start > latestBlock) break;

        const end = Math.min(start + CHUNK_SIZE - 1, latestBlock);

        if (completedChunks.has(start)) {
          workerProgress[workerId] += end - start + 1;
          continue;
        }

        let success = false;
        let attempts = 0;
        const maxAttempts = 5;

        while (!success && attempts < maxAttempts) {
          attempts++;
          try {
            await indexerInstance.indexStakingActivity(start, end);

            for (let i = start; i <= end; i += SUB_BATCH_SIZE) {
              const subEnd = Math.min(i + SUB_BATCH_SIZE - 1, end);
              const poolPromises: Promise<void>[] = [];
              for (let b = i; b <= subEnd; b++) {
                poolPromises.push(indexerInstance.indexPoolAddress(b));
              }
              await Promise.all(poolPromises);

              if (i + SUB_BATCH_SIZE <= end) {
                await new Promise((r) => setTimeout(r, 100));
              }
            }

            completedBlocks += end - start + 1;
            workerProgress[workerId] += end - start + 1;
            success = true;

            await stakingRepository.updateResyncState(
              `resync_chunk_${start}`,
              end
            );
            completedChunks.add(start);

            let newSafeBlock = -1;
            while (completedChunks.has(lastPersistedBlock + 1)) {
              const nextChunkStart = lastPersistedBlock + 1;
              const nextChunkEnd = Math.min(
                nextChunkStart + CHUNK_SIZE - 1,
                latestBlock
              );

              lastPersistedBlock = nextChunkEnd;
              newSafeBlock = lastPersistedBlock;

              await stakingRepository.deleteChunk(
                `resync_chunk_${nextChunkStart}`
              );
            }

            if (newSafeBlock !== -1) {
              await stakingRepository.updateResyncState(
                "resync_progress",
                newSafeBlock
              );
            }

            const progressPercent = (
              (completedBlocks / TOTAL_TO_SYNC) *
              100
            ).toFixed(1);

            logger.info(
              `[Resync] Progress: ${progressPercent}% | ` +
                `Worker ${workerId}: Range ${start}-${end} done | ` +
                `Latest Safe Block: ${lastPersistedBlock}`
            );
          } catch (err: any) {
            logger.error(
              `[Resync] Attempt ${attempts} failed for range ${start}-${end} in worker ${workerId}: ${err.message}`
            );
            if (attempts < maxAttempts) {
              const wait = 5000 * attempts;
              logger.info(
                `Retrying range ${start}-${end} in ${wait / 1000}s...`
              );
              await new Promise((r) => setTimeout(r, wait));
            } else {
              logger.error(
                `[Resync] CRITICAL: Range ${start}-${end} failed after ${maxAttempts} attempts. Moving to next chunk.`
              );
              process.exit(1);
            }
          }
        }
      }
    }

    const workerPromises: Promise<void>[] = [];
    for (let i = 0; i < WORKERS; i++) {
      workerPromises.push(worker(i));
    }

    await Promise.all(workerPromises);

    await stakingRepository.updateLatestIndexedBlock(latestBlock);

    await stakingRepository.deleteResyncChunks();

    const totalTime = (Date.now() - startTimestamp) / 1000;
    logger.info(`[Resync] Full resync completed in ${totalTime.toFixed(2)}s`);
    logger.info(`[Resync] Final block indexed: ${latestBlock}`);

    process.exit(0);
  } catch (error) {
    logger.error("[Resync] Critical failure:", error);
    process.exit(1);
  }
}

resync();
