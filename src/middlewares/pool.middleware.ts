import { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import { AppError } from "../helpers/appError.helper";
import stakingHelper from "../helpers/staking.helper";

export const validatePoolMetadataUpdate = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const poolAddress = stakingHelper.getParam(req, "poolAddress");
    const { name, subtitle, signature, address } = req.body;

    if (!signature || !address) {
      throw new AppError("Signature and address are required", 400);
    }

    if (address.toLowerCase() !== poolAddress.toLowerCase()) {
      throw new AppError(
        "Unauthorised: Only the pool owner (miner) can update metadata",
        403,
      );
    }

    try {
      const message = `update pool metadata for ${poolAddress.toLowerCase()}`;
      const recoveredAddress = ethers.verifyMessage(message, signature);

      if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
        throw new AppError("Invalid signature", 401);
      }
    } catch (error: any) {
      throw new AppError(error.message || "Signature verification failed", 401);
    }

    if (name) {
      if (name.length < 3 || name.length > 20) {
        throw new AppError("Pool name must be between 3 to 20 characters", 400);
      }
      const nameRegex = /^[a-z0-9-]+$/;
      if (!nameRegex.test(name)) {
        throw new AppError(
          "Pool name must be alphanumeric (a-z, 0-9) and hyphens (-) only",
          400,
        );
      }
    }

    if (subtitle) {
      if (subtitle.length < 5 || subtitle.length > 60) {
        throw new AppError("Sub-title must be between 5 to 60 characters", 400);
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};
