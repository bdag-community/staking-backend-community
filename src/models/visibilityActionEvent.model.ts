import { DataTypes, Model } from "sequelize";
import sequelize from "./db.model";
import config from "../config/app.config";
import {
  VisibilityAction,
  VisibilityActionEventAttributes,
  VisibilityStage,
} from "../interfaces/visibility.interface";

class VisibilityActionEvent
  extends Model<VisibilityActionEventAttributes>
  implements VisibilityActionEventAttributes
{
  public id?: number;
  public attemptId!: string;
  public action!: VisibilityAction;
  public stage!: VisibilityStage;
  public success!: boolean;
  public stakerAddress?: string | null;
  public poolAddress?: string | null;
  public txHash?: string | null;
  public amountRaw?: string | null;
  public amountFormatted?: string | null;
  public nonce?: number | null;
  public blockNumber?: number | null;
  public durationMs?: number | null;
  public errorCode?: string | null;
  public errorMessage?: string | null;
  public metadata?: Record<string, unknown> | null;
}

VisibilityActionEvent.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    attemptId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    action: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    stage: {
      type: DataTypes.STRING,
      allowNull: false,
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
    nonce: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    blockNumber: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    durationMs: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    errorCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    errorMessage: {
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
    modelName: "VisibilityActionEvent",
    schema: config.DB.SCHEMA,
    indexes: [
      {
        fields: ["attemptId"],
      },
      {
        fields: ["action", "stage", "createdAt"],
      },
      {
        fields: ["stakerAddress", "createdAt"],
      },
      {
        fields: ["txHash"],
      },
      {
        fields: ["createdAt"],
      },
    ],
  },
);

export default VisibilityActionEvent;
