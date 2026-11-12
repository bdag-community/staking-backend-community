import { Request, Response } from "express";
import stakingService from "../services/staking.service";
import { catchAsync } from "../middlewares/catchAsync.middleware";
import stakingHelper from "../helpers/staking.helper";
import responseHelper from "../helpers/response.helper";
import { PoolStatus } from "../constants/blockchain.constants";
import { AppError } from "../helpers/appError.helper";

class StakingController {
  public getPoolStats = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const poolAddress = stakingHelper.getParam(req, "poolAddress");
      const poolTotalStaked =
        await stakingService.getPoolTotalStaked(poolAddress);

      responseHelper.success(res, { data: { poolTotalStaked } });
    },
  );

  public getStakerTotalStaked = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const stakerAddress = stakingHelper.getParam(req, "stakerAddress");
      const data = await stakingService.getStakerTotalStaked(stakerAddress);
      responseHelper.success(res, { data });
    },
  );

  public getStakerInfo = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const stakerAddress = stakingHelper.getParam(req, "stakerAddress");
      const poolAddress = stakingHelper.getParam(req, "poolAddress");

      const [pendingReward, stakedAmount] = await Promise.all([
        stakingService.getPendingReward(stakerAddress, poolAddress),
        stakingService.getStakerAmount(poolAddress, stakerAddress),
      ]);

      responseHelper.success(res, {
        data: {
          stakedAmount,
          pendingReward,
        },
      });
    },
  );

  public getEpochStatus = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const data = await stakingService.getEpochStatus();
      responseHelper.success(res, { data });
    },
  );

  public listPools = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const limit = parseInt(req.query.limit as string) || 10;
      const cursor = req.query.cursor as string;
      const statusParam = (req.query.status as string) ?? PoolStatus.ALL;
      const search = req.query.search as string;

      const data = await stakingService.getPools(
        limit,
        cursor,
        statusParam as PoolStatus,
        search,
      );
      responseHelper.success(res, { data });
    },
  );

  public getPoolDetail = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const poolAddress = stakingHelper.getParam(req, "poolAddress");
      const data = await stakingService.getPoolDetail(poolAddress);

      if (!data) throw new AppError("Pool not found", 404);

      responseHelper.success(res, { data });
    },
  );

  public getGlobalStats = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const data = await stakingService.getGlobalStats();
      responseHelper.success(res, { data });
    },
  );

  public getRecentHistory = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const stakerAddress = stakingHelper.getParam(req, "stakerAddress");
      const limit = parseInt(req.query.limit as string) || 10;
      const cursor = req.query.cursor as string;

      const data = await stakingService.getRecentHistory(
        stakerAddress,
        limit,
        cursor,
      );
      responseHelper.success(res, { data });
    },
  );

  public getUserRewardsAcrossPools = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const stakerAddress = stakingHelper.getParam(req, "stakerAddress");
      const data =
        await stakingService.getUserRewardsAcrossPools(stakerAddress);

      responseHelper.success(res, { data });
    },
  );

  public getUserStakedPoolsHistory = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const stakerAddress = stakingHelper.getParam(req, "stakerAddress");
      const limit = parseInt(req.query.limit as string) || 10;
      const cursor = req.query.cursor as string;

      const data = await stakingService.getUserStakedPoolsHistory(
        stakerAddress,
        limit,
        cursor,
      );
      responseHelper.success(res, { data });
    },
  );

  public getTopPools = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const data = await stakingService.getTopPools();
      responseHelper.success(res, { data });
    },
  );

  public getUserPortfolioHistory = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const stakerAddress = stakingHelper.getParam(req, "stakerAddress");
      const range = (req.query.range as string) || "7D";
      const data = await stakingService.getUserPortfolioHistory(
        stakerAddress,
        range,
      );
      responseHelper.success(res, { data });
    },
  );

  public getUserAssetAllocation = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const stakerAddress = stakingHelper.getParam(req, "stakerAddress");
      const data = await stakingService.getUserAssetAllocation(stakerAddress);
      responseHelper.success(res, { data });
    },
  );

  public updatePoolMetadata = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const poolAddress = stakingHelper.getParam(req, "poolAddress");
      const { name, subtitle } = req.body;

      const updateData: { name?: string; subtitle?: string } = {};
      if (name !== undefined) updateData.name = name;
      if (subtitle !== undefined) updateData.subtitle = subtitle;

      await stakingService.updatePoolMetadata(poolAddress, updateData);

      responseHelper.success(res, {
        data: { poolAddress, ...updateData },
        message: "Pool metadata updated successfully",
      });
    },
  );

  public trackTransaction = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const data = await stakingService.trackTransaction({
        attemptId: req.body.attemptId,
        txHash: req.body.txHash,
        stakerAddress: req.body.stakerAddress,
        poolAddress: req.body.poolAddress,
        nonce: req.body.nonce,
        action: req.body.action,
        status: req.body.status,
      });

      responseHelper.success(res, {
        data,
        message: "Transaction tracking updated",
      });
    },
  );

  public getTrackedTransaction = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const txHash = stakingHelper.getParam(req, "txHash");
      const data = await stakingService.getTrackedTransaction(txHash);

      responseHelper.success(res, { data });
    },
  );

  public checkWalletNonceRepair = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const stakerAddress = stakingHelper.getParam(req, "stakerAddress");
      const data = await stakingService.checkWalletNonceRepair(stakerAddress);

      responseHelper.success(res, { data });
    },
  );

  public trackTransactionRepair = catchAsync(
    async (req: Request, res: Response): Promise<void> => {
      const txHash = stakingHelper.getParam(req, "txHash");
      const data = await stakingService.trackTransactionRepair(txHash, {
        repairTxHashes: req.body.repairTxHashes,
      });

      responseHelper.success(res, {
        data,
        message: "Transaction repair tracking updated",
      });
    },
  );
}

export default new StakingController();
export { StakingController };
