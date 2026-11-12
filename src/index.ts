import "./helpers/ethers-fetch.helper";
import app from "./app";
import config from "./config/app.config";
import logger from "./helpers/logger.helper";
import * as db from "./models/index.model";

const PORT = config.PORT;

const startServer = async (): Promise<void> => {
  try {
    await db.initDB();

    app.listen(PORT, process.env.LISTEN_HOST ?? "0.0.0.0", () => {
      logger.info(`Server running on ${PORT}`);
    });
  } catch (error: any) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
