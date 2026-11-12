import { Router } from "express";
import visibilityController from "../controllers/visibility.controller";

class VisibilityRoutes {
  public router: Router;

  constructor() {
    this.router = Router();
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.post("/events", visibilityController.recordEvent);
    this.router.get("/summary", visibilityController.getSummary);
    this.router.get("/actions", visibilityController.getSummary);
    this.router.get("/failures", visibilityController.getFailures);
    this.router.get("/attempts", visibilityController.getAttempts);
    this.router.get("/health", visibilityController.getHealth);
  }
}

export default new VisibilityRoutes().router;
