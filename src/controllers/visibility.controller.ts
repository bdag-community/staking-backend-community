import { Request, Response } from "express";
import { catchAsync } from "../middlewares/catchAsync.middleware";
import responseHelper from "../helpers/response.helper";
import visibilityService from "../services/visibility.service";

class VisibilityController {
  public recordEvent = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const data = await visibilityService.recordEvent(req.body);
      responseHelper.success(res, {
        status: 201,
        data,
        message: "Visibility event recorded",
      });
    },
  );

  public getSummary = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const data = await visibilityService.getSummary(req.query);
      responseHelper.success(res, { data });
    },
  );

  public getFailures = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const data = await visibilityService.getFailures(req.query);
      responseHelper.success(res, { data });
    },
  );

  public getAttempts = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const data = await visibilityService.getAttempts(req.query);
      responseHelper.success(res, { data });
    },
  );

  public getHealth = catchAsync(
    async (_req: Request, res: Response): Promise<void> => {
      const data = await visibilityService.getHealth();
      responseHelper.success(res, { data });
    },
  );
}

export default new VisibilityController();
