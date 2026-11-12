import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import routes from "./routes/index.router";
import { errorHandler } from "./middlewares/error.middleware";
import { requestLogger } from "./middlewares/logger.middleware";
// import { dynamicRateLimiter } from "./middlewares/rateLimiting.middleware";
import responseHelper from "./helpers/response.helper";
import {allowedApiOrigin} from './middlewares/origin-policy';
import {rateLimit} from 'express-rate-limit';

const app = express();

app.use(helmet());
app.use((req,res,next)=>{
  if(!allowedApiOrigin(req.headers.origin,process.env.BROWSER_ORIGINS)) {res.status(403).json({success:false,message:'Origin not allowed'});return;}
  next();
});
app.use(cors({origin:(origin,callback)=>callback(null,allowedApiOrigin(origin,process.env.BROWSER_ORIGINS))}));
app.use(express.json({limit:'128kb'}));
app.use(rateLimit({windowMs:60000,limit:300,standardHeaders:'draft-8',legacyHeaders:false}));

// app.use(dynamicRateLimiter);
app.use(requestLogger);

app.use("/api/v1", routes);

app.get("/health", (req: Request, res: Response) => {
  responseHelper.success(res, { message: "API is running", data: {} });
});

// Use error handling middleware
app.use(errorHandler);

export default app;
