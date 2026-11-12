import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import logger from "../helpers/logger.helper";

export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const startedAt = Date.now();
  const requestId = req.get("x-request-id") || randomUUID();

  res.setHeader("x-request-id", requestId);
  (req as Request & { requestId?: string }).requestId = requestId;

  res.on("finish", () => {
    logger.info("HTTP request completed", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      ip: req.ip,
    });
  });

  next();
};
