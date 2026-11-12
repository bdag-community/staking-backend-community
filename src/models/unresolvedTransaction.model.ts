import { DataTypes, Model } from "sequelize";
import sequelize from "./db.model";
import config from "../config/app.config";
import { UnresolvedTransactionAttributes } from "../interfaces/staking.interface";

class UnresolvedTransaction
  extends Model<UnresolvedTransactionAttributes>
  implements UnresolvedTransactionAttributes
{
  public txHash!: string;
  public stakerAddress!: string;
  public poolAddress?: string | null;
  public nonce?: number | null;
  public action?: string | null;
  public status!:
    | "pending"
    | "stuck"
    | "missing"
    | "nonce_gap"
    | "replaced"
    | "confirmed"
    | "reverted";
  public blockNumber?: number | null;
  public receiptStatus?: string | null;
  public chainNonce?: number | null;
  public pendingNonce?: number | null;
  public gapFromNonce?: number | null;
  public repairStatus?:
    | "checking"
    | "not_needed"
    | "skipped"
    | "unavailable"
    | "signature_required"
    | "submitted"
    | "confirmed"
    | "failed"
    | null;
  public repairReason?: string | null;
  public repairTxPlan?:
    | {
        nonce: number;
        kind: "claim" | "cancel";
        to: string;
        data: string;
        value: string;
        gasLimit: string;
        maxFeePerGas: string;
        maxPriorityFeePerGas: string;
      }[]
    | null;
  public repairTxHashes?: { nonce: number; hash: string; kind: string }[] | null;
  public repairNonceStart?: number | null;
  public repairNonceEnd?: number | null;
  public repairLastAttemptAt?: Date | null;
  public firstSeenAt!: Date;
  public lastCheckedAt?: Date | null;
}

UnresolvedTransaction.init(
  {
    txHash: {
      type: DataTypes.STRING,
      allowNull: false,
      primaryKey: true,
    },
    stakerAddress: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    poolAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    nonce: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    action: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "pending",
    },
    blockNumber: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    receiptStatus: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    chainNonce: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    pendingNonce: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    gapFromNonce: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    repairStatus: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    repairReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    repairTxPlan: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    repairTxHashes: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    repairNonceStart: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    repairNonceEnd: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    repairLastAttemptAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    firstSeenAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    lastCheckedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "UnresolvedTransaction",
    schema: config.DB.SCHEMA,
    indexes: [
      {
        fields: ["stakerAddress", "status"],
      },
      {
        fields: ["nonce"],
      },
    ],
  },
);

export default UnresolvedTransaction;
