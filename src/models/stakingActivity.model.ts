import { DataTypes, Model } from "sequelize";
import sequelize from "./db.model";
import config from "../config/app.config";
import { StakingActivityAttributes } from "../interfaces/staking.interface";

class StakingActivity
  extends Model<StakingActivityAttributes>
  implements StakingActivityAttributes
{
  public txHash!: string;
  public blockNumber!: number;
  public timestamp!: number;
  public eventType!:
    | "Staked"
    | "Unstaked"
    | "StakeClaimed"
    | "StakeReallocated"
    | "Redelegated";
  public stakerAddress!: string;
  public poolAddress!: string;
  public fromPoolAddress?: string;
  public toPoolAddress?: string;
  public amount!: string;
  public rawAmount!: string;
  public unbondingPayout?: string;
  public unbondingPayoutRaw?: string;
  public logIndex!: number;
  public contractVersion!: string;
}

StakingActivity.init(
  {
    txHash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    blockNumber: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    logIndex: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    contractVersion: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "v1",
    },
    eventType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    stakerAddress: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    poolAddress: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    fromPoolAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    toPoolAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    amount: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rawAmount: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    unbondingPayout: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    unbondingPayoutRaw: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "StakingActivity",
    schema: config.DB.SCHEMA,
    indexes: [
      {
        unique: true,
        fields: ["txHash", "logIndex", "contractVersion"],
        name: "staking_activity_versioned_log_unique",
      },
      {
        fields: ["stakerAddress", "timestamp"],
      },
      {
        fields: ["timestamp"],
      },
    ],
  },
);

export default StakingActivity;
