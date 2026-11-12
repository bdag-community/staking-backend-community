import { Request, Response } from "express";
import { catchAsync } from "../middlewares/catchAsync.middleware";
import responseHelper from "../helpers/response.helper";
import governanceService from "../services/governance.service";

class GovernanceController {
  private param(value: string | string[] | undefined, name: string): string {
    if (typeof value !== "string") throw new Error(`Invalid ${name}`);
    return value;
  }
  public contracts = catchAsync(async (_req: Request, res: Response) => { responseHelper.success(res, { data: governanceService.getContracts() }); });
  public epoch = catchAsync(async (req: Request, res: Response) => { responseHelper.success(res, { data: await governanceService.getEpoch(this.param(req.params.epoch, "epoch")) }); });
  public credentials = catchAsync(async (req: Request, res: Response) => { responseHelper.success(res, { data: await governanceService.getCredentials(this.param(req.params.wallet, "wallet")) }); });
  public votingPools = catchAsync(async (req: Request, res: Response) => { responseHelper.success(res, { data: await governanceService.getVotingPools(this.param(req.params.wallet, "wallet")) }); });
  public eligibility = catchAsync(async (req: Request, res: Response) => { responseHelper.success(res, { data: await governanceService.getEligibility(this.param(req.params.epoch, "epoch")) }); });
  public legacy = catchAsync(async (req: Request, res: Response) => { responseHelper.success(res, { data: await governanceService.getLegacy(this.param(req.params.wallet, "wallet")) }); });
  public poolFigures = catchAsync(async (req: Request, res: Response) => { responseHelper.success(res, { data: await governanceService.getPoolFigures(this.param(req.params.address, "address")) }); });
  public registerPool = catchAsync(async (req: Request, res: Response) => { responseHelper.success(res, { status: 201, data: await governanceService.registerPool(req.body) }); });
}

export default new GovernanceController();
