import express from "express";
import {
  getMyBoard,
  // movePawnFromFE,
  getMrsByFlm,
  updateMrAccess,
  getFlmStats,
  getPendingPrescriptionsForFlm,
  getPendingUploadsForFlm,
  reviewUpload,
  downloadUploadImage,
  viewUploadImage,
  getRecentMatches,
  getUserStats,
  getPrescriptionForFlm,
  getUploadForFlm,
  getMovesLeaderboard,
  getLeaderboardDateFilters,
  getMovesEarnedLeaderboard,
  getMovesLostLeaderboard,
  getPointsLeaderboard,
  getKillsLeaderboard,
  getMrPointsLeaderboard,
  getDiceRollBalanceLeaderboard,
  getHomeLeaderboard,
  getPrescriptionPointsLeaderboard
} from "../controllers/flmController.js";

const router = express.Router();

router.get("/board/:userId", getMyBoard);
// router.post("/move", movePawn);
// router.post("/move", movePawnFromFE);

router.get("/recent-matches", getRecentMatches);
router.get("/user/stats", getUserStats);


router.get("/leaderboard/filters", getLeaderboardDateFilters);
router.get("/leaderboard/moves", getMovesLeaderboard);
router.get("/leaderboard/moves-earned", getMovesEarnedLeaderboard);
router.get("/leaderboard/moves-lost", getMovesLostLeaderboard);
router.get("/leaderboard/kills", getKillsLeaderboard);
router.get("/leaderboard/mr-points", getMrPointsLeaderboard);
router.get("/leaderboard/dice-roll-balance", getDiceRollBalanceLeaderboard);
router.get("/leaderboard/home", getHomeLeaderboard);
// router.get("/leaderboard/points", getPointsLeaderboard);
// router.get("/leaderboard/prescription-points", getPrescriptionPointsLeaderboard);

// router.get("/:flmId/prescriptions/pending", getPendingPrescriptionsForFlm);
router.get("/:flmId/uploads/pending", getPendingUploadsForFlm);
// router.post("/:flmId/prescriptions/:prescriptionId/review", reviewPrescription);
router.post("/:flmId/uploads/:uploadId/review", reviewUpload);
// router.get("/:flmId/prescriptions/:prescriptionId/download", downloadUploadImage);
router.get("/:flmId/uploads/:uploadId/download", downloadUploadImage);
router.get("/:flmId/uploads/:uploadId/view", viewUploadImage);
// router.get("/:flmId/prescriptions/:prescriptionId", getPrescriptionForFlm);
router.get("/:flmId/uploads/:uploadId", getUploadForFlm);

router.get("/:flmId/mrs", getMrsByFlm);
router.patch("/:flmId/mrs/:mrId/access", updateMrAccess);

router.get("/stats/:flmId", getFlmStats);

export default router;
