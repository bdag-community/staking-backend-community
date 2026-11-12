import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import responseHelper from "../helpers/response.helper";
import { ERROR_MESSAGES } from "../constants";
import { STATUS_CODES } from "../constants";

const routeConfigs = [
  { path: "/pools", limit: 30, windowMs: 60 * 1000 },
  { path: "/staker", limit: 30, windowMs: 60 * 1000 },
  { path: "/epoch", limit: 30, windowMs: 60 * 1000 },
  { path: "default", limit: 100, windowMs: 60 * 1000 },
];

const routeLimiters: Record<string, any> = {};

routeConfigs.forEach((cfg) => {
  routeLimiters[cfg.path] = rateLimit({
    windowMs: cfg.windowMs,
    max: cfg.limit,
    standardHeaders: true,
    legacyHeaders: true,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip || "::1")}-${cfg.path}`,
    handler: (req, res) => {
      return responseHelper.error(res, {
        message: ERROR_MESSAGES.TOO_MANY_ATTEMPTS(cfg.path),
        status: STATUS_CODES.TOO_MANY_REQUESTS,
      });
    },
  });
});

export const dynamicRateLimiter = (req: any, res: any, next: any) => {
  const pathKey = Object.keys(routeLimiters).find((path) =>
    req.path.endsWith(path)
  );

  if (pathKey) {
    return routeLimiters[pathKey](req, res, next);
  } else {
    return routeLimiters["default"](req, res, next);
  }
};
