import { Router } from "express";
import stakingController from "../controllers/staking.controller";
import { validateParams } from "../middlewares/validate.middleware";

class StakingRoutes {
  public path = "/staker";
  public router: Router;

  constructor() {
    this.router = Router();
    this.initializeRoutes();
  }

  public initializeRoutes() {
    this.router.get(
      `${this.path}/totalStaked/:stakerAddress`,
      validateParams(["stakerAddress"]),
      stakingController.getStakerTotalStaked,
    );
    this.router.get(
      `${this.path}/:stakerAddress/pool/:poolAddress`,
      validateParams(["stakerAddress", "poolAddress"]),
      stakingController.getStakerInfo,
    );
    this.router.get(
      `${this.path}/recentHistory/:stakerAddress`,
      validateParams(["stakerAddress"]),
      stakingController.getRecentHistory,
    );
    this.router.get(
      `${this.path}/rewards/:stakerAddress`,
      validateParams(["stakerAddress"]),
      stakingController.getUserRewardsAcrossPools,
    );
    this.router.get(
      `${this.path}/pools/:stakerAddress`,
      validateParams(["stakerAddress"]),
      stakingController.getUserStakedPoolsHistory,
    );
    this.router.get(
      `${this.path}/portfolioHistory/:stakerAddress`,
      validateParams(["stakerAddress"]),
      stakingController.getUserPortfolioHistory,
    );
    this.router.get(
      `${this.path}/assetAllocation/:stakerAddress`,
      validateParams(["stakerAddress"]),
      stakingController.getUserAssetAllocation,
    );
  }
}

export default new StakingRoutes().router;
