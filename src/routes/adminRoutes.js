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
  createUploadType,
  updateUploadType,
  getUploadTypeById,
  getAllUploadTypes,
  deleteUploadType,
  createActivityType,
  updateActivityType,
  getActivityTypeById,
  getAllActivityTypes,
  deleteActivityType,
  config,
  updateConfig,
  resetBoards,
  givePoints,
  startManualGame,
  giveDiceRollsToPlayers,
  giveDiceRollsToRole,
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

// Upload Types management routes (old APIs - kept for backward compatibility)
router.post("/upload-types", createUploadType);
router.get("/upload-types", getAllUploadTypes);
router.get("/upload-types/:id", getUploadTypeById);
router.put("/upload-types/:id", updateUploadType);
router.delete("/upload-types/:id", deleteUploadType);

// Activity Types management routes (new APIs with activitySpecificFields support)
router.post("/activity-types", createActivityType);
router.get("/activity-types", getAllActivityTypes);
router.get("/activity-types/:id", getActivityTypeById);
router.put("/activity-types/:id", updateActivityType);
router.delete("/activity-types/:id", deleteActivityType);

router.post("/startManualGame",startManualGame)

//point-move config
// router.post("/moves/median-adjustment", configs);
router.post("/moves/config", config);
router.put("/moves/config/:id", updateConfig);

router.post("/giveDiceRollsToPlayers",giveDiceRollsToPlayers)
router.post("/giveDiceRollsToRole", giveDiceRollsToRole)


export default router;
