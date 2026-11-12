import { Router } from "express";
import stakingController from "../controllers/staking.controller";
import { validateParams } from "../middlewares/validate.middleware";
import { PoolStatus } from "../constants/blockchain.constants";

class PoolRoutes {
  public path = "/pools";
  public router: Router;

  constructor() {
    this.router = Router();
    this.initializeRoutes();
  }

  public initializeRoutes() {
    this.router.get(`${this.path}`, stakingController.listPools);
    this.router.get(`${this.path}/active`, (req, res, next) => {
      req.query.status = PoolStatus.ACTIVE;
      stakingController.listPools(req, res, next);
    });
    this.router.get(`/topPools`, stakingController.getTopPools);
    this.router.get(
      `/pool/:poolAddress`,
      validateParams(["poolAddress"]),
      stakingController.getPoolDetail
    );
    this.router.put(
      `/pool/:poolAddress`,
      (_req, res) => res.status(410).json({ success: false, message: "Use POST /api/v1/pools/register with signed metadata, chain ID, issuedAt and nonce" })
    );
  }
}

export default new PoolRoutes().router;
