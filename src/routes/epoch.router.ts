import { Router } from "express";
import stakingController from "../controllers/staking.controller";

class EpochRoutes {
  public path = "/epoch";
  public router: Router;

  constructor() {
    this.router = Router();
    this.initializeRoutes();
  }

  public initializeRoutes() {
    this.router.get(`${this.path}/status`, stakingController.getEpochStatus);
  }
}

export default new EpochRoutes().router;
