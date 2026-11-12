import { DataTypes, Model } from "sequelize";
import sequelize from "./db.model";
import config from "../config/app.config";
export interface PortfolioHistoryAttributes {
  id?: number;
  stakerAddress: string;
  totalValue: string;
  timestamp: Date;
}

class PortfolioHistory
  extends Model<PortfolioHistoryAttributes>
  implements PortfolioHistoryAttributes
{
  public id!: number;
  public stakerAddress!: string;
  public totalValue!: string;
  public timestamp!: Date;
}

PortfolioHistory.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    stakerAddress: { type: DataTypes.STRING, allowNull: false },
    totalValue: { type: DataTypes.STRING, allowNull: false },
    timestamp: { type: DataTypes.DATE, allowNull: false },
  },
  {
    sequelize,
    modelName: "PortfolioHistory",
    schema: config.DB.SCHEMA,
    indexes: [
      {
        unique: true,
        fields: ["stakerAddress", "timestamp"],
        name: "portfolio_history_staker_timestamp_unique",
      },
    ],
  },
);

export default PortfolioHistory;
