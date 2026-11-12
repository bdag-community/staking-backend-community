import { DataTypes, Model } from "sequelize";
import sequelize from "./db.model";
import config from "../config/app.config";
import {
  VisibilityAction,
  VisibilityActionAttemptAttributes,
  VisibilityAttemptStatus,
} from "../interfaces/visibility.interface";

class VisibilityActionAttempt
  extends Model<VisibilityActionAttemptAttributes>
  implements VisibilityActionAttemptAttributes
{
  public attemptId!: string;
  public action!: VisibilityAction;
  public status!: VisibilityAttemptStatus;
  public success!: boolean;
  public stakerAddress?: string | null;
  public poolAddress?: string | null;
  public txHash?: string | null;
  public amountRaw?: string | null;
  public amountFormatted?: string | null;
  public firstStageAt!: Date;
  public lastStageAt!: Date;
  public durationMs?: number | null;
  public finalErrorCode?: string | null;
  public finalErrorMessage?: string | null;
  public metadata?: Record<string, unknown> | null;
}

VisibilityActionAttempt.init(
  {
    attemptId: {
      type: DataTypes.STRING,
      allowNull: false,
      primaryKey: true,
    },
    action: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "started",
    },
    success: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    stakerAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    poolAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    txHash: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    amountRaw: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    amountFormatted: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    firstStageAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    lastStageAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    durationMs: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    finalErrorCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    finalErrorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "VisibilityActionAttempt",
    schema: config.DB.SCHEMA,
    indexes: [
      {
        fields: ["action", "status", "lastStageAt"],
      },
      {
        fields: ["stakerAddress", "lastStageAt"],
      },
      {
        fields: ["txHash"],
      },
      {
        fields: ["lastStageAt"],
      },
    ],
  },
);

export default VisibilityActionAttempt;
