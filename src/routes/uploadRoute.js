import express from "express";
import { handleExcelSheetUpload } from "../controllers/uploadExcelController.js";

const router = express.Router();

router.get("/excel", handleExcelSheetUpload);

export default router;