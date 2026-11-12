import { Router } from "express";
import governanceController from "../controllers/governance.controller";

const router = Router();
router.get("/contracts", governanceController.contracts);
router.get("/epochs/:epoch", governanceController.epoch);
router.get("/credentials/:wallet", governanceController.credentials);
router.get("/voting-pools/:wallet", governanceController.votingPools);
router.get("/eligibility/:epoch", governanceController.eligibility);
router.get("/staker/:wallet/legacy", governanceController.legacy);
router.get("/pools/:address/figures", governanceController.poolFigures);
router.post("/pools/register", governanceController.registerPool);
export default router;
