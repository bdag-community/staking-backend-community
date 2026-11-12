import { Router } from "express";
import stakingRoutes from "./staker.router";
import poolRoutes from "./pool.router";
import epochRoutes from "./epoch.router";
import contractRoutes from "./contract.router";
import visibilityRoutes from "./visibility.router";
import stakingController from "../controllers/staking.controller";
import { validateParams } from "../middlewares/validate.middleware";
import governanceRoutes from "./governance.router";

class IndexRoutes {
  public router: Router;

  constructor() {
    this.router = Router();
    this.initializeRoutes();
  }

  public initializeRoutes() {
    this.router.use(stakingRoutes);
    this.router.use(poolRoutes);
    this.router.use(epochRoutes);
    this.router.use(contractRoutes);
    this.router.use(governanceRoutes);
    this.router.use("/visibility", visibilityRoutes);
    this.router.post(`/transactions/track`, stakingController.trackTransaction);
    this.router.get(
      `/transactions/nonce-repair/:stakerAddress`,
      validateParams(["stakerAddress"]),
      stakingController.checkWalletNonceRepair,
    );
    this.router.get(
      `/transactions/:txHash`,
      validateParams(["txHash"]),
      stakingController.getTrackedTransaction,
    );
    this.router.post(
      `/transactions/:txHash/repair`,
      validateParams(["txHash"]),
      stakingController.trackTransactionRepair,
    );
    this.router.get(`/globalStats`, stakingController.getGlobalStats);
    this.router.get(`/global-stats`, stakingController.getGlobalStats);
  }
}

export default new IndexRoutes().router;
