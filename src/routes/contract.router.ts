import { Router } from "express";
import contractController from "../controllers/contract.controller";

class ContractRoutes {
  public path = "/contract";
  public router: Router;

  constructor() {
    this.router = Router();
    this.initializeRoutes();
  }

  public initializeRoutes() {
    this.router.get(`${this.path}/info`, contractController.getContractInfo);
  }
}

export default new ContractRoutes().router;
