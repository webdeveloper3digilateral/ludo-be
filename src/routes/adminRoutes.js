import express from "express";
import {
  startGame,
  createBrand,
  updateBrand,
  getBrandById,
  getAllBrands,
  applyMedianMoveAdjustment,
} from "../controllers/adminController.js";

const router = express.Router();

router.post("/startGame", startGame);

// Brand management routes
router.post("/brands", createBrand);
router.get("/brands", getAllBrands);
router.get("/brands/:id", getBrandById);
router.put("/brands/:id", updateBrand);

//point-move config
router.post("/moves/median-adjustment", applyMedianMoveAdjustment);


export default router;
