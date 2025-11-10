import express from "express";
import {
  getMyBoard,
  movePawnFromFE,
  getMrsByFlm,
  updateMrAccess,
  getFlmStats,
} from "../controllers/flmController.js";

const router = express.Router();

router.get("/board/:userId", getMyBoard);
// router.post("/move", movePawn);
router.post("/move", movePawnFromFE);

router.get("/:flmId/mrs", getMrsByFlm);
router.patch("/:flmId/mrs/:mrId/access", updateMrAccess);

router.get("/:flmId/stats", getFlmStats);

export default router;
