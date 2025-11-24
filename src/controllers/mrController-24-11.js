import db from "../config/db.js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "url";
import fs from "fs";
import {
  getISTDateTime,
  formatISTDateTimeForSQL,
  formatISTDateForSQL,
  formatISTTimeForSQL,
} from "../utils/istDateTime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base uploads directory
const baseUploadsDir = path.join(__dirname, "../../uploads");

// Function to get type-specific upload directory
const getUploadsDir = (type) => {
  const typeDir = type === "prescription" ? "prescriptions" : type === "pob" ? "pob" : "camps";
  const uploadsDir = path.join(baseUploadsDir, typeDir);
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  return uploadsDir;
};

// Capitalize first letter of each word
const capitalizeWords = (text) => {
  if (!text || typeof text !== 'string') return text;
  return text
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

const formatDoctorName = (name) => {
  if (name === undefined || name === null) return null;
  const raw = name.toString().trim();
  if (!raw) return null;
  const withoutPrefix = raw.replace(/^dr\.?\s*/i, "").trim();
  if (!withoutPrefix) return null;
  // Capitalize the name and add Dr. prefix
  const capitalizedName = capitalizeWords(withoutPrefix);
  return `Dr. ${capitalizedName}`.trim();
};

// Unified upload function for all types (prescription, pob, camp)
export const uploadFile = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { mrId } = req.params;
    const {
      type, // 'prescription', 'pob', or 'camp'
      // Prescription fields
      drName,
      speciality,
      mobNo,
      scCode,
      brandName,
      noRxns,
      rxnDuration,
      // POB fields
      chemistName,
      noOfUnits,
      allValue,
      // Camp fields
      campName,
      noOfCamps,
    } = req.body;

    // Validate type
    if (!type || !["prescription", "pob", "camp"].includes(type.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "Invalid type. Must be 'prescription', 'pob', or 'camp'",
      });
    }

    const normalizedType = type.toLowerCase();

    // Type-specific validation
    const missingFields = [];

    if (normalizedType === "prescription") {
      if (!brandName) missingFields.push("brandName");
      if (!noRxns) missingFields.push("noRxns");
      if (!drName) missingFields.push("drName");
      if (!scCode) missingFields.push("scCode");
    } else if (normalizedType === "pob") {
      if (!brandName) missingFields.push("brandName");
      if (!drName) missingFields.push("drName");
      if (!scCode) missingFields.push("scCode");
      // Note: noOfUnits or allValue validation will be done after brand is fetched
    } else if (normalizedType === "camp") {
      if (!campName) missingFields.push("campName");
      if (!noOfCamps) missingFields.push("noOfCamps");
      if (!drName) missingFields.push("drName");
      if (!scCode) missingFields.push("scCode");
    }

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Please fill all required details: ${missingFields.join(", ")}`,
      });
    }

    // Check if MR exists
    const [mrRows] = await connection.execute("SELECT * FROM mrs WHERE mrId = ?", [mrId]);

    if (mrRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "MR Id Not Found",
      });
    }

    let brand = null;
    let camp = null;
    let totalPoints = 0;
    let brandId = null;
    let brandNameValue = null;
    let campId = null;
    let campNameValue = null;
    let campDefaultFactor = null;

    // Handle brand-based types (prescription, pob)
    if (normalizedType === "prescription" || normalizedType === "pob") {
      // Trim and normalize brandName for case-insensitive matching
      const normalizedBrandName = brandName ? brandName.trim() : "";
      const [brandRows] = await connection.execute("SELECT * FROM brands WHERE LOWER(TRIM(brandName)) = LOWER(TRIM(?))", [normalizedBrandName]);

      if (brandRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Brand Not Found",
        });
      }

      brand = brandRows[0];
      brandId = brand.id;
      brandNameValue = brandName;
      const brandPoints = parseInt(brand.points) || 0;

      if (normalizedType === "prescription") {
        const noRxnsInt = parseInt(noRxns) || 1;
        const rxnDurationInt = rxnDuration
          ? parseInt(rxnDuration)
          : parseInt(brand.defaultRxnDuration) || 1;
        totalPoints = brandPoints * noRxnsInt * rxnDurationInt;
      } else if (normalizedType === "pob") {
        // Validate based on brand's countType
        const brandCountType = brand.countType ? brand.countType.toLowerCase() : null;
        
        if (brandCountType === "unit") {
          if (!noOfUnits) {
            return res.status(400).json({
              success: false,
              message: "noOfUnits is required for this brand (countType: unit)",
            });
          }
          const noOfUnitsInt = parseInt(noOfUnits) || 1;
          const rxnDurationInt = rxnDuration
            ? parseInt(rxnDuration)
            : parseInt(brand.defaultRxnDuration) || 1;
          const factor = parseInt(brand.unitFactor) || 1;
          totalPoints = brandPoints * noOfUnitsInt * rxnDurationInt * factor;
        } else if (brandCountType === "value") {
          if (!allValue) {
            return res.status(400).json({
              success: false,
              message: "allValue is required for this brand (countType: value)",
            });
          }
          const allValueInt = parseInt(allValue) || 1;
          const rxnDurationInt = rxnDuration
            ? parseInt(rxnDuration)
            : parseInt(brand.defaultRxnDuration) || 1;
          const factor = parseInt(brand.valueFactor) || 1;
          totalPoints = brandPoints * allValueInt * rxnDurationInt * factor;
        } else {
          // If brand doesn't have countType, use noOfUnits as fallback (backward compatibility)
          if (!noOfUnits && !allValue) {
            return res.status(400).json({
              success: false,
              message: "Either noOfUnits or allValue is required. Please check brand configuration.",
            });
          }
          const valueInt = parseInt(noOfUnits || allValue) || 1;
          const rxnDurationInt = rxnDuration
            ? parseInt(rxnDuration)
            : parseInt(brand.defaultRxnDuration) || 1;
          totalPoints = brandPoints * valueInt * rxnDurationInt;
        }
      }
    }
    // Handle camp type
    if (normalizedType === "camp") {
      // Trim and normalize campName for case-insensitive matching
      const normalizedCampName = campName ? campName.trim() : "";
      const [campRows] = await connection.execute("SELECT * FROM camps WHERE LOWER(TRIM(campName)) = LOWER(TRIM(?))", [normalizedCampName]);

      if (campRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Camp Not Found",
        });
      }

      camp = campRows[0];
      campId = camp.id;
      campNameValue = campName;
      campDefaultFactor = parseInt(camp.defaultFactor) || 1;
      const campPoints = parseInt(camp.points) || 0;
      const noOfCampsInt = parseInt(noOfCamps) || 1;
      totalPoints = campPoints * noOfCampsInt * campDefaultFactor;
    }

    // Handle file upload
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Upload image is required",
      });
    }

    let uploadImagePath = null;

    try {
      // Get type-specific upload directory
      const typeUploadsDir = getUploadsDir(normalizedType);
      const fileExtension = path.extname(req.file.originalname) || ".jpg";
      const fileName = `${mrId}_${Date.now()}${fileExtension}`;
      const filePath = path.join(typeUploadsDir, fileName);

      // Write file to disk
      fs.writeFileSync(filePath, req.file.buffer);
      
      // Store path with type-specific folder
      const folderName = normalizedType === "prescription" ? "prescriptions" : normalizedType === "pob" ? "pob" : "camps";
      uploadImagePath = `/uploads/${folderName}/${fileName}`;

      // console.log("File saved successfully:", {
      //   fileName,
      //   filePath,
      //   uploadImagePath,
      //   type: normalizedType,
      //   fileSize: req.file.buffer.length,
      // });
    } catch (fileError) {
      console.error("Error saving file:", fileError);
      return res.status(500).json({
        success: false,
        message: "Failed to save upload image",
        error: fileError.message,
      });
    }

    // Get current IST time
    const istDateTime = getISTDateTime();
    const formattedDate = formatISTDateForSQL(istDateTime);
    const formattedTime = formatISTTimeForSQL(istDateTime);
    const istDateTimeString = formatISTDateTimeForSQL(istDateTime);

    // Format doctor name for types that require it
    const formattedDrName = 
      normalizedType === "prescription" || normalizedType === "pob" || normalizedType === "camp"
        ? formatDoctorName(drName)
        : null;

    await connection.beginTransaction();

    // Prepare insert values based on type
    const uploadId = crypto.randomUUID();
    let insertFields = [];
    let insertValues = [];
    let placeholders = [];

    // Common fields - include createdAt and updatedAt with IST time
    insertFields.push("id", "type", "mrId", "uploadImage", "dateOfUpload", "timeOfUpload", "points", "isCalculated", "status", "attempts", "createdAt", "updatedAt");
    insertValues.push(uploadId, normalizedType, mrId, uploadImagePath, formattedDate, formattedTime, totalPoints, 0, "pending", 0, istDateTimeString, istDateTimeString);
    placeholders.push("?", "?", "?", "?", "?", "?", "?", "?", "?", "?", "?", "?");

    // Common fields that exist in the table
    insertFields.push("drName", "speciality", "mobNo", "scCode");
    insertValues.push(
      formattedDrName,
      speciality || null,
      mobNo || null,
      scCode || null
    );
    placeholders.push("?", "?", "?", "?");

    // Build activitySpecificDetails JSON object for type-specific fields
    let activitySpecificDetails = {};

    if (normalizedType === "prescription") {
      activitySpecificDetails = {
        brandId: brandId,
        brandName: brandNameValue,
        noRxns: parseInt(noRxns) || 1,
        // rxnDuration uses brand's defaultRxnDuration (mapped to defaultFactor in UI)
        rxnDuration: parseInt(brand.defaultRxnDuration) || 1
      };
    } else if (normalizedType === "pob") {
      activitySpecificDetails = {
        brandId: brandId,
        brandName: brandNameValue,
        chemistName: chemistName ? capitalizeWords(chemistName) : null,
        noOfUnits: noOfUnits ? parseInt(noOfUnits) : null,
        allValue: allValue ? parseInt(allValue) : null,
        // rxnDuration uses brand's defaultRxnDuration (mapped to defaultFactor in UI)
        rxnDuration: parseInt(brand.defaultRxnDuration) || 1
      };
    } else if (normalizedType === "camp") {
      activitySpecificDetails = {
        campId: campId,
        campName: campNameValue,
        noOfCamps: parseInt(noOfCamps) || 1,
        campDefaultFactor: campDefaultFactor
      };
    }

    // Add activitySpecificDetails as JSON
    insertFields.push("activitySpecificDetails");
    insertValues.push(JSON.stringify(activitySpecificDetails));
    placeholders.push("?");

    const insertQuery = `INSERT INTO uploads (${insertFields.join(", ")}) VALUES (${placeholders.join(", ")})`;

    // Debug: Log the query to verify it's correct (remove in production)
    // console.log("Insert Query:", insertQuery);
    // console.log("Insert Fields:", insertFields);
    // console.log("Activity Specific Details:", JSON.stringify(activitySpecificDetails));

    await connection.execute(insertQuery, insertValues);

    await connection.commit();

    // Prepare response based on type
    const responseData = {
      uploadId,
      type: normalizedType,
      points: totalPoints,
      uploadImage: uploadImagePath,
      status: "pending",
      attempts: 0,
      isCalculated: false,
    };

    if (normalizedType === "prescription") {
      responseData.brandPoints = brand.points;
      responseData.noRxns = parseInt(noRxns) || 1;
      responseData.rxnDuration = rxnDuration ? parseInt(rxnDuration) : parseInt(brand.defaultRxnDuration) || 1;
      responseData.doctorName = formattedDrName;
    } else if (normalizedType === "pob") {
      responseData.brandName = brandNameValue;
      responseData.brandPoints = brand.points;
      responseData.countType = brand.countType;
      
      if (brand.countType && brand.countType.toLowerCase() === "unit") {
        responseData.unitFactor = parseInt(brand.unitFactor) || null;
        if (noOfUnits) responseData.noOfUnits = parseInt(noOfUnits);
      } else if (brand.countType && brand.countType.toLowerCase() === "value") {
        responseData.valueFactor = parseInt(brand.valueFactor) || null;
        if (allValue) responseData.allValue = parseInt(allValue);
      } else {
        // Fallback for brands without countType
        if (noOfUnits) responseData.noOfUnits = parseInt(noOfUnits);
        if (allValue) responseData.allValue = parseInt(allValue);
      }
      
      responseData.rxnDuration = rxnDuration ? parseInt(rxnDuration) : parseInt(brand.defaultRxnDuration) || 1;
      responseData.doctorName = formattedDrName;
      responseData.speciality = speciality;
      responseData.mobNo = mobNo;
      if (chemistName) responseData.chemistName = chemistName;
    } else if (normalizedType === "camp") {
      responseData.campPoints = camp.points;
      responseData.noOfCamps = parseInt(noOfCamps) || 1;
      responseData.campDefaultFactor = campDefaultFactor;
      responseData.doctorName = formattedDrName;
      responseData.speciality = speciality;
      responseData.mobNo = mobNo;
    }

    res.status(200).json({
      success: true,
      message: `${normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1)} uploaded successfully`,
      data: responseData,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(`Error uploading ${req.body?.type || "file"}:`, error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

//not in use currently
export const uploadPrescription = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { mrId } = req.params;
    const {
      drName,
      speciality,
      mobNo,
      scCode,
      brandName,
      noRxns,
      rxnDuration,
    } = req.body;

    const missingFields = [];

    if (!brandName) missingFields.push("brandName");
    if (!noRxns) missingFields.push("noRxns");
    if (!drName) missingFields.push("drName");
    if (!scCode) missingFields.push("scCode");
    // if (!rxnDuration) missingFields.push("rxnDuration");

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Please fill all required details: ${missingFields.join(", ")}`,
      });
    }

    // Check if MR exists
    const [mrRows] = await connection.execute(
      "SELECT * FROM mrs WHERE mrId = ?",
      [mrId]
    );

    if (mrRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "MR Id Not Found",
      });
    }

    // Get brand data to get points
    const [brandRows] = await connection.execute(
      "SELECT * FROM brands WHERE brandName = ?",
      [brandName]
    );

    if (brandRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Brand Not Found",
      });
    }

    const brand = brandRows[0];
    const brandPoints = parseInt(brand.points) || 0;
    const noRxnsInt = parseInt(noRxns) || 1;
    // Use provided rxnDuration, or brand's default, or fallback to 1
    const rxnDurationInt = rxnDuration 
      ? parseInt(rxnDuration) 
      : (parseInt(brand.defaultRxnDuration) || 1);

    // Calculate total points: brand points × number of prescriptions × rxn duration
    const totalPoints = brandPoints * noRxnsInt * rxnDurationInt;

    // Handle file upload
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Prescription image is required",
      });
    }

    let prescriptionImagePath = null;

    try {
      // Get prescriptions upload directory
      const typeUploadsDir = getUploadsDir("prescription");
      const fileExtension = path.extname(req.file.originalname) || ".jpg";
      const fileName = `${mrId}_${Date.now()}${fileExtension}`;
      const filePath = path.join(typeUploadsDir, fileName);

      // Write file to disk
      fs.writeFileSync(filePath, req.file.buffer);
      prescriptionImagePath = `/uploads/prescriptions/${fileName}`;

      // console.log("File saved successfully:", {
      //   fileName,
      //   filePath,
      //   prescriptionImagePath,
      //   fileSize: req.file.buffer.length,
      // });
    } catch (fileError) {
      console.error("Error saving file:", fileError);
      return res.status(500).json({
        success: false,
        message: "Failed to save prescription image",
        error: fileError.message,
      });
    }

    // Get current IST time
    const istDateTime = getISTDateTime();
    const formattedDate = formatISTDateForSQL(istDateTime);
    const formattedTime = formatISTTimeForSQL(istDateTime);
    const istDateTimeString = formatISTDateTimeForSQL(istDateTime);

    const formattedDrName = formatDoctorName(drName);

    await connection.beginTransaction();

    // OLD CODE - using prescriptions table
    // const prescriptionId = crypto.randomUUID();
    // await connection.execute(
    //   `INSERT INTO prescriptions 
    //    (id, mrId, brandId, brandName, drName, speciality, mobNo, scCode, noRxns, rxnDuration, prescriptionImage, dateOfUpload, timeOfUpload, points, isCalculated, status, rejectionReason, attempts, reviewDate)
    //    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL, ?, NULL)`,
    //   [
    //     prescriptionId,
    //     mrId,
    //     brand.id,
    //     brandName,
    //     formattedDrName,
    //     speciality || null,
    //     mobNo || null,
    //     scCode || null,
    //     noRxnsInt,
    //     rxnDurationInt,
    //     prescriptionImagePath,
    //     formattedDate,
    //     formattedTime,
    //     totalPoints,
    //     0,
    //   ]
    // );

    // Insert prescription with isCalculated = 0 initially
    const prescriptionId = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO uploads 
       (id, type, mrId, brandId, brandName, drName, speciality, mobNo, scCode, noRxns, rxnDuration, uploadImage, dateOfUpload, timeOfUpload, points, isCalculated, status, rejectionReason, attempts, reviewDate, createdAt, updatedAt)
       VALUES (?, 'prescription', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL, ?, NULL, ?, ?)`,
      [
        prescriptionId,
        mrId,
        brand.id,
        brandName,
        formattedDrName,
        speciality || null,
        mobNo || null,
        scCode || null,
        noRxnsInt,
        rxnDurationInt,
        prescriptionImagePath,
        formattedDate,
        formattedTime,
        totalPoints,
        0,
        istDateTimeString,
        istDateTimeString,
      ]
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "Prescription uploaded successfully",
      data: {
        prescriptionId,
        points: totalPoints,
        brandPoints,
        noRxns: noRxnsInt,
        rxnDuration: rxnDurationInt,
        doctorName: formattedDrName,
        prescriptionImage: prescriptionImagePath,
        status: "pending",
        attempts: 0,
        isCalculated: false,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error uploading prescription:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

//before adding points to move conversion while uploading prescription
// export const uploadPrescription = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { mrId } = req.params;
//     const {
//       drName,
//       speciality,
//       mobNo,
//       scCode,
//       brandName,
//       noRxns,
//       rxnDuration,
//     } = req.body;

//     // Validate required fields
//     if (!brandName || !noRxns) {
//       return res.status(400).json({
//         success: false,
//         message: "Please fill all required details: brandName, noRxns",
//       });
//     }

//     // Check if MR exists
//     const [mrRows] = await connection.execute(
//       "SELECT * FROM mrs WHERE mrId = ?",
//       [mrId]
//     );

//     if (mrRows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "MR Id Not Found",
//       });
//     }

//     // Get brand data to get points
//     const [brandRows] = await connection.execute(
//       "SELECT * FROM brands WHERE brandName = ?",
//       [brandName]
//     );

//     if (brandRows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "Brand Not Found",
//       });
//     }

//     const brand = brandRows[0];
//     const brandPoints = parseInt(brand.points) || 0;
//     const noRxnsInt = parseInt(noRxns) || 1;
//     // Use provided rxnDuration, or brand's default, or fallback to 1
//     const rxnDurationInt = rxnDuration 
//       ? parseInt(rxnDuration) 
//       : (parseInt(brand.defaultRxnDuration) || 1);

//     // Calculate total points: brand points × number of prescriptions × rxn duration
//     const totalPoints = brandPoints * noRxnsInt * rxnDurationInt;

//     // Handle file upload
//     if (!req.file) {
//       return res.status(400).json({
//         success: false,
//         message: "Prescription image is required",
//       });
//     }

//     let prescriptionImagePath = null;

//     try {
//       const fileExtension = path.extname(req.file.originalname) || ".jpg";
//       const fileName = `${mrId}_${Date.now()}${fileExtension}`;
//       const filePath = path.join(uploadsDir, fileName);

//       // Ensure directory exists
//       if (!fs.existsSync(uploadsDir)) {
//         fs.mkdirSync(uploadsDir, { recursive: true });
//       }

//       // Write file to disk
//       fs.writeFileSync(filePath, req.file.buffer);
//       prescriptionImagePath = `/uploads/prescriptions/${fileName}`;

//       console.log("File saved successfully:", {
//         fileName,
//         filePath,
//         prescriptionImagePath,
//         fileSize: req.file.buffer.length,
//       });
//     } catch (fileError) {
//       console.error("Error saving file:", fileError);
//       return res.status(500).json({
//         success: false,
//         message: "Failed to save prescription image",
//         error: fileError.message,
//       });
//     }

//     // Get current time
//     const uploadTime = new Date();
//     const formattedDate = `${uploadTime.getFullYear()}-${(uploadTime.getMonth() + 1)
//       .toString()
//       .padStart(2, "0")}-${uploadTime.getDate().toString().padStart(2, "0")}`;
//     const formattedTime = `${uploadTime.getHours().toString().padStart(2, "0")}:${uploadTime
//       .getMinutes()
//       .toString()
//       .padStart(2, "0")}`;

//     await connection.beginTransaction();

//     // Insert prescription with isCalculated = 0 initially
//     const prescriptionId = crypto.randomUUID();
//     await connection.execute(
//       `INSERT INTO prescriptions 
//        (id, mrId, brandId, brandName, drName, speciality, mobNo, scCode, noRxns, rxnDuration, prescriptionImage, dateOfUpload, timeOfUpload, points, isCalculated, status, rejectionReason, attempts, reviewDate)
//        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL, ?, NULL)`,
//       [
//         prescriptionId,
//         mrId,
//         brand.id,
//         brandName,
//         drName || null,
//         speciality || null,
//         mobNo || null,
//         scCode || null,
//         noRxnsInt,
//         rxnDurationInt,
//         prescriptionImagePath,
//         formattedDate,
//         formattedTime,
//         totalPoints,
//         0,
//       ]
//     );

//     await connection.commit();

//     res.status(200).json({
//       success: true,
//       message: "Prescription uploaded successfully",
//       data: {
//         prescriptionId,
//         points: totalPoints,
//         brandPoints,
//         noRxns: noRxnsInt,
//         rxnDuration: rxnDurationInt,
//         prescriptionImage: prescriptionImagePath,
//         status: "pending",
//         attempts: 0,
//         isCalculated: false,
//       },
//     });
//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error uploading prescription:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };


//before flm-mr connection
// export const uploadPrescription = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { mrId } = req.params;
//     const {
//       drName,
//       speciality,
//       mobNo,
//       scCode,
//       brandName,
//       noRxns,
//       rxnDuration,
//       dateOfUpload,
//     } = req.body;

//     // Validate required fields
//     if (!brandName || !noRxns || !dateOfUpload) {
//       return res.status(400).json({
//         success: false,
//         message: "Please fill all required details: brandName, noRxns, dateOfUpload",
//       });
//     }

//     // Check if MR exists
//     const [mrRows] = await connection.execute(
//       "SELECT * FROM mrs WHERE mrId = ?",
//       [mrId]
//     );

//     if (mrRows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "MR Id Not Found",
//       });
//     }

//     const mr = mrRows[0];

//     // Get brand data to get points
//     const [brandRows] = await connection.execute(
//       "SELECT * FROM brands WHERE brandName = ?",
//       [brandName]
//     );

//     if (brandRows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "Brand Not Found",
//       });
//     }

//     const brand = brandRows[0];
//     const brandPoints = parseInt(brand.points) || 0;
//     const noRxnsInt = parseInt(noRxns) || 1;
//     // Use provided rxnDuration, or brand's default, or fallback to 1
//     const rxnDurationInt = rxnDuration 
//       ? parseInt(rxnDuration) 
//       : (parseInt(brand.defaultRxnDuration) || 1);

//     // Calculate total points: brand points × number of prescriptions × rxn duration
//     const totalPoints = brandPoints * noRxnsInt * rxnDurationInt;

//     // Handle file upload
//     let prescriptionImagePath = null;
    
    
//     if (req.file) {
//       try {
//         const fileExtension = path.extname(req.file.originalname) || ".jpg";
//         const fileName = `${mrId}_${Date.now()}${fileExtension}`;
//         const filePath = path.join(uploadsDir, fileName);
        
//         // Ensure directory exists
//         if (!fs.existsSync(uploadsDir)) {
//           fs.mkdirSync(uploadsDir, { recursive: true });
//         }
        
//         // Write file to disk
//         fs.writeFileSync(filePath, req.file.buffer);
//         prescriptionImagePath = `/uploads/prescriptions/${fileName}`;
        
//         console.log("File saved successfully:", {
//           fileName,
//           filePath,
//           prescriptionImagePath,
//           fileSize: req.file.buffer.length,
//         });
//       } catch (fileError) {
//         console.error("Error saving file:", fileError);
//         // Continue without file if there's an error
//       }
//     } else {
//       console.log("No file received in request");
//     }

//     // Get current time
//     const uploadTime = new Date();
//     const formattedTime = `${uploadTime.getHours().toString().padStart(2, "0")}:${uploadTime.getMinutes().toString().padStart(2, "0")}`;

//     await connection.beginTransaction();

//     // Insert prescription with isCalculated = 0 initially
//     const prescriptionId = crypto.randomUUID();
//     await connection.execute(
//       `INSERT INTO prescriptions 
//        (id, mrId, brandId, brandName, drName, speciality, mobNo, scCode, noRxns, rxnDuration, prescriptionImage, dateOfUpload, timeOfUpload, points, isCalculated)
//        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
//       [
//         prescriptionId,
//         mrId,
//         brand.id,
//         brandName,
//         drName || null,
//         speciality || null,
//         mobNo || null,
//         scCode || null,
//         noRxnsInt,
//         rxnDurationInt,
//         prescriptionImagePath,
//         dateOfUpload,
//         formattedTime,
//         totalPoints,
//       ]
//     );

//     // Update FLM's points field by adding the calculated points
//     if (mr.flmId) {
//       await connection.execute(
//         `UPDATE flms 
//          SET points = points + ? 
//          WHERE flmId = ?`,
//         [totalPoints, mr.flmId]
//       );

//       // Mark prescription as calculated
//       await connection.execute(
//         `UPDATE prescriptions 
//          SET isCalculated = 1 
//          WHERE id = ?`,
//         [prescriptionId]
//       );
//     } else {
//       // Even if no FLM, mark as calculated (no points to add)
//       await connection.execute(
//         `UPDATE prescriptions 
//          SET isCalculated = 1 
//          WHERE id = ?`,
//         [prescriptionId]
//       );
//     }

//     await connection.commit();

//     res.status(200).json({
//       success: true,
//       message: "Prescription uploaded successfully",
//       data: {
//         prescriptionId,
//         points: totalPoints,
//         brandPoints,
//         noRxns: noRxnsInt,
//         rxnDuration: rxnDurationInt,
//         prescriptionImage: prescriptionImagePath,
//         isCalculated: true,
//       },
//     });
//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error uploading prescription:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };

export const getMyPrescriptions = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { mrId } = req.params;
    const { startDate, endDate, isCalculated, limit = 50, offset = 0 } = req.query;

    // Check if MR exists
    const [mrRows] = await connection.execute(
      "SELECT * FROM mrs WHERE mrId = ?",
      [mrId]
    );

    if (mrRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "MR Id Not Found",
      });
    }

    // OLD CODE - using prescriptions table
    // let query = `
    //   SELECT p.*, b.points as brandPoints
    //   FROM prescriptions p
    //   JOIN brands b ON p.brandId = b.id
    //   WHERE p.mrId = ?
    // `;

    let query = `
      SELECT p.*, b.points as brandPoints
      FROM uploads p
      LEFT JOIN brands b ON JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandId')) = b.id
      WHERE p.type = 'prescription'
        AND p.mrId = ?
    `;
    const params = [mrId];

    if (startDate && endDate) {
      query += " AND p.dateOfUpload BETWEEN ? AND ?";
      params.push(startDate, endDate);
    }

    if (isCalculated !== undefined) {
      query += " AND p.isCalculated = ?";
      params.push(isCalculated === "true" || isCalculated === "1" ? 1 : 0);
    }

    // Parse limit and offset as integers (LIMIT/OFFSET can't be parameters in MySQL2)
    const limitInt = Math.max(1, Math.min(parseInt(limit) || 50, 1000)); // Between 1 and 1000
    const offsetInt = Math.max(0, parseInt(offset) || 0); // Must be >= 0

    query += ` ORDER BY p.createdAt DESC LIMIT ${limitInt} OFFSET ${offsetInt}`;

    const [prescriptions] = await connection.execute(query, params);

    // OLD CODE - using prescriptions table
    // let countQuery = "SELECT COUNT(*) as total FROM prescriptions WHERE mrId = ?";

    // Get total count
    let countQuery = "SELECT COUNT(*) as total FROM uploads WHERE type = 'prescription' AND mrId = ?";
    const countParams = [mrId];

    if (startDate && endDate) {
      countQuery += " AND dateOfUpload BETWEEN ? AND ?";
      countParams.push(startDate, endDate);
    }

    if (isCalculated !== undefined) {
      countQuery += " AND isCalculated = ?";
      countParams.push(isCalculated === "true" || isCalculated === "1" ? 1 : 0);
    }

    const [countRows] = await connection.execute(countQuery, countParams);
    const total = countRows[0].total;

    // Flatten activitySpecificDetails to top level for frontend compatibility
    const flattenedPrescriptions = prescriptions.map(prescription => {
      if (prescription.activitySpecificDetails) {
        try {
          const activityDetails = typeof prescription.activitySpecificDetails === 'string' 
            ? JSON.parse(prescription.activitySpecificDetails) 
            : prescription.activitySpecificDetails;
          
          if (activityDetails) {
            return {
              ...prescription,
              ...activityDetails,
              // Keep activitySpecificDetails for reference
              activitySpecificDetails: activityDetails
            };
          }
        } catch (error) {
          console.error("Error parsing activitySpecificDetails:", error);
        }
      }
      return prescription;
    });

    res.status(200).json({
      success: true,
      data: {
        prescriptions: flattenedPrescriptions,
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
      },
    });
  } catch (error) {
    console.error("Error fetching prescriptions:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getRejectedUploads = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { mrId } = req.params;
    const { date, startDate, endDate, today, type } = req.query;

    const [mrRows] = await connection.execute("SELECT mrId FROM mrs WHERE mrId = ?", [mrId]);
    if (mrRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "MR Id Not Found",
      });
    }

    const dateFilters = [];
    const dateParams = [];

    const normalizedToday = today === true || today === "true" || today === "1";

    if (normalizedToday) {
      dateFilters.push("DATE(p.dateOfUpload) = CURDATE()");
    } else if (date) {
      dateFilters.push("DATE(p.dateOfUpload) = ?");
      dateParams.push(date);
    } else if (startDate && endDate) {
      dateFilters.push("DATE(p.dateOfUpload) BETWEEN ? AND ?");
      dateParams.push(startDate, endDate);
    } else if (startDate) {
      dateFilters.push("DATE(p.dateOfUpload) >= ?");
      dateParams.push(startDate);
    } else if (endDate) {
      dateFilters.push("DATE(p.dateOfUpload) <= ?");
      dateParams.push(endDate);
    }

    const dateClause = dateFilters.length ? ` AND ${dateFilters.join(" AND ")}` : "";

    // Handle type filter - if provided, filter by type; otherwise return all types
    let typeClause = "";
    const typeParams = [];
    if (type && ["prescription", "pob", "camp"].includes(type.toLowerCase())) {
      typeClause = " AND p.type = ?";
      typeParams.push(type.toLowerCase());
    }

    const [rejectedUploads] = await connection.execute(
      `SELECT p.*, 
              b.points AS brandPoints,
              b.unitFactor AS unitFactor,
              b.valueFactor AS valueFactor,
              b.countType AS countType,
              c.points AS campPoints,
              c.defaultFactor AS campDefaultFactor,
              m.mrName, 
              m.hq AS mrHq, 
              m.region AS mrRegion, 
              m.zone AS mrZone
       FROM uploads p
       LEFT JOIN brands b ON JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandId')) = b.id
       LEFT JOIN camps c ON JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.campId')) = c.id
       JOIN mrs m ON p.mrId = m.mrId
       WHERE p.mrId = ? AND p.status = 'rejected'
       ${typeClause}
       ${dateClause}
       ORDER BY p.updatedAt DESC, p.dateOfUpload DESC, p.timeOfUpload DESC`,
      [mrId, ...typeParams, ...dateParams]
    );

    // Flatten activitySpecificDetails to top level for frontend compatibility
    const flattenedUploads = rejectedUploads.map(upload => {
      if (upload.activitySpecificDetails) {
        try {
          const activityDetails = typeof upload.activitySpecificDetails === 'string' 
            ? JSON.parse(upload.activitySpecificDetails) 
            : upload.activitySpecificDetails;
          
          if (activityDetails) {
            return {
              ...upload,
              ...activityDetails,
              // Keep activitySpecificDetails for reference
              activitySpecificDetails: activityDetails
            };
          }
        } catch (error) {
          console.error("Error parsing activitySpecificDetails:", error);
        }
      }
      return upload;
    });

    res.status(200).json({
      success: true,
      data: flattenedUploads,
      total: flattenedUploads.length,
    });
  } catch (error) {
    console.error("Error fetching rejected prescriptions:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getRejectedUploadsById = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { mrId, uploadId } = req.params;

    if (!mrId || !uploadId) {
      return res.status(400).json({
        success: false,
        message: "mrId and uploadId are required",
      });
    }

    const [mrRows] = await connection.execute("SELECT mrId FROM mrs WHERE mrId = ?", [mrId]);
    if (mrRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "MR Id Not Found",
      });
    }

    const [rows] = await connection.execute(
      `SELECT p.*, 
              b.points AS brandPoints,
              b.unitFactor AS unitFactor,
              b.valueFactor AS valueFactor,
              b.countType AS countType,
              c.points AS campPoints,
              c.defaultFactor AS campDefaultFactor,
              m.mrName, 
              m.hq AS mrHq, 
              m.region AS mrRegion, 
              m.zone AS mrZone
       FROM uploads p
       LEFT JOIN brands b ON JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandId')) = b.id
       LEFT JOIN camps c ON JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.campId')) = c.id
       JOIN mrs m ON p.mrId = m.mrId
       WHERE p.mrId = ? AND p.id = ? AND p.status = 'rejected'
       LIMIT 1`,
      [mrId, uploadId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Rejected upload not found for this MR",
      });
    }

    const rejectedUpload = rows[0];
    
    // Flatten activitySpecificDetails to top level for frontend compatibility
    let flattenedUpload = { ...rejectedUpload };
    if (rejectedUpload.activitySpecificDetails) {
      try {
        const activityDetails = typeof rejectedUpload.activitySpecificDetails === 'string' 
          ? JSON.parse(rejectedUpload.activitySpecificDetails) 
          : rejectedUpload.activitySpecificDetails;
        
        if (activityDetails) {
          flattenedUpload = {
            ...rejectedUpload,
            ...activityDetails,
            // Keep activitySpecificDetails for reference
            activitySpecificDetails: activityDetails
          };
        }
      } catch (error) {
        console.error("Error parsing activitySpecificDetails:", error);
      }
    }

    return res.status(200).json({
      success: true,
      data: flattenedUpload,
    });
  } catch (error) {
    console.error("Error fetching rejected upload:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const resubmitUploads = async (req, res) => {
  const connection = await db.getConnection();

  try {
    // Support both prescriptionId (backward compatibility) and uploadId
    const { mrId, prescriptionId, uploadId } = req.params;
    const uploadIdParam = uploadId || prescriptionId;

    const {
      drName,
      speciality,
      mobNo,
      scCode,
      brandName,
      campName,
      noRxns,
      rxnDuration,
      chemistName,
      noOfUnits,
      allValue,
      noOfCamps,
      dateOfUpload,
    } = req.body;

    if (!mrId || !uploadIdParam) {
      return res.status(400).json({
        success: false,
        message: "mrId and uploadId are required",
      });
    }

    // OLD CODE - using prescriptions table
    // const [prescriptionRows] = await connection.execute(
    //   `SELECT p.*, m.flmId 
    //    FROM prescriptions p
    //    JOIN mrs m ON p.mrId = m.mrId
    //    WHERE p.id = ? AND p.mrId = ?
    //    LIMIT 1`,
    //   [prescriptionId, mrId]
    // );

    const [uploadRows] = await connection.execute(
      `SELECT p.*, m.flmId 
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       WHERE p.id = ? AND p.mrId = ?
       LIMIT 1`,
      [uploadIdParam, mrId]
    );

    if (uploadRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Upload not found for this MR",
      });
    }

    const upload = uploadRows[0];
    const uploadType = upload.type;

    if (upload.status !== "rejected") {
      return res.status(400).json({
        success: false,
        message: "Only rejected uploads can be resubmitted",
      });
    }

    const currentAttempts = Number(upload.attempts) || 0;
    if (currentAttempts >= 1) {
      return res.status(400).json({
        success: false,
        message: "Maximum resubmission attempts reached",
      });
    }

    // Parse activitySpecificDetails from upload
    let activityDetails = {};
    if (upload.activitySpecificDetails) {
      try {
        activityDetails = typeof upload.activitySpecificDetails === 'string' 
          ? JSON.parse(upload.activitySpecificDetails) 
          : upload.activitySpecificDetails;
      } catch (error) {
        console.error("Error parsing activitySpecificDetails:", error);
      }
    }

    let brand = null;
    let camp = null;
    let totalPoints = 0;
    let updateFields = [];
    let updateValues = [];
    let newActivitySpecificDetails = { ...activityDetails };

    // Handle brand-based types (prescription, pob)
    if (uploadType === "prescription" || uploadType === "pob") {
      const targetBrandName = brandName || activityDetails.brandName;
      if (!targetBrandName) {
        return res.status(400).json({
          success: false,
          message: "brandName is required",
        });
      }

    const [brandRows] = await connection.execute(
      "SELECT * FROM brands WHERE brandName = ?",
      [targetBrandName]
    );

    if (brandRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Brand Not Found",
      });
    }

      brand = brandRows[0];
    const brandPoints = parseInt(brand.points) || 0;

      if (uploadType === "prescription") {
    const noRxnsInt =
      noRxns !== undefined && noRxns !== null && noRxns !== ""
        ? parseInt(noRxns) || 1
            : parseInt(activityDetails.noRxns) || 1;

    const rxnDurationInt =
      rxnDuration !== undefined && rxnDuration !== null && rxnDuration !== ""
        ? parseInt(rxnDuration) || 1
            : parseInt(activityDetails.rxnDuration) ||
          parseInt(brand.defaultRxnDuration) ||
          1;

        totalPoints = brandPoints * noRxnsInt * rxnDurationInt;

        // Update activitySpecificDetails
        newActivitySpecificDetails = {
          brandId: brand.id,
          brandName: brand.brandName || targetBrandName,
          noRxns: noRxnsInt,
          rxnDuration: rxnDurationInt
        };
      } else if (uploadType === "pob") {
        const brandCountType = brand.countType ? brand.countType.toLowerCase() : null;
        let noOfUnitsInt = null;
        let allValueInt = null;

        if (brandCountType === "unit") {
          noOfUnitsInt =
            noOfUnits !== undefined && noOfUnits !== null && noOfUnits !== ""
              ? parseInt(noOfUnits) || 1
              : parseInt(activityDetails.noOfUnits) || 1;

          const rxnDurationInt =
            rxnDuration !== undefined && rxnDuration !== null && rxnDuration !== ""
              ? parseInt(rxnDuration) || 1
              : parseInt(activityDetails.rxnDuration) ||
                parseInt(brand.defaultRxnDuration) ||
                1;

          const factor = parseInt(brand.unitFactor) || 1;
          totalPoints = brandPoints * noOfUnitsInt * rxnDurationInt * factor;
        } else if (brandCountType === "value") {
          allValueInt =
            allValue !== undefined && allValue !== null && allValue !== ""
              ? parseInt(allValue) || 1
              : parseInt(activityDetails.allValue) || 1;

          const rxnDurationInt =
            rxnDuration !== undefined && rxnDuration !== null && rxnDuration !== ""
              ? parseInt(rxnDuration) || 1
              : parseInt(activityDetails.rxnDuration) ||
                parseInt(brand.defaultRxnDuration) ||
                1;

          const factor = parseInt(brand.valueFactor) || 1;
          totalPoints = brandPoints * allValueInt * rxnDurationInt * factor;
        } else {
          // Fallback for brands without countType
          const valueInt =
            noOfUnits !== undefined && noOfUnits !== null && noOfUnits !== ""
              ? parseInt(noOfUnits) || 1
              : allValue !== undefined && allValue !== null && allValue !== ""
                ? parseInt(allValue) || 1
                : parseInt(activityDetails.noOfUnits || activityDetails.allValue) || 1;

          const rxnDurationInt =
            rxnDuration !== undefined && rxnDuration !== null && rxnDuration !== ""
              ? parseInt(rxnDuration) || 1
              : parseInt(activityDetails.rxnDuration) ||
                parseInt(brand.defaultRxnDuration) ||
                1;

          totalPoints = brandPoints * valueInt * rxnDurationInt;
          noOfUnitsInt = valueInt;
        }

        const rxnDurationInt =
          rxnDuration !== undefined && rxnDuration !== null && rxnDuration !== ""
            ? parseInt(rxnDuration) || 1
            : parseInt(activityDetails.rxnDuration) ||
              parseInt(brand.defaultRxnDuration) ||
              1;

        // Update activitySpecificDetails
        newActivitySpecificDetails = {
          brandId: brand.id,
          brandName: brand.brandName || targetBrandName,
          noOfUnits: noOfUnitsInt,
          allValue: allValueInt,
          rxnDuration: rxnDurationInt,
          chemistName: chemistName !== undefined 
            ? (chemistName ? capitalizeWords(chemistName) : null)
            : (activityDetails.chemistName || null)
        };
      }
    }

    // Handle camp type
    if (uploadType === "camp") {
      const targetCampName = campName || activityDetails.campName;
      if (!targetCampName) {
        return res.status(400).json({
          success: false,
          message: "campName is required",
        });
      }

      const [campRows] = await connection.execute(
        "SELECT * FROM camps WHERE campName = ?",
        [targetCampName]
      );

      if (campRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Camp Not Found",
        });
      }

      camp = campRows[0];
      const campPoints = parseInt(camp.points) || 0;
      const campDefaultFactor = parseInt(camp.defaultFactor) || 1;
      const noOfCampsInt =
        noOfCamps !== undefined && noOfCamps !== null && noOfCamps !== ""
          ? parseInt(noOfCamps) || 1
          : parseInt(activityDetails.noOfCamps) || 1;

      totalPoints = campPoints * noOfCampsInt * campDefaultFactor;

      // Update activitySpecificDetails
      newActivitySpecificDetails = {
        campId: camp.id,
        campName: camp.campName || targetCampName,
        noOfCamps: noOfCampsInt,
        campDefaultFactor: campDefaultFactor
      };
    }

    // Handle file upload
    let uploadImagePath = upload.uploadImage;
    if (req.file) {
      try {
        const typeUploadsDir = getUploadsDir(uploadType);
        const fileExtension = path.extname(req.file.originalname) || ".jpg";
        const fileName = `${mrId}_${Date.now()}${fileExtension}`;
        const filePath = path.join(typeUploadsDir, fileName);

        fs.writeFileSync(filePath, req.file.buffer);

        const folderName =
          uploadType === "prescription"
            ? "prescriptions"
            : uploadType === "pob"
              ? "pob"
              : "camps";
        uploadImagePath = `/uploads/${folderName}/${fileName}`;
      } catch (fileError) {
        console.error("Error saving resubmitted file:", fileError);
        return res.status(500).json({
          success: false,
          message: "Failed to save upload image",
          error: fileError.message,
        });
      }
    }

    // Get IST datetime for dateOfUpload, timeOfUpload, and updatedAt
    // When resubmitting, always use current IST date and time
    const istDateTime = getISTDateTime();
    const formattedDate = formatISTDateForSQL(istDateTime);
    const formattedTime = formatISTTimeForSQL(istDateTime);
    // Always use current IST datetime for updatedAt
    const istDateTimeString = formatISTDateTimeForSQL();

    const formattedDrName =
      drName !== undefined && drName !== null && drName !== ""
        ? formatDoctorName(drName)
        : formatDoctorName(upload.drName);

    await connection.beginTransaction();

    // OLD CODE - using prescriptions table
    // await connection.execute(
    //   `UPDATE prescriptions 
    //    SET brandId = ?, 
    //        brandName = ?, 
    //        drName = ?, 
    //        speciality = ?, 
    //        mobNo = ?, 
    //        scCode = ?, 
    //        noRxns = ?, 
    //        rxnDuration = ?, 
    //        prescriptionImage = ?, 
    //        dateOfUpload = ?, 
    //        timeOfUpload = ?, 
    //        points = ?, 
    //        isCalculated = 0,
    //        status = 'pending',
    //        rejectionReason = NULL,
    //        attempts = ?,
    //        reviewDate = NULL
    //    WHERE id = ?`,
    //   ...

    // Common fields for all types
    updateFields.push(
      "drName = ?",
      "speciality = ?",
      "mobNo = ?",
      "scCode = ?",
      "uploadImage = ?",
      "dateOfUpload = ?",
      "timeOfUpload = ?",
      "points = ?",
      "isCalculated = 0",
      "status = 'pending'",
      "rejectionReason = NULL",
      "attempts = ?",
      "reviewDate = NULL",
      "updatedAt = ?",
      "activitySpecificDetails = ?"
    );

    updateValues.push(
        formattedDrName,
      speciality !== undefined ? speciality || null : upload.speciality,
      mobNo !== undefined ? mobNo || null : upload.mobNo,
      scCode !== undefined ? scCode || null : upload.scCode,
      uploadImagePath,
      formattedDate,
        formattedTime,
        totalPoints,
        currentAttempts + 1,
      istDateTimeString,
      JSON.stringify(newActivitySpecificDetails)
    );

    const updateQuery = `
      UPDATE uploads 
      SET ${updateFields.join(", ")}
      WHERE id = ?
    `;

    await connection.execute(updateQuery, [...updateValues, uploadIdParam]);

    await connection.commit();

    res.status(200).json({
      success: true,
      message: `${uploadType === "prescription" ? "Prescription" : uploadType === "pob" ? "POB" : "Camp"} resubmitted for review`,
      data: {
        uploadId: uploadIdParam,
        type: uploadType,
        status: "pending",
        attempts: currentAttempts + 1,
        uploadImage: uploadImagePath,
        doctorName: formattedDrName,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error resubmitting upload:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};


export const getBrands = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { search, limit = 100, offset = 0 } = req.query;

    // let query = "SELECT id, brandName, points, defaultRxnDuration, createdAt, updatedAt FROM brands WHERE 1=1";
    let query = "SELECT id, brandName, points, defaultRxnDuration, countType, unitFactor, valueFactor, createdAt, updatedAt FROM brands WHERE 1=1";

    const params = [];

    // Optional search filter
    if (search) {
      query += " AND brandName LIKE ?";
      params.push(`%${search}%`);
    }

    // Parse limit and offset
    const limitInt = Math.max(1, Math.min(parseInt(limit) || 100, 1000));
    const offsetInt = Math.max(0, parseInt(offset) || 0);

    query += ` ORDER BY brandName ASC LIMIT ${limitInt} OFFSET ${offsetInt}`;

    const [brands] = await connection.execute(query, params);

    // Get total count
    let countQuery = "SELECT COUNT(*) as total FROM brands WHERE 1=1";
    const countParams = [];

    if (search) {
      countQuery += " AND brandName LIKE ?";
      countParams.push(`%${search}%`);
    }

    const [countRows] = await connection.execute(countQuery, countParams);
    const total = countRows[0].total;

    res.status(200).json({
      success: true,
      data: {
        brands,
        total,
        limit: limitInt,
        offset: offsetInt,
      },
    });
  } catch (error) {
    console.error("Error fetching brands:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getCamps = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { search, limit = 100, offset = 0 } = req.query;

    let query = "SELECT id, campName, defaultFactor, points, createdAt, updatedAt FROM camps WHERE 1=1";
    const params = [];

    // Optional search filter
    if (search) {
      query += " AND campName LIKE ?";
      params.push(`%${search}%`);
    }

    // Parse limit and offset
    const limitInt = Math.max(1, Math.min(parseInt(limit) || 100, 1000));
    const offsetInt = Math.max(0, parseInt(offset) || 0);

    query += ` ORDER BY campName ASC LIMIT ${limitInt} OFFSET ${offsetInt}`;

    const [camps] = await connection.execute(query, params);

    // Get total count
    let countQuery = "SELECT COUNT(*) as total FROM camps WHERE 1=1";
    const countParams = [];

    if (search) {
      countQuery += " AND campName LIKE ?";
      countParams.push(`%${search}%`);
    }

    const [countRows] = await connection.execute(countQuery, countParams);
    const total = countRows[0].total;

    res.status(200).json({
      success: true,
      data: {
        camps,
        total,
        limit: limitInt,
        offset: offsetInt,
      },
    });
  } catch (error) {
    console.error("Error fetching camps:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};




export const downloadUploadImageForMr = async (req, res) => {
  const connection = await db.getConnection();

  try {
    // Support both prescriptionId (for backward compatibility) and uploadId
    const { mrId, prescriptionId, uploadId } = req.params;
    const uploadIdParam = uploadId || prescriptionId;

    if (!mrId || !uploadIdParam) {
      return res.status(400).json({
        success: false,
        message: "mrId and uploadId are required",
      });
    }

    const [rows] = await connection.execute(
      `SELECT p.uploadImage, p.type
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       WHERE p.id = ? AND m.mrId = ?
       LIMIT 1`,
      [uploadIdParam, mrId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Upload image not found for this MR",
      });
    }

    const imagePath = rows[0].uploadImage;
    const uploadType = rows[0].type;

    if (!imagePath) {
      return res.status(404).json({
        success: false,
        message: "No image uploaded for this upload",
      });
    }

    const normalizedPath =
      imagePath.startsWith("/") || imagePath.startsWith("\\")
        ? imagePath.slice(1)
        : imagePath;

    const absolutePath = path.join(__dirname, "..", "..", normalizedPath);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({
        success: false,
        message: "Upload image file not found on server",
      });
    }

    // Generate a descriptive filename based on type
    const fileExtension = path.extname(absolutePath) || path.extname(imagePath) || "";
    const typeLabel = uploadType === "prescription" ? "prescription" : uploadType === "pob" ? "pob" : "camp";
    const downloadFileName = `${typeLabel}_${uploadIdParam}${fileExtension}`;

    return res.download(absolutePath, downloadFileName, err => {
      if (err) {
        console.error("Error sending upload image:", err);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: "Failed to download upload image",
            error: err.message,
          });
        }
      }
    });
  } catch (error) {
    console.error("Error downloading upload image:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const viewUploadImageForMr = async (req, res) => {
  const connection = await db.getConnection();

  try {
    // Support both prescriptionId (for backward compatibility) and uploadId
    const { mrId, prescriptionId, uploadId } = req.params;
    const uploadIdParam = uploadId || prescriptionId;

    if (!mrId || !uploadIdParam) {
      return res.status(400).json({
        success: false,
        message: "mrId and uploadId are required",
      });
    }

    const [rows] = await connection.execute(
      `SELECT p.uploadImage, p.type
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       WHERE p.id = ? AND m.mrId = ?
       LIMIT 1`,
      [uploadIdParam, mrId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Upload image not found for this MR",
      });
    }

    const imagePath = rows[0].uploadImage;
    const uploadType = rows[0].type;

    if (!imagePath) {
      return res.status(404).json({
        success: false,
        message: "No image uploaded for this upload",
      });
    }

    const normalizedPath =
      imagePath.startsWith("/") || imagePath.startsWith("\\")
        ? imagePath.slice(1)
        : imagePath;

    const absolutePath = path.join(__dirname, "..", "..", normalizedPath);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({
        success: false,
        message: "Upload image file not found on server",
      });
    }

    // Get file extension to determine content type
    const fileExtension = path.extname(absolutePath) || path.extname(imagePath) || ".jpg";
    const contentType = fileExtension.toLowerCase() === ".jpeg" || fileExtension.toLowerCase() === ".jpg"
      ? "image/jpeg"
      : "image/jpeg"; // Default to jpeg

    // Set headers to display image in browser
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "inline"); // Display in browser instead of download

    return res.sendFile(absolutePath, err => {
      if (err) {
        console.error("Error sending upload image:", err);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: "Failed to view upload image",
            error: err.message,
          });
        }
      }
    });
  } catch (error) {
    console.error("Error viewing upload image:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};






// export const getRejectedPrescriptions = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { mrId } = req.params;
//     const { date, startDate, endDate, today } = req.query;

//     const [mrRows] = await connection.execute("SELECT mrId FROM mrs WHERE mrId = ?", [mrId]);
//     if (mrRows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "MR Id Not Found",
//       });
//     }

//     const dateFilters = [];
//     const dateParams = [];

//     const normalizedToday = today === true || today === "true" || today === "1";

//     if (normalizedToday) {
//       dateFilters.push("DATE(p.dateOfUpload) = CURDATE()");
//     } else if (date) {
//       dateFilters.push("DATE(p.dateOfUpload) = ?");
//       dateParams.push(date);
//     } else if (startDate && endDate) {
//       dateFilters.push("DATE(p.dateOfUpload) BETWEEN ? AND ?");
//       dateParams.push(startDate, endDate);
//     } else if (startDate) {
//       dateFilters.push("DATE(p.dateOfUpload) >= ?");
//       dateParams.push(startDate);
//     } else if (endDate) {
//       dateFilters.push("DATE(p.dateOfUpload) <= ?");
//       dateParams.push(endDate);
//     }

//     const dateClause = dateFilters.length ? ` AND ${dateFilters.join(" AND ")}` : "";

//     // OLD CODE - using prescriptions table
//     // const [prescriptions] = await connection.execute(
//     //   `SELECT p.*, b.points AS brandPoints, m.mrName, m.hq AS mrHq, m.region AS mrRegion, m.zone AS mrZone
//     //    FROM prescriptions p
//     //    JOIN brands b ON p.brandId = b.id
//     //    JOIN mrs m ON p.mrId = m.mrId
//     //    WHERE p.mrId = ? AND p.status = 'rejected'
//     //    ${dateClause}
//     //    ORDER BY p.updatedAt DESC, p.dateOfUpload DESC, p.timeOfUpload DESC`,
//     //   [mrId, ...dateParams]
//     // );

//     const [prescriptions] = await connection.execute(
//       `SELECT p.*, b.points AS brandPoints, m.mrName, m.hq AS mrHq, m.region AS mrRegion, m.zone AS mrZone
//        FROM uploads p
//        LEFT JOIN brands b ON p.brandId = b.id
//        JOIN mrs m ON p.mrId = m.mrId
//        WHERE p.type = 'prescription'
//          AND p.mrId = ? AND p.status = 'rejected'
//        ${dateClause}
//        ORDER BY p.updatedAt DESC, p.dateOfUpload DESC, p.timeOfUpload DESC`,
//       [mrId, ...dateParams]
//     );

//     res.status(200).json({
//       success: true,
//       data: prescriptions,
//       total: prescriptions.length,
//     });
//   } catch (error) {
//     console.error("Error fetching rejected prescriptions:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };

// export const getRejectedPrescriptionById = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { mrId, prescriptionId } = req.params;

//     if (!mrId || !prescriptionId) {
//       return res.status(400).json({
//         success: false,
//         message: "mrId and prescriptionId are required",
//       });
//     }

//     const [mrRows] = await connection.execute("SELECT mrId FROM mrs WHERE mrId = ?", [mrId]);
//     if (mrRows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "MR Id Not Found",
//       });
//     }

//     // OLD CODE - using prescriptions table
//     // const [rows] = await connection.execute(
//     //   `SELECT p.*, b.points AS brandPoints, m.mrName, m.hq AS mrHq, m.region AS mrRegion, m.zone AS mrZone
//     //    FROM prescriptions p
//     //    JOIN brands b ON p.brandId = b.id
//     //    JOIN mrs m ON p.mrId = m.mrId
//     //    WHERE p.mrId = ? AND p.id = ? AND p.status = 'rejected'
//     //    LIMIT 1`,
//     //   [mrId, prescriptionId]
//     // );

//     const [rows] = await connection.execute(
//       `SELECT p.*, b.points AS brandPoints, m.mrName, m.hq AS mrHq, m.region AS mrRegion, m.zone AS mrZone
//        FROM uploads p
//        LEFT JOIN brands b ON p.brandId = b.id
//        JOIN mrs m ON p.mrId = m.mrId
//        WHERE p.type = 'prescription'
//          AND p.mrId = ? AND p.id = ? AND p.status = 'rejected'
//        LIMIT 1`,
//       [mrId, prescriptionId]
//     );

//     if (rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "Rejected prescription not found for this MR",
//       });
//     }

//     const prescription = rows[0];

//     return res.status(200).json({
//       success: true,
//       data: prescription,
//     });
//   } catch (error) {
//     console.error("Error fetching rejected prescription:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };

// export const resubmitPrescription = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { mrId, prescriptionId } = req.params;
//     const {
//       drName,
//       speciality,
//       mobNo,
//       scCode,
//       brandName,
//       noRxns,
//       rxnDuration,
//       dateOfUpload,
//     } = req.body;

//     // OLD CODE - using prescriptions table
//     // const [prescriptionRows] = await connection.execute(
//     //   `SELECT p.*, m.flmId 
//     //    FROM prescriptions p
//     //    JOIN mrs m ON p.mrId = m.mrId
//     //    WHERE p.id = ? AND p.mrId = ?
//     //    LIMIT 1`,
//     //   [prescriptionId, mrId]
//     // );

//     const [prescriptionRows] = await connection.execute(
//       `SELECT p.*, m.flmId 
//        FROM uploads p
//        JOIN mrs m ON p.mrId = m.mrId
//        WHERE p.type = 'prescription'
//          AND p.id = ? AND p.mrId = ?
//        LIMIT 1`,
//       [prescriptionId, mrId]
//     );

//     if (prescriptionRows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "Prescription not found for this MR",
//       });
//     }

//     const prescription = prescriptionRows[0];

//     if (prescription.status !== "rejected") {
//       return res.status(400).json({
//         success: false,
//         message: "Only rejected prescriptions can be resubmitted",
//       });
//     }

//     const currentAttempts = Number(prescription.attempts) || 0;
//     if (currentAttempts >= 1) {
//       return res.status(400).json({
//         success: false,
//         message: "Maximum resubmission attempts reached",
//       });
//     }

//     const targetBrandName = brandName || prescription.brandName;
//     const [brandRows] = await connection.execute(
//       "SELECT * FROM brands WHERE brandName = ?",
//       [targetBrandName]
//     );

//     if (brandRows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "Brand Not Found",
//       });
//     }

//     const brand = brandRows[0];
//     const brandPoints = parseInt(brand.points) || 0;

//     const noRxnsInt =
//       noRxns !== undefined && noRxns !== null && noRxns !== ""
//         ? parseInt(noRxns) || 1
//         : parseInt(prescription.noRxns) || 1;

//     const rxnDurationInt =
//       rxnDuration !== undefined && rxnDuration !== null && rxnDuration !== ""
//         ? parseInt(rxnDuration) || 1
//         : parseInt(prescription.rxnDuration) ||
//           parseInt(brand.defaultRxnDuration) ||
//           1;

//     const totalPoints = brandPoints * noRxnsInt * rxnDurationInt;

//     let prescriptionImagePath = prescription.uploadImage;
//     if (req.file) {
//       try {
//         // Get prescriptions upload directory
//         const typeUploadsDir = getUploadsDir("prescription");
//         const fileExtension = path.extname(req.file.originalname) || ".jpg";
//         const fileName = `${mrId}_${Date.now()}${fileExtension}`;
//         const filePath = path.join(typeUploadsDir, fileName);

//         fs.writeFileSync(filePath, req.file.buffer);
//         prescriptionImagePath = `/uploads/prescriptions/${fileName}`;
//       } catch (fileError) {
//         console.error("Error saving resubmitted file:", fileError);
//         return res.status(500).json({
//           success: false,
//           message: "Failed to save prescription image",
//           error: fileError.message,
//         });
//       }
//     }

//     const uploadTime = new Date();
//     const formattedTime = `${uploadTime.getHours().toString().padStart(2, "0")}:${uploadTime
//       .getMinutes()
//       .toString()
//       .padStart(2, "0")}`;

//     const formattedDrName =
//       drName !== undefined && drName !== null && drName !== ""
//         ? formatDoctorName(drName)
//         : formatDoctorName(prescription.drName);

//     await connection.beginTransaction();

//     // OLD CODE - using prescriptions table
//     // await connection.execute(
//     //   `UPDATE prescriptions 
//     //    SET brandId = ?, 
//     //        brandName = ?, 
//     //        drName = ?, 
//     //        speciality = ?, 
//     //        mobNo = ?, 
//     //        scCode = ?, 
//     //        noRxns = ?, 
//     //        rxnDuration = ?, 
//     //        prescriptionImage = ?, 
//     //        dateOfUpload = ?, 
//     //        timeOfUpload = ?, 
//     //        points = ?, 
//     //        isCalculated = 0,
//     //        status = 'pending',
//     //        rejectionReason = NULL,
//     //        attempts = ?,
//     //        reviewDate = NULL
//     //    WHERE id = ?`,
//     //   ...

//     await connection.execute(
//       `UPDATE uploads 
//        SET brandId = ?, 
//            brandName = ?, 
//            drName = ?, 
//            speciality = ?, 
//            mobNo = ?, 
//            scCode = ?, 
//            noRxns = ?, 
//            rxnDuration = ?, 
//            uploadImage = ?, 
//            dateOfUpload = ?, 
//            timeOfUpload = ?, 
//            points = ?, 
//            isCalculated = 0,
//            status = 'pending',
//            rejectionReason = NULL,
//            attempts = ?,
//            reviewDate = NULL
//        WHERE type = 'prescription'
//          AND id = ?`,
//       [
//         brand.id,
//         brand.brandName || targetBrandName,
//         formattedDrName,
//         speciality !== undefined ? speciality || null : prescription.speciality,
//         mobNo !== undefined ? mobNo || null : prescription.mobNo,
//         scCode !== undefined ? scCode || null : prescription.scCode,
//         noRxnsInt,
//         rxnDurationInt,
//         prescriptionImagePath,
//         dateOfUpload || prescription.dateOfUpload,
//         formattedTime,
//         totalPoints,
//         currentAttempts + 1,
//         prescriptionId,
//       ]
//     );

//     await connection.commit();

//     res.status(200).json({
//       success: true,
//       message: "Prescription resubmitted for review",
//       data: {
//         prescriptionId,
//         status: "pending",
//         attempts: currentAttempts + 1,
//         prescriptionImage: prescriptionImagePath,
//         doctorName: formattedDrName,
//       },
//     });
//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error resubmitting prescription:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };