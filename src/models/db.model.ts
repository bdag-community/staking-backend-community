import { Sequelize } from "sequelize";
import config from "../config/app.config";
import logger from "../helpers/logger.helper";

const sequelize = new Sequelize(
  config.DB.NAME,
  config.DB.USER,
  config.DB.PASS,
  {
    host: config.DB.HOST,
    port: config.DB.PORT,
    dialectOptions:
      config.DB.SSL == "true"
        ? {
            ssl: {
              required: true,
              rejectUnauthorized: false,
            },
          }
        : {},
    dialect: "postgres",
    logging: (msg) => logger.debug(msg),
    pool: {
      max: 20,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    define: {
      schema: config.DB.SCHEMA,
    },
  },
);

export default sequelize;
