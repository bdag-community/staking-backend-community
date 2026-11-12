import { Request } from "express";
import { ethers } from "ethers";
import { AppError } from "./appError.helper";
import { STATUS_CODES, ERROR_MESSAGES } from "../constants";

class StakingHelper {
  public getParam(req: Request, key: string): string {
    const value = req.params[key] as string;

    if (!value) {
      throw new AppError(
        ERROR_MESSAGES.MISSING_PARAM(key),
        STATUS_CODES.BAD_REQUEST,
      );
    }

    // Auto-validate any parameter that looks like an address
    if (key.toLowerCase().includes("address")) {
      const normalized = value.toLowerCase();
      if (!ethers.isAddress(normalized)) {
        throw new AppError(
          ERROR_MESSAGES.INVALID_ADDRESS(key, value),
          STATUS_CODES.BAD_REQUEST,
        );
      }
      return normalized;
    }

    return value;
  }

  public formatEther(value: bigint | string): string {
    return ethers.formatEther(value);
  }

  public toMilliseconds(seconds: bigint | number): number {
    return Number(seconds) * 1000;
  }

  public now(): number {
    return Date.now();
  }
}

export default new StakingHelper();
