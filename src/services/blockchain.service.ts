import { RpcReadProvider } from "./rpc-read-provider";
import { ethers } from "ethers";
import { abi } from "../contract/abi.contract";
import config from "../config/app.config";
import logger from "../helpers/logger.helper";
import { readEpochStatus, readVersionedEpochStatus, type EpochBounds } from "./epoch-status";
import { loadEpochRelease } from "./epoch-release";
import versionedReaderAbi from "../contracts/generated/VersionedChainTallyReader.json";
import { AppError } from "../helpers/appError.helper";
import {verifyMainnetCanonicalHistory} from '../lib/mainnet-profile';

// ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// Version reported when the contract does not expose version() (V1 reverts).
const V1_FALLBACK_VERSION = "1.0.0";

class BlockchainService {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private readonly contractReadRetries = 3;
  private readonly contractReadTimeoutMs = 12000;

  constructor() {
    this.provider = new RpcReadProvider(
      config.RPC_URL,
      Number(config.NETWORK_ID),
      { staticNetwork: true, batchMaxCount: 1 }
    );
    this.contract = new ethers.Contract(
      config.STAKING_CONTRACT_ADDRESS,
      abi,
      this.provider
    );
  }

  public getProvider(): ethers.JsonRpcProvider {
    return this.provider;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async withRetry<T>(
    operation: () => Promise<T>,
    context: Record<string, any>,
    maxAttempts: number = this.contractReadRetries
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Contract read timed out")),
              this.contractReadTimeoutMs
            )
          ),
        ]);
      } catch (error: any) {
        lastError = error;
        logger.warn("Contract read failed", {
          ...context,
          attempt,
          maxAttempts,
          error: error.message,
        });

        if (attempt < maxAttempts) {
          await this.sleep(500 * attempt);
        }
      }
    }

    throw lastError;
  }

  public async getPoolTotalStaked(poolAddress: string): Promise<bigint> {
    return await this.withRetry(
      () => this.contract.poolTotalStake(poolAddress),
      { method: "poolTotalStake", poolAddress }
    );
  }

  public async getPoolTotalAssets(poolAddress: string): Promise<bigint> {
    return await this.withRetry(
      () => this.contract.poolTotalAssets(poolAddress),
      { method: "poolTotalAssets", poolAddress }
    );
  }

  public async getPoolTotalShares(poolAddress: string): Promise<bigint> {
    return await this.withRetry(
      () => this.contract.poolTotalShares(poolAddress),
      { method: "poolTotalShares", poolAddress }
    );
  }

  public async getPoolStakerAmount(
    poolAddress: string,
    stakerAddress: string
  ): Promise<bigint> {
    return await this.withRetry(
      () => this.contract.stakerPrincipalBDAG(stakerAddress, poolAddress),
      { method: "stakerPrincipalBDAG", poolAddress, stakerAddress }
    );
  }

  public async getCurrentEpoch(): Promise<bigint> {
    return await this.withRetry(() => this.contract.currentEpoch(), {
      method: "currentEpoch",
    });
  }

  public async getEpochStatus() {
    const release = await loadEpochRelease(config.GOVERNANCE_FIXTURE_MANIFEST_PATH, config.GOVERNANCE_FIXTURE_MANIFEST_HASH, Number(config.NETWORK_ID));
    if (release) {
      if ((release.activeStakingSource ?? release.stakingSource) !== config.STAKING_CONTRACT_ADDRESS.toLowerCase() || !config.EXPECTED_GENESIS_HASH) throw new AppError('Epoch release source mismatch',503);
      const reader = new ethers.Contract(release.reader, [...versionedReaderAbi,'function activeStakingSource() view returns (address)'], this.provider);
      return this.withRetry(() => readVersionedEpochStatus(this.provider, {
        epochStatus: (at) => reader.epochStatus(at) as Promise<EpochBounds>,
        genesisTime: (at) => reader.genesisTime(at) as Promise<bigint>,
      }, async (blockTag) => {
        if(release.mainnetProfile) await verifyMainnetCanonicalHistory(release.mainnetProfile,(method,params)=>this.provider.send(method,params));
        const [code, source, genesis, activeSource] = await Promise.all([
          this.provider.getCode(release.reader,blockTag), reader.clockSource({blockTag}) as Promise<string>, this.provider.getBlock(0),
          release.activeStakingSource ? reader.activeStakingSource({blockTag}) as Promise<string> : Promise.resolve(undefined),
        ]);
        if (ethers.keccak256(code) !== release.codeHash || source.toLowerCase() !== release.stakingSource ||
            (release.activeStakingSource !== undefined && activeSource?.toLowerCase() !== release.activeStakingSource) ||
            genesis?.hash?.toLowerCase() !== config.EXPECTED_GENESIS_HASH?.toLowerCase()) {
          throw new AppError('Epoch release runtime or chain identity mismatch',503);
        }
      }), {method:'versionedEpochSnapshot'});
    }
    return this.withRetry(() => readEpochStatus(this.provider, {
      currentEpoch: (at) => this.contract.currentEpoch(at),
      genesisTime: (at) => this.contract.genesisTime(at),
      EPOCH_DURATION: (at) => this.contract.EPOCH_DURATION(at),
    }), { method: "epochSnapshot" });
  }

  public async getTimeToNextEpoch(): Promise<bigint> {
    return await this.withRetry(() => this.contract.timeToNextEpoch(), {
      method: "timeToNextEpoch",
    });
  }

  public async getGenesisTime(): Promise<bigint> {
    return await this.withRetry(() => this.contract.genesisTime(), {
      method: "genesisTime",
    });
  }

  public async getMinStake(): Promise<bigint> {
    return await this.withRetry(() => this.contract.MIN_STAKE(), {
      method: "MIN_STAKE",
    });
  }

  public async getMinerSplit(): Promise<bigint> {
    return await this.withRetry(() => this.contract.minerSplit(), {
      method: "minerSplit",
    });
  }

  public async getStakerSplit(): Promise<bigint> {
    return await this.withRetry(() => this.contract.stakerSplit(), {
      method: "stakerSplit",
    });
  }

  /**
   * Semantic version reported by the implementation. version() only exists on
   * V2+ and reverts on V1, so a revert is deterministic: probe once and resolve
   * any failure to "1.0.0".
   */
  public async getContractVersion(): Promise<string> {
    try {
      const version = await this.withRetry(
        () => this.contract.version(),
        { method: "version" },
        1
      );
      return typeof version === "string" && version.length > 0
        ? version
        : V1_FALLBACK_VERSION;
    } catch {
      return V1_FALLBACK_VERSION;
    }
  }

  /** Timestamp when initializeV2() ran through the proxy. Best effort: 0n on V1 or error. */
  public async getV2ActivatedAt(): Promise<bigint> {
    try {
      return await this.withRetry(
        () => this.contract.v2ActivatedAt(),
        { method: "v2ActivatedAt" },
        1
      );
    } catch {
      return 0n;
    }
  }

  /** Current UUPS implementation address, read from the ERC-1967 implementation slot. */
  public async getImplementationAddress(): Promise<string> {
    const raw = await this.withRetry(
      () =>
        this.provider.getStorage(
          config.STAKING_CONTRACT_ADDRESS,
          ERC1967_IMPLEMENTATION_SLOT
        ),
      { method: "getStorage", slot: "erc1967.implementation" }
    );
    return ethers.getAddress(
      ethers.dataSlice(ethers.zeroPadValue(raw, 32), 12)
    );
  }

  public async call(data: { to: string; data: string }): Promise<string> {
    try {
      return await this.provider.call(data);
    } catch (error: any) {
      logger.error("Blockchain call failed", { data, error: error.message });
      throw error;
    }
  }

  public async getStorage(address: string, slot: string): Promise<string> {
    try {
      return await this.provider.getStorage(address, slot);
    } catch (error: any) {
      logger.error("Blockchain getStorage failed", {
        address,
        slot,
        error: error.message,
      });
      throw error;
    }
  }

  public async getLatestBlock(): Promise<ethers.Block | null> {
    return await this.provider.getBlock("latest");
  }

  public async getBlock(blockNumber: number): Promise<ethers.Block | null> {
    return await this.provider.getBlock(blockNumber);
  }

  public async getNativeBalance(
    address: string,
    blockTag: number | "latest" = "latest"
  ): Promise<bigint> {
    return await this.withRetry(
      () => this.provider.getBalance(address, blockTag),
      { method: "getBalance", address, blockTag }
    );
  }

  public async getPoolTotalStakers(poolAddress: string): Promise<bigint> {
    return await this.withRetry(
      () => this.contract.poolTotalStakers(poolAddress),
      { method: "poolTotalStakers", poolAddress }
    );
  }

  public async getPoolStakerYield(
    poolAddress: string,
    stakerAddress: string
  ): Promise<bigint> {
    return await this.withRetry(
      () => this.contract.poolStakerYield(poolAddress, stakerAddress),
      { method: "poolStakerYield", poolAddress, stakerAddress }
    );
  }

  public async getUnbondingRequests(stakerAddress: string): Promise<any[]> {
    return await this.withRetry(
      () => this.contract.getUnbondingRequests(stakerAddress),
      { method: "getUnbondingRequests", stakerAddress }
    );
  }
}

export default new BlockchainService();
