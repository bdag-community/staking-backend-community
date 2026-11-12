import { Request, Response, NextFunction } from "express";
import logger from "../helpers/logger.helper";
import { STATUS_CODES, ERROR_MESSAGES } from "../constants";
import responseHelper from "../helpers/response.helper";

export const validateParams = (requiredParams: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const missing = requiredParams.filter((param) => !req.params[param]);

    if (missing.length > 0) {
      const message = ERROR_MESSAGES.MISSING_PARAMS(missing);
      logger.warn(message);

      return responseHelper.error(res, {
        message,
        status: STATUS_CODES.BAD_REQUEST,
      });
    }

    next();
  };
};
