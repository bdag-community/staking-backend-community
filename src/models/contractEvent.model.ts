import { DataTypes, Model } from "sequelize";
import sequelize from "./db.model";
import config from "../config/app.config";

export class ContractEvent extends Model {
  declare txHash: string;
  declare logIndex: number;
  declare blockNumber: number;
  declare blockHash: string;
  declare contractAddress: string;
  declare contractVersion: string;
  declare eventName: string;
  declare payload: Record<string, string>;
}

ContractEvent.init({
  txHash: { type: DataTypes.STRING, allowNull: false },
  logIndex: { type: DataTypes.INTEGER, allowNull: false },
  blockNumber: { type: DataTypes.INTEGER, allowNull: false },
  blockHash: { type: DataTypes.STRING, allowNull: false },
  contractAddress: { type: DataTypes.STRING, allowNull: false },
  contractVersion: { type: DataTypes.STRING, allowNull: false },
  eventName: { type: DataTypes.STRING, allowNull: false },
  payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
}, {
  sequelize, modelName: "ContractEvent", schema: config.DB.SCHEMA,
  indexes: [
    { unique: true, fields: ["txHash", "logIndex", "contractVersion"], name: "contract_events_versioned_log_unique" },
    { fields: ["blockNumber"] },
    { fields: ["eventName", "blockNumber"] },
  ],
});
