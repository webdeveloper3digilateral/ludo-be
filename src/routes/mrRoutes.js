import express from "express";
import multer from "multer";
import {
  uploadPrescription,
  getMyPrescriptions,
  getBrands,
} from "../controllers/mrController.js";

const router = express.Router();

// Configure multer for memory storage (we'll write to disk in controller)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept image files only
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

router.post("/uploadPrescription/:mrId", upload.single("prescriptionImage"), uploadPrescription);
router.get("/brands", getBrands);
router.get("/:mrId/prescriptions", getMyPrescriptions);

export default router;
