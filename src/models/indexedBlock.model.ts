import { DataTypes, Model } from "sequelize";
import sequelize from "./db.model";
import config from "../config/app.config";

export class IndexedBlock extends Model {
  declare blockNumber: number;
  declare blockHash: string;
  declare parentHash: string;
  declare miner: string | null;
  declare timestamp: number;
}

IndexedBlock.init({
  blockNumber: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
  blockHash: { type: DataTypes.STRING, allowNull: false },
  parentHash: { type: DataTypes.STRING, allowNull: false },
  miner: { type: DataTypes.STRING, allowNull: true },
  timestamp: { type: DataTypes.INTEGER, allowNull: false },
}, { sequelize, modelName: "IndexedBlock", schema: config.DB.SCHEMA, indexes: [{ fields: ["blockHash"] }] });
