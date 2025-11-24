import express from "express";
import multer from "multer";
import {
  uploadFile,
  uploadPrescription,
  getMyPrescriptions,
  getBrands,
  getCamps,
  getRejectedUploads,
  getRejectedUploadsById,
  resubmitUploads,
  downloadUploadImageForMr,
  viewUploadImageForMr
} from "../controllers/mrController.js";
import { getAllActivityTypes } from "../controllers/adminController.js";

const router = express.Router();

// Configure multer for memory storage 
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only JPG and JPEG formats
    const allowedMimeTypes = ["image/jpeg", "image/jpg"];
    const allowedExtensions = [".jpg", ".jpeg"];
    
    const fileExtension = file.originalname
      .toLowerCase()
      .substring(file.originalname.lastIndexOf("."));
    
    if (
      allowedMimeTypes.includes(file.mimetype.toLowerCase()) &&
      allowedExtensions.includes(fileExtension)
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG and JPEG image formats are allowed"), false);
    }
  },
});

// Unified upload endpoint for all types (prescription, pob, camp)
router.post("/upload/:mrId", upload.single("uploadImage"), uploadFile);
// router.post("/uploadPrescription/:mrId", upload.single("prescriptionImage"), uploadPrescription);
router.get("/brands", getBrands);
router.get("/camps", getCamps);
router.get("/activity-types", getAllActivityTypes);
router.get("/:mrId/uploads/rejected/:uploadId", getRejectedUploadsById);
router.get("/:mrId/uploads/rejected", getRejectedUploads);
router.put("/:mrId/uploads/:uploadId/resubmit",upload.single("uploadImage"),resubmitUploads);
router.get("/:mrId/prescriptions", getMyPrescriptions);
router.get("/:mrId/uploads/:uploadId/download", downloadUploadImageForMr);
router.get("/:mrId/uploads/:uploadId/view", viewUploadImageForMr);


export default router;
