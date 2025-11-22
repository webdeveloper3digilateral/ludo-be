import express from "express";
import {
  startGame,
  startGameWithExpiration,
  createBrand,
  updateBrand,
  getBrandById,
  getAllBrands,
  createCamp,
  updateCamp,
  getCampById,
  getAllCamps,
  addMoveAdjustmentConfig,
  resetBoards,
  givePoints,
  startManualGame
  // applyMedianMoveAdjustment,
} from "../controllers/adminController.js";

const router = express.Router();

router.post("/startGame", startGame);
router.post("/startGameWithExpiration", startGameWithExpiration);
router.post("/resetBoards", resetBoards);
router.post("/givePoints", givePoints);

// Brand management routes
router.post("/brands", createBrand);
router.get("/brands", getAllBrands);
router.get("/brands/:id", getBrandById);
router.put("/brands/:id", updateBrand);

// Camp management routes
router.post("/camps", createCamp);
router.get("/camps", getAllCamps);
router.get("/camps/:id", getCampById);
router.put("/camps/:id", updateCamp);


router.post("/startManualGame",startManualGame)

//point-move config
// router.post("/moves/median-adjustment", addMoveAdjustmentConfigs);
router.post("/moves/adjustment-config", addMoveAdjustmentConfig);


export default router;
