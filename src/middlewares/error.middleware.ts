import { Request, Response, NextFunction } from "express";
import logger from "../helpers/logger.helper";
import responseHelper from "../helpers/response.helper";

import { STATUS_CODES, ERROR_MESSAGES } from "../constants";

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  let statusCode = err.statusCode || STATUS_CODES.INTERNAL_SERVER_ERROR;
  let message = err.message || ERROR_MESSAGES.SOMETHING_WENT_WRONG;

  if (err.code === "BAD_DATA" || err.message?.includes("BAD_DATA")) {
    statusCode = STATUS_CODES.BAD_GATEWAY;
    message = ERROR_MESSAGES.BLOCKCHAIN_DECODE_ERROR;
  } else if (err.code === "CALL_EXCEPTION") {
    statusCode = STATUS_CODES.BAD_GATEWAY;
    message = ERROR_MESSAGES.BLOCKCHAIN_FETCH_ERROR;
  } else if (err.code === "NETWORK_ERROR") {
    statusCode = STATUS_CODES.SERVICE_UNAVAILABLE;
    message = ERROR_MESSAGES.BLOCKCHAIN_NETWORK_ERROR;
  }

  logger.error(
    "Request failed",
    {
      requestId: (req as Request & { requestId?: string }).requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode,
      message,
      errorCode: err.code || "INTERNAL_ERROR",
      stack: err.stack,
    },
  );

  responseHelper.error(res, {
    message,
    status: statusCode,
    errorCode: err.code || "INTERNAL_ERROR",
  });
};
