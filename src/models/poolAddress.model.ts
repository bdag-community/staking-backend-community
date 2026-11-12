import { DataTypes, Model } from "sequelize";
import sequelize from "./db.model";
import config from "../config/app.config";

import { PoolStatus } from "../constants/blockchain.constants";

interface PoolAddressAttributes {
  address: string;
  name?: string;
  firstSeenBlock: number;
  lastSeenBlock: number;
  lastSeenTimestamp?: number;
  subtitle?: string;
  status: string;
  tags?: string[];
  tagsUpdatedAt?: Date;
  updatedAt?: Date;
}

class PoolAddress
  extends Model<PoolAddressAttributes>
  implements PoolAddressAttributes
{
  public address!: string;
  public name?: string;
  public subtitle?: string;
  public firstSeenBlock!: number;
  public lastSeenBlock!: number;
  public lastSeenTimestamp?: number;
  public status!: string;
  public tags?: string[];
  public tagsUpdatedAt?: Date;
}

PoolAddress.init(
  {
    address: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    subtitle: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    firstSeenBlock: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    lastSeenBlock: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    lastSeenTimestamp: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM(PoolStatus.ACTIVE, PoolStatus.INACTIVE),
      allowNull: false,
      defaultValue: PoolStatus.INACTIVE,
    },
    tags: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: [],
    },
    tagsUpdatedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: "PoolAddress",
    timestamps: true,
    schema: config.DB.SCHEMA,
    indexes: [
      {
        fields: ["lastSeenBlock", "address"],
      },
      {
        fields: ["lastSeenTimestamp"],
      },
      {
        fields: ["status"],
      },
      {
        fields: ["name"],
      },
    ],
  }
);

export default PoolAddress;
