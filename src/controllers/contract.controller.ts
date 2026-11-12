import { Request, Response } from "express";
import { catchAsync } from "../middlewares/catchAsync.middleware";
import responseHelper from "../helpers/response.helper";
import contractService from "../services/contract.service";

class ContractController {
  public getContractInfo = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const data = await contractService.getContractInfo();
      responseHelper.success(res, { data });
    },
  );
}

export default new ContractController();
export { ContractController };
