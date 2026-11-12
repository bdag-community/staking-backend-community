import { ethers } from "ethers";
import config from "../config/app.config";
import blockchainService from "./blockchain.service";
import logger from "../helpers/logger.helper";
import { ContractInfo } from "../interfaces/staking.interface";

class ContractService {
  private contractInfoCache: {
    data: ContractInfo;
    timestamp: number;
  } | null = null;
  private readonly CACHE_TTL = 10 * 1000;

  public async getContractInfo(): Promise<ContractInfo> {
    const now = Date.now();
    if (
      this.contractInfoCache &&
      now - this.contractInfoCache.timestamp < this.CACHE_TTL
    ) {
      return this.contractInfoCache.data;
    }

    try {
      const [
        version,
        minStake,
        minerSplit,
        stakerSplit,
        implementation,
        v2ActivatedAt,
        genesisTime,
      ] = await Promise.all([
        blockchainService.getContractVersion(),
        blockchainService.getMinStake(),
        blockchainService.getMinerSplit(),
        blockchainService.getStakerSplit(),
        blockchainService.getImplementationAddress(),
        blockchainService.getV2ActivatedAt(),
        blockchainService.getGenesisTime(),
      ]);

      const data: ContractInfo = {
        address: ethers.getAddress(
          config.STAKING_CONTRACT_ADDRESS.toLowerCase(),
        ),
        chainId: Number(config.NETWORK_ID),
        version,
        minStake: minStake.toString(),
        minStakeBdag: ethers.formatEther(minStake),
        minerSplit: Number(minerSplit),
        stakerSplit: Number(stakerSplit),
        implementation,
        v2ActivatedAt: Number(v2ActivatedAt),
        genesisTime: Number(genesisTime),
      };

      this.contractInfoCache = { data, timestamp: now };

      return data;
    } catch (error: any) {
      logger.error("Error fetching contract info", {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}

export default new ContractService();
