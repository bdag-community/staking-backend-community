import { DataTypes, Model } from "sequelize";
import sequelize from "./db.model";
import config from "../config/app.config";

interface IndexerStateAttributes {
  key: string;
  lastBlock: number;
}

class IndexerState
  extends Model<IndexerStateAttributes>
  implements IndexerStateAttributes {
  public key!: string;
  public lastBlock!: number;
}

IndexerState.init(
  {
    key: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      primaryKey: true,
    },
    lastBlock: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    modelName: "IndexerState",
    timestamps: true,
    schema: config.DB.SCHEMA,
  },
);

export default IndexerState;
