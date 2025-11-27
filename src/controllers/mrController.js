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

// Function to get type-specific upload directory from database
const getUploadsDir = async (connection, type) => {
  const normalizedType = type.toLowerCase();
  
  // Query activityTypes table for folderName
  const [activityTypeRows] = await connection.execute(
    "SELECT folderName FROM activityTypes WHERE typeName = ? AND isActive = 1",
    [normalizedType]
  );
  
  let folderName;
  if (activityTypeRows.length > 0) {
    folderName = activityTypeRows[0].folderName;
  } else {
    // Fallback to type name if not found in database
    folderName = normalizedType;
  }
  
  const uploadsDir = path.join(baseUploadsDir, folderName);
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  return { uploadsDir, folderName };
};

// Note: Folder creation is now handled inline using activityType.folderName
// This ensures folders are created dynamically based on the activity type configuration

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

    // Validate type and fetch activity type configuration
    if (!type) {
      return res.status(400).json({
        success: false,
        message: "Type is required",
      });
    }

    const normalizedType = type.toLowerCase();

    // Fetch activity type from database
    const [activityTypeRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE typeName = ? AND isActive = 1",
      [normalizedType]
    );

    if (activityTypeRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid activity type or type is not active",
      });
    }

    const activityType = activityTypeRows[0];
    
    // Parse activitySpecificFields
    let activitySpecificFields = [];
    if (activityType.activitySpecificFields) {
      try {
        activitySpecificFields = typeof activityType.activitySpecificFields === 'string'
          ? JSON.parse(activityType.activitySpecificFields)
          : activityType.activitySpecificFields;
        
        if (!Array.isArray(activitySpecificFields)) {
          activitySpecificFields = [];
        }
      } catch (error) {
        console.error("Error parsing activitySpecificFields:", error);
        activitySpecificFields = [];
      }
    }

    // Common fields that are always required
    const COMMON_FIELDS = [
      { fieldName: "drName", required: true },
      { fieldName: "scCode", required: true },
    ];

    // Combine common fields and activity-specific fields for validation
    const allRequiredFields = [
      ...COMMON_FIELDS.filter(f => f.required),
      ...activitySpecificFields.filter(f => f.required)
    ];

    // Dynamic validation based on activitySpecificFields
    const missingFields = [];

    // Validate common required fields
      if (!drName) missingFields.push("drName");
      if (!scCode) missingFields.push("scCode");

    // Validate activity-specific required fields
    activitySpecificFields.forEach((field) => {
      if (field.required) {
        const fieldValue = req.body[field.fieldName];
        if (!fieldValue || (typeof fieldValue === 'string' && fieldValue.trim() === '')) {
          missingFields.push(field.fieldName);
        }
      }
    });

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Please fill all required details: ${missingFields.join(", ")}`,
      });
    }

    // Validate dropdown field values against allowed options
    for (const field of activitySpecificFields) {
      if (field.type === 'dropdown' && field.options && Array.isArray(field.options)) {
        const fieldValue = req.body[field.fieldName];
        
        // Skip validation if field is not required and value is empty
        if (!field.required && (!fieldValue || (typeof fieldValue === 'string' && fieldValue.trim() === ''))) {
          continue;
        }
        
        // If field is required or has a value, validate it
        if (fieldValue !== undefined && fieldValue !== null && fieldValue !== '') {
          const stringValue = String(fieldValue).trim();
          let isValid = false;
          
          // Check if value matches any of the allowed options
          for (const option of field.options) {
            if (typeof option === 'string') {
              if (option === stringValue) {
                isValid = true;
                break;
              }
            } else if (typeof option === 'object' && option !== null) {
              // For object options, check both value and label
              const optionValue = String(option.value || option.label || '');
              if (optionValue === stringValue) {
                isValid = true;
                break;
              }
            }
          }
          
          if (!isValid) {
            return res.status(400).json({
              success: false,
              message: `Invalid value for ${field.fieldName}. Please select a valid option.`,
            });
          }
        }
      }
    }

    // Check if MR exists and get FLM ID
    const [mrRows] = await connection.execute("SELECT * FROM mrs WHERE mrId = ?", [mrId]);

    if (mrRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "MR Id Not Found",
      });
    }

    const mr = mrRows[0];
    const flmId = mr.flmId;

    let brand = null;
    let camp = null;
    let totalPoints = 0;
    let brandId = null;
    let brandNameValue = null;
    let campId = null;
    let campNameValue = null;
    let campDefaultFactor = null;

    // Check if activity type requires brand (has brandName field)
    const hasBrandNameField = activitySpecificFields.some(field => field.fieldName === "brandName");
    
    if (hasBrandNameField) {
      // Get brandName from request body
      const brandNameFromRequest = req.body.brandName || brandName;
      if (!brandNameFromRequest) {
        return res.status(400).json({
          success: false,
          message: "brandName is required",
        });
      }

      // Trim and normalize brandName for case-insensitive matching
      const normalizedBrandName = brandNameFromRequest.trim();
      const [brandRows] = await connection.execute(
        "SELECT * FROM brands WHERE LOWER(TRIM(brandName)) = LOWER(TRIM(?))", 
        [normalizedBrandName]
      );

      if (brandRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Brand Not Found",
        });
      }

      brand = brandRows[0];
      brandId = brand.id;
      brandNameValue = normalizedBrandName;
      const brandPoints = parseInt(brand.points) || 0;

      // Calculate points based on activity-specific fields
      // Check for noRxns field (prescription-like)
      const hasNoRxnsField = activitySpecificFields.some(field => field.fieldName === "noRxns");
      if (hasNoRxnsField) {
        const noRxnsValue = req.body.noRxns || noRxns;
        const noRxnsInt = parseInt(noRxnsValue) || 1;
        const rxnDurationInt = parseInt(brand.defaultRxnDuration) || 1;
        totalPoints = brandPoints * noRxnsInt * rxnDurationInt;
      } else {
        // POB-like: check for noOfUnits or allValue
        const hasNoOfUnitsField = activitySpecificFields.some(field => field.fieldName === "noOfUnits");
        const hasAllValueField = activitySpecificFields.some(field => field.fieldName === "allValue");
        
        if (hasNoOfUnitsField || hasAllValueField) {
        const brandCountType = brand.countType ? brand.countType.toLowerCase() : null;
        
        if (brandCountType === "unit") {
            const noOfUnitsValue = req.body.noOfUnits || noOfUnits;
            if (!noOfUnitsValue && hasNoOfUnitsField) {
            return res.status(400).json({
              success: false,
              message: "noOfUnits is required for this brand (countType: unit)",
            });
          }
            const noOfUnitsInt = parseInt(noOfUnitsValue) || 1;
            const rxnDurationInt = parseInt(brand.defaultRxnDuration) || 1;
          const factor = parseInt(brand.unitFactor) || 1;
          totalPoints = brandPoints * noOfUnitsInt * rxnDurationInt * factor;
        } else if (brandCountType === "value") {
            const allValueFromRequest = req.body.allValue || allValue;
            if (!allValueFromRequest && hasAllValueField) {
            return res.status(400).json({
              success: false,
              message: "allValue is required for this brand (countType: value)",
            });
          }
            const allValueInt = parseInt(allValueFromRequest) || 1;
            const rxnDurationInt = parseInt(brand.defaultRxnDuration) || 1;
          const factor = parseInt(brand.valueFactor) || 1;
          totalPoints = brandPoints * allValueInt * rxnDurationInt * factor;
        } else {
            // Fallback: use whichever field is provided
            const noOfUnitsValue = req.body.noOfUnits || noOfUnits;
            const allValueFromRequest = req.body.allValue || allValue;
            if (!noOfUnitsValue && !allValueFromRequest) {
            return res.status(400).json({
              success: false,
              message: "Either noOfUnits or allValue is required. Please check brand configuration.",
            });
          }
            const valueInt = parseInt(noOfUnitsValue || allValueFromRequest) || 1;
            const rxnDurationInt = parseInt(brand.defaultRxnDuration) || 1;
          totalPoints = brandPoints * valueInt * rxnDurationInt;
          }
        } else {
          // If brand is required but no specific calculation fields, use default
          totalPoints = brandPoints;
        }
      }
    }

    // Check if activity type requires camp (has campName field)
    const hasCampNameField = activitySpecificFields.some(field => field.fieldName === "campName");
    
    if (hasCampNameField) {
      // Get campName from request body
      const campNameFromRequest = req.body.campName || campName;
      if (!campNameFromRequest) {
        return res.status(400).json({
          success: false,
          message: "campName is required",
        });
      }

      // Trim and normalize campName for case-insensitive matching
      const normalizedCampName = campNameFromRequest.trim();
      const [campRows] = await connection.execute(
        "SELECT * FROM camps WHERE LOWER(TRIM(campName)) = LOWER(TRIM(?))", 
        [normalizedCampName]
      );

      if (campRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Camp Not Found",
        });
      }

      camp = campRows[0];
      campId = camp.id;
      campNameValue = normalizedCampName;
      campDefaultFactor = parseInt(camp.defaultFactor) || 1;
      const campPoints = parseInt(camp.points) || 0;
      
      // Get noOfCamps from request body or activitySpecificFields
      const noOfCampsValue = req.body.noOfCamps || noOfCamps;
      const noOfCampsInt = parseInt(noOfCampsValue) || 1;
      totalPoints = campPoints * noOfCampsInt * campDefaultFactor;
    }

    // For new activity types (not prescription, pob, camp), use dynamic calculation
    // Calculate points and diamonds based on pointFactor and diamonds from activitySpecificFields
    const isLegacyType = normalizedType === 'prescription' || normalizedType === 'pob' || normalizedType === 'camp';
    let calculatedDiamonds = 0;
    
    if (!isLegacyType && totalPoints === 0) {
      // First, check for dropdown fields with options that have pointFactor/hearts
      // This allows dropdown selection to determine pointFactor/hearts, then multiply by numeric field
      const dropdownFields = activitySpecificFields.filter(field => 
        field.type === 'dropdown' && 
        Array.isArray(field.options) && 
        field.options.length > 0
      );
      
      // Check if any dropdown option has pointFactor or hearts
      let dropdownBasedCalculation = false;
      for (const dropdownField of dropdownFields) {
        const dropdownValue = req.body[dropdownField.fieldName];
        if (dropdownValue !== undefined && dropdownValue !== null && dropdownValue !== '') {
          // Find the selected option
          const selectedOption = dropdownField.options.find(opt => {
            if (typeof opt === 'string') return opt === dropdownValue;
            if (typeof opt === 'object' && opt !== null) {
              return (opt.value || opt.label || String(opt)) === dropdownValue;
            }
            return false;
          });
          
          if (selectedOption) {
            // Check if this option has pointFactor or hearts
            // Only use if explicitly provided (not null/undefined)
            let optionPointFactor = null;
            let optionHearts = null;
            
            if (typeof selectedOption === 'object' && selectedOption !== null) {
              // Only set if explicitly provided and not null
              if (selectedOption.pointFactor !== undefined && selectedOption.pointFactor !== null) {
                const parsedPointFactor = Number(selectedOption.pointFactor);
                if (!isNaN(parsedPointFactor) && parsedPointFactor > 0) {
                  optionPointFactor = parsedPointFactor;
                }
              }
              if (selectedOption.diamonds !== undefined && selectedOption.diamonds !== null) {
                const parsedDiamonds = Number(selectedOption.diamonds);
                if (!isNaN(parsedDiamonds) && parsedDiamonds > 0) {
                  optionDiamonds = parsedDiamonds;
                }
              }
            }
            
            // Only proceed if option has at least one valid pointFactor or diamonds
            if (optionPointFactor !== null || optionDiamonds !== null) {
              dropdownBasedCalculation = true;
              
              // Find all numeric fields in activitySpecificFields
              for (const fieldDef of activitySpecificFields) {
                if (fieldDef.type === 'number' || fieldDef.type === 'integer') {
                  const numericFieldName = fieldDef.fieldName;
                  const numericValue = Number(req.body[numericFieldName]);
                  
                  if (!isNaN(numericValue) && numericValue > 0) {
                    // Calculate: selectedOption.pointFactor × numericValue (only if pointFactor is provided)
                    if (optionPointFactor !== null) {
                      totalPoints += optionPointFactor * numericValue;
                    }
                    
                    // Calculate: selectedOption.diamonds × numericValue (only if diamonds is provided)
                    if (optionDiamonds !== null) {
                      calculatedDiamonds += optionDiamonds * numericValue;
                    }
                  }
                }
              }
            }
          }
        }
      }
      
      // If no dropdown-based calculation was used, fall back to field-level pointFactor/diamonds
      if (!dropdownBasedCalculation) {
        // Loop through activitySpecificFields to find numeric fields
        for (const fieldDef of activitySpecificFields) {
          const fieldName = fieldDef.fieldName;
          const fieldValue = req.body[fieldName];

          if (fieldValue !== undefined && fieldValue !== null) {
            // Check if it's a numeric field (type is 'number' or value can be parsed as number)
            const numericValue = Number(fieldValue);
            if (!isNaN(numericValue) && numericValue > 0) {
              // Get pointFactor and diamonds from field definition
              const pointFactor = Number(fieldDef.pointFactor) || 0;
              const diamonds = Number(fieldDef.diamonds) || 0;
              
              // Calculate points: pointFactor * numeric field value
              // Example: if numberOfMedicines = 5 and pointFactor = 2, then points = 2 * 5 = 10
              if (pointFactor > 0) {
                totalPoints += pointFactor * numericValue;
              }
              
              // Calculate diamonds: diamonds * numeric field value
              // Example: if numberOfMedicines = 5 and diamonds = 1, then diamonds = 1 * 5 = 5
              if (diamonds > 0) {
                calculatedDiamonds += diamonds * numericValue;
              }
            }
          }
        }
      }
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
      // Get type-specific upload directory based on activityType folderName
      // Use folderName from activityType that was already fetched
      const folderName = activityType.folderName || normalizedType;
      const typeUploadsDir = path.join(baseUploadsDir, folderName);
      
      // Create directory if it doesn't exist
      if (!fs.existsSync(typeUploadsDir)) {
        fs.mkdirSync(typeUploadsDir, { recursive: true });
      }
      
      const fileExtension = path.extname(req.file.originalname) || ".jpg";
      const fileName = `${mrId}_${Date.now()}${fileExtension}`;
      const filePath = path.join(typeUploadsDir, fileName);

      // Write file to disk
      fs.writeFileSync(filePath, req.file.buffer);
      
      // Store path with type-specific folder (from activityType.folderName)
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

    // Format doctor name - always add "Dr." prefix if not already present
    const formattedDrName = formatDoctorName(drName);

    await connection.beginTransaction();

    // Get config to check auto-approval setting
    const [configRows] = await connection.execute(
      `SELECT isAutoApprovalAllowed
       FROM config
       ORDER BY createdAt DESC
       LIMIT 1`
    );

    const config = configRows?.[0] ?? {};
    const isAutoApprovalAllowed = config.isAutoApprovalAllowed !== undefined 
      ? (config.isAutoApprovalAllowed === 1 || config.isAutoApprovalAllowed === true)
      : true; // Default to true if config doesn't exist

    // Prepare insert values based on type
    const uploadId = crypto.randomUUID();
    let insertFields = [];
    let insertValues = [];
    let placeholders = [];

    // Common fields - include createdAt and updatedAt with IST time
    // Set status based on auto-approval setting
    const initialStatus = isAutoApprovalAllowed ? "approved" : "pending";
    const initialIsCalculated = isAutoApprovalAllowed ? 1 : 0; // Only mark as calculated if auto-approved
    const initialReason = isAutoApprovalAllowed ? "auto approved" : null; // Set reason based on approval method
    
    insertFields.push("id", "type", "mrId", "uploadImage", "dateOfUpload", "timeOfUpload", "points", "isCalculated", "status", "reason", "attempts", "reviewDate", "createdAt", "updatedAt");
    insertValues.push(uploadId, normalizedType, mrId, uploadImagePath, formattedDate, formattedTime, totalPoints, initialIsCalculated, initialStatus, initialReason, 0, istDateTimeString, istDateTimeString, istDateTimeString);
    placeholders.push("?", "?", "?", "?", "?", "?", "?", "?", "?", "?", "?", "?", "?", "?");

    // Common fields that exist in the table
    insertFields.push("drName", "speciality", "mobNo", "scCode");
      insertValues.push(
        formattedDrName,
        speciality || null,
        mobNo || null,
      scCode || null
    );
    placeholders.push("?", "?", "?", "?");

    // Build activitySpecificDetails JSON object dynamically based on activitySpecificFields
    let activitySpecificDetails = {};

    // Add brand-related fields if brand is present
    if (brandId && brandNameValue) {
      activitySpecificDetails.brandId = brandId;
      activitySpecificDetails.brandName = brandNameValue;
      // Add rxnDuration from brand's defaultRxnDuration if brand is used
      if (brand && brand.defaultRxnDuration) {
        activitySpecificDetails.rxnDuration = parseInt(brand.defaultRxnDuration) || 1;
      }
    }

    // Add camp-related fields if camp is present
    if (campId && campNameValue) {
      activitySpecificDetails.campId = campId;
      activitySpecificDetails.campName = campNameValue;
      if (campDefaultFactor !== null) {
        activitySpecificDetails.campDefaultFactor = campDefaultFactor;
      }
    }

    // Store calculated diamonds for new activity types (if calculated)
    if (calculatedDiamonds > 0) {
      activitySpecificDetails._calculatedDiamonds = calculatedDiamonds;
    }

    // Reserved/system fields that should NOT be stored in activitySpecificDetails
    // These are database columns managed by the system, not user input fields
    // NOTE: If a field with the same name exists in activitySpecificFields, it's a user-defined field
    // and should be allowed. The flattening logic will ensure database columns take precedence.
    const reservedFields = new Set([
      'reason',         // System-managed rejection/approval reason
      'attempts',       // System-managed resubmission attempts
      'reviewDate',     // System-managed review date
      'points',         // System-calculated points
      'diceRollBalance', // System-calculated dice rolls
      'isCalculated',   // System flag
      'id',             // System-generated ID
      'type',           // Activity type (from activityTypes table)
      'mrId',           // MR ID (from request params)
      'uploadImage',    // File path (handled separately)
      'dateOfUpload',   // Upload date (handled separately)
      'timeOfUpload',   // Upload time (handled separately)
      'createdAt',      // System timestamp
      'updatedAt',      // System timestamp
      'drName',         // Common field (stored in separate column)
      'speciality',     // Common field (stored in separate column)
      'mobNo',          // Common field (stored in separate column)
      'scCode',         // Common field (stored in separate column)
    ]);
    
    // Check if 'status' is a user-defined field in activitySpecificFields
    // If it is, we should allow it (it's a user input field, not the system status)
    const hasStatusField = activitySpecificFields.some(field => field.fieldName === 'status');
    // If status is NOT a user-defined field, add it to reserved fields
    if (!hasStatusField) {
      reservedFields.add('status'); // System-managed approval status
    }

    // Dynamically add all activity-specific fields from the request
    activitySpecificFields.forEach((field) => {
      const fieldName = field.fieldName;
      const fieldValue = req.body[fieldName];
      
      // Skip reserved/system fields and fields already handled above
      // Note: If status is a user-defined field, it will pass this check
      if (reservedFields.has(fieldName) || fieldName === "brandName" || fieldName === "campName") {
        return;
      }

      // Handle different field types
      if (fieldValue !== undefined && fieldValue !== null && fieldValue !== "") {
        if (field.type === "number" || field.type === "integer") {
          activitySpecificDetails[fieldName] = parseInt(fieldValue) || 0;
        } else if (field.type === "dropdown") {
          // Store dropdown value as string (already validated against options)
          activitySpecificDetails[fieldName] = String(fieldValue).trim();
        } else if (field.type === "string") {
          // Apply capitalization for specific fields
          if (fieldName === "chemistName" || fieldName === "drName") {
            activitySpecificDetails[fieldName] = capitalizeWords(fieldValue);
          } else {
            activitySpecificDetails[fieldName] = String(fieldValue).trim();
          }
        } else {
          activitySpecificDetails[fieldName] = fieldValue;
        }
      } else if (field.required) {
        // For required fields, set default values based on type
        if (field.type === "number" || field.type === "integer") {
          activitySpecificDetails[fieldName] = 0;
        } else {
          activitySpecificDetails[fieldName] = null;
        }
      }
    });

    // Store calculated diamonds for new activity types (if calculated)
    if (calculatedDiamonds > 0) {
      activitySpecificDetails._calculatedDiamonds = calculatedDiamonds;
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

    // Auto-approve first-time uploads: Add points and dice rolls immediately
    // Only if isAutoApprovalAllowed is true
    if (isAutoApprovalAllowed && totalPoints > 0 && flmId) {
      // Get config for move factor calculation
      const [configRowsForMoves] = await connection.execute(
        `SELECT medianValue, lessMedianFactor, greaterMedianFactor
         FROM config
         ORDER BY createdAt DESC
         LIMIT 1`
      );

      const configForMoves = configRowsForMoves?.[0] ?? {};
      const medianValue = Number(configForMoves.medianValue);
      const lessMedianFactor = Number(configForMoves.lessMedianFactor);
      const greaterMedianFactor = Number(configForMoves.greaterMedianFactor);

      const [flmRows] = await connection.execute(
        `SELECT mrCount
         FROM flms
         WHERE flmId = ?
         LIMIT 1
         FOR UPDATE`,
        [flmId]
      );

      const mrCount = Number(flmRows?.[0]?.mrCount) || 0;

      let moveFactor = 1;
      if (Number.isFinite(medianValue)) {
        if (mrCount < medianValue && Number.isFinite(lessMedianFactor)) {
          moveFactor = lessMedianFactor;
        } else if (mrCount > medianValue && Number.isFinite(greaterMedianFactor)) {
          moveFactor = greaterMedianFactor;
        }
      }

      const computedMoves = totalPoints * moveFactor;
      const movesToAdd = Number.isFinite(computedMoves) ? computedMoves : totalPoints;
      const diceRollBalance = movesToAdd;

      // Update upload with diceRollBalance
      await connection.execute(
        `UPDATE uploads
         SET diceRollBalance = ?
         WHERE id = ?`,
        [diceRollBalance, uploadId]
      );

      // Add points and dice rolls to MR
      await connection.execute(
        `UPDATE mrs 
         SET points = COALESCE(points, 0) + ?,
             diceRollBalance = COALESCE(diceRollBalance, 0) + ?,
             updatedAt = ?
         WHERE mrId = ?`,
        [totalPoints, diceRollBalance, istDateTimeString, mrId]
      );

      // Add points and dice rolls to FLM
      await connection.execute(
        `UPDATE flms 
         SET points = COALESCE(points, 0) + ?,
             currentDiceRollBalance = COALESCE(currentDiceRollBalance, 0) + ?,
             updatedAt = ?
         WHERE flmId = ?`,
        [totalPoints, movesToAdd, istDateTimeString, flmId]
      );

      // Award hearts and/or dice rolls based on activity type (dynamic)
      // Use values from activitySpecificDetails (already built above) to determine multiplier
      if (brandId) {
        const [brandRows] = await connection.execute(
          `SELECT diamonds, diceRolls, countType FROM brands WHERE id = ?`,
          [brandId]
        );

        if (brandRows.length > 0) {
          const brandData = brandRows[0];
          let multiplier = 1;
          
          // Determine multiplier based on actual values in activitySpecificDetails
          // Priority: noRxns > (noOfUnits/allValue based on countType)
          if (activitySpecificDetails.noRxns !== undefined && activitySpecificDetails.noRxns !== null) {
            // Prescription-like: use noRxns
            multiplier = parseInt(activitySpecificDetails.noRxns) || 1;
          } else {
            // POB-like: use noOfUnits or allValue based on brand's countType
            const brandCountType = brandData.countType ? brandData.countType.toLowerCase() : null;
            if (brandCountType === "unit") {
              multiplier = parseInt(activitySpecificDetails.noOfUnits) || 1;
            } else if (brandCountType === "value") {
              multiplier = parseInt(activitySpecificDetails.allValue) || 1;
            } else {
              // Fallback: use whichever is available
              multiplier = parseInt(activitySpecificDetails.noOfUnits || activitySpecificDetails.allValue) || 1;
            }
          }
          
          const brandDiamonds = Number(brandData.diamonds) || 0;
          if (brandDiamonds > 0) {
            const diamondsToAward = brandDiamonds * multiplier;
            await connection.execute(
              `UPDATE flms 
               SET diamonds = COALESCE(diamonds, 0) + ?,
                   updatedAt = ?
               WHERE flmId = ?`,
              [diamondsToAward, istDateTimeString, flmId]
            );
            // Also award diamonds to MR
            await connection.execute(
              `UPDATE mrs 
               SET diamonds = COALESCE(diamonds, 0) + ?,
                   updatedAt = ?
               WHERE mrId = ?`,
              [diamondsToAward, istDateTimeString, mrId]
            );
          }

          const brandDiceRolls = Number(brandData.diceRolls) || 0;
          if (brandDiceRolls > 0) {
            const diceRollsToAward = brandDiceRolls * multiplier;
            await connection.execute(
              `UPDATE flms 
               SET currentDiceRollBalance = COALESCE(currentDiceRollBalance, 0) + ?,
                   updatedAt = ?
               WHERE flmId = ?`,
              [diceRollsToAward, istDateTimeString, flmId]
            );
          }
        }
      } else if (campId) {
        const [campRows] = await connection.execute(
          `SELECT diamonds, diceRolls FROM camps WHERE id = ?`,
          [campId]
        );

        if (campRows.length > 0) {
          const campData = campRows[0];
          // Use noOfCamps from activitySpecificDetails
          const noOfCampsInt = parseInt(activitySpecificDetails.noOfCamps) || 1;
          
          const campDiamonds = Number(campData.diamonds) || 0;
          if (campDiamonds > 0) {
            const diamondsToAward = campDiamonds * noOfCampsInt;
            await connection.execute(
              `UPDATE flms 
               SET diamonds = COALESCE(diamonds, 0) + ?,
                   updatedAt = ?
               WHERE flmId = ?`,
              [diamondsToAward, istDateTimeString, flmId]
            );
            // Also award diamonds to MR
            await connection.execute(
              `UPDATE mrs 
               SET diamonds = COALESCE(diamonds, 0) + ?,
                   updatedAt = ?
               WHERE mrId = ?`,
              [diamondsToAward, istDateTimeString, mrId]
            );
          }

          const campDiceRolls = Number(campData.diceRolls) || 0;
          if (campDiceRolls > 0) {
            const diceRollsToAward = campDiceRolls * noOfCampsInt;
            await connection.execute(
              `UPDATE flms 
               SET currentDiceRollBalance = COALESCE(currentDiceRollBalance, 0) + ?,
                   updatedAt = ?
               WHERE flmId = ?`,
              [diceRollsToAward, istDateTimeString, flmId]
            );
          }
        }
      }

      // Award calculated diamonds for new activity types (not prescription, pob, camp) during auto-approval
      const isLegacyType = normalizedType === 'prescription' || normalizedType === 'pob' || normalizedType === 'camp';
      if (!isLegacyType && calculatedDiamonds > 0) {
        await connection.execute(
          `UPDATE flms 
           SET diamonds = COALESCE(diamonds, 0) + ?,
               updatedAt = ?
           WHERE flmId = ?`,
          [calculatedDiamonds, istDateTimeString, flmId]
        );
        // Also award diamonds to MR
        await connection.execute(
          `UPDATE mrs 
           SET diamonds = COALESCE(diamonds, 0) + ?,
               updatedAt = ?
           WHERE mrId = ?`,
          [calculatedDiamonds, istDateTimeString, mrId]
        );
      }
    }

    await connection.commit();

    // Prepare response based on type
    const responseData = {
      uploadId,
      type: normalizedType,
      points: totalPoints,
      uploadImage: uploadImagePath,
      status: initialStatus, // "approved" if auto-approval enabled, "pending" if disabled
      attempts: 0,
      isCalculated: initialIsCalculated === 1, // true if auto-approved, false if pending
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
      const { uploadsDir: typeUploadsDir, folderName } = await getUploadsDir(connection, "prescription");
      const fileExtension = path.extname(req.file.originalname) || ".jpg";
      const fileName = `${mrId}_${Date.now()}${fileExtension}`;
      const filePath = path.join(typeUploadsDir, fileName);

      // Write file to disk
      fs.writeFileSync(filePath, req.file.buffer);
      prescriptionImagePath = `/uploads/${folderName}/${fileName}`;

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

    // Handle type filter - support any activity type dynamically
    let typeClause = "";
    const typeParams = [];
    if (type && type.trim()) {
      typeClause = " AND p.type = ?";
      typeParams.push(type.trim().toLowerCase());
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
    // Exclude database column fields that should not be overridden
    const dbColumnFields = new Set([
      'id', 'type', 'mrId', 'uploadImage', 'dateOfUpload', 'timeOfUpload',
      'status', 'reason', 'attempts', 'reviewDate', 'points', 'diceRollBalance',
      'isCalculated', 'activitySpecificDetails', 'drName', 'speciality', 'mobNo',
      'scCode', 'createdAt', 'updatedAt', 'mrName', 'mrZone', 'mrHq', 'mrRegion',
      'brandPoints', 'countType', 'unitFactor', 'valueFactor', 'campPoints', 'campDefaultFactor'
    ]);
    
    const flattenedUploads = rejectedUploads.map(upload => {
      if (upload.activitySpecificDetails) {
        try {
          const activityDetails = typeof upload.activitySpecificDetails === 'string' 
            ? JSON.parse(upload.activitySpecificDetails) 
            : upload.activitySpecificDetails;
          
          if (activityDetails) {
            // Filter out database column fields from activityDetails to prevent overriding
            const filteredActivityDetails = {};
            Object.keys(activityDetails).forEach(key => {
              if (!dbColumnFields.has(key)) {
                filteredActivityDetails[key] = activityDetails[key];
              }
            });
            
            return {
              ...upload,
              ...filteredActivityDetails,
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
    // Exclude database column fields that should not be overridden
    const dbColumnFields = new Set([
      'id', 'type', 'mrId', 'uploadImage', 'dateOfUpload', 'timeOfUpload',
      'status', 'reason', 'attempts', 'reviewDate', 'points', 'diceRollBalance',
      'isCalculated', 'activitySpecificDetails', 'drName', 'speciality', 'mobNo',
      'scCode', 'createdAt', 'updatedAt', 'mrName', 'mrZone', 'mrHq', 'mrRegion',
      'brandPoints', 'countType', 'unitFactor', 'valueFactor', 'campPoints', 'campDefaultFactor'
    ]);
    
    let flattenedUpload = { ...rejectedUpload };
    if (rejectedUpload.activitySpecificDetails) {
      try {
        const activityDetails = typeof rejectedUpload.activitySpecificDetails === 'string' 
          ? JSON.parse(rejectedUpload.activitySpecificDetails) 
          : rejectedUpload.activitySpecificDetails;
        
        // Filter out database column fields from activityDetails to prevent overriding
        if (activityDetails) {
          const filteredActivityDetails = {};
          Object.keys(activityDetails).forEach(key => {
            if (!dbColumnFields.has(key)) {
              filteredActivityDetails[key] = activityDetails[key];
            }
          });
          
          flattenedUpload = {
            ...rejectedUpload,
            ...filteredActivityDetails,
            // Keep activitySpecificDetails for reference
            activitySpecificDetails: activityDetails
          };
        }
      } catch (error) {
        console.error("Error parsing activitySpecificDetails:", error);
        // If parsing fails, return upload as-is
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
    const flmId = upload.flmId;

    if (upload.status !== "rejected") {
      return res.status(400).json({
        success: false,
        message: "Only rejected uploads can be resubmitted",
      });
    }

    // Fetch activity type for dynamic folder name and display name
    const normalizedUploadType = uploadType.toLowerCase();
    const [activityTypeRows] = await connection.execute(
      "SELECT typeName, folderName, activitySpecificFields FROM activityTypes WHERE typeName = ? AND isActive = 1",
      [normalizedUploadType]
    );

    if (activityTypeRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid activity type or type is not active",
      });
    }

    const activityType = activityTypeRows[0];

    const currentAttempts = Number(upload.attempts) || 0;
    if (currentAttempts >= 1) {
      return res.status(400).json({
        success: false,
        message: "Maximum resubmission attempts reached",
      });
    }

    // Check if FLM has active boards before allowing resubmission
    if (flmId) {
      // Get current IST datetime
      const currentISTDateTime = formatISTDateTimeForSQL();
      
      // Check for active boards (status = 'active' and endTime is NULL or in the future)
      // A board is considered ended if status is 'finished' or if endTime has passed
      const [boardRows] = await connection.execute(
        `SELECT id FROM boards
         WHERE status = 'active'
           AND (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)
           AND (endTime IS NULL OR endTime > ?)
         LIMIT 1`,
        [flmId, flmId, flmId, flmId, currentISTDateTime]
      );
      
      if (boardRows.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot resubmit uploads after all boards have ended. Please wait for new boards to be created.",
        });
      }
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

    // Handle new activity types (not prescription, pob, camp) - use dynamic calculation
    const isLegacyType = uploadType === 'prescription' || uploadType === 'pob' || uploadType === 'camp';
    let calculatedDiamonds = 0;
    
    if (!isLegacyType && totalPoints === 0) {
      // Parse activitySpecificFields from activityType
      let activitySpecificFields = [];
      if (activityType.activitySpecificFields) {
        try {
          activitySpecificFields = typeof activityType.activitySpecificFields === 'string'
            ? JSON.parse(activityType.activitySpecificFields)
            : activityType.activitySpecificFields;
          
          if (!Array.isArray(activitySpecificFields)) {
            activitySpecificFields = [];
          }
        } catch (error) {
          console.error("Error parsing activitySpecificFields:", error);
          activitySpecificFields = [];
        }
      }

      // First, check for dropdown fields with options that have pointFactor/diamonds
      const dropdownFields = activitySpecificFields.filter(field => 
        field.type === 'dropdown' && 
        Array.isArray(field.options) && 
        field.options.length > 0
      );
      
      // Check if any dropdown option has pointFactor or diamonds
      let dropdownBasedCalculation = false;
      for (const dropdownField of dropdownFields) {
        // Get value from request body or activityDetails
        const dropdownValue = req.body[dropdownField.fieldName] || activityDetails[dropdownField.fieldName];
        if (dropdownValue !== undefined && dropdownValue !== null && dropdownValue !== '') {
          // Find the selected option
          const selectedOption = dropdownField.options.find(opt => {
            if (typeof opt === 'string') return opt === dropdownValue;
            if (typeof opt === 'object' && opt !== null) {
              return (opt.value || opt.label || String(opt)) === dropdownValue;
            }
            return false;
          });
          
          if (selectedOption) {
            // Check if this option has pointFactor or diamonds
            // Only use if explicitly provided (not null/undefined)
            let optionPointFactor = null;
            let optionDiamonds = null;
            
            if (typeof selectedOption === 'object' && selectedOption !== null) {
              // Only set if explicitly provided and not null
              if (selectedOption.pointFactor !== undefined && selectedOption.pointFactor !== null) {
                const parsedPointFactor = Number(selectedOption.pointFactor);
                if (!isNaN(parsedPointFactor) && parsedPointFactor > 0) {
                  optionPointFactor = parsedPointFactor;
                }
              }
              if (selectedOption.diamonds !== undefined && selectedOption.diamonds !== null) {
                const parsedDiamonds = Number(selectedOption.diamonds);
                if (!isNaN(parsedDiamonds) && parsedDiamonds > 0) {
                  optionDiamonds = parsedDiamonds;
                }
              }
            }
            
            // Only proceed if option has at least one valid pointFactor or diamonds
            if (optionPointFactor !== null || optionDiamonds !== null) {
              dropdownBasedCalculation = true;
              
              // Find all numeric fields in activitySpecificFields
              for (const fieldDef of activitySpecificFields) {
                if (fieldDef.type === 'number' || fieldDef.type === 'integer') {
                  const numericFieldName = fieldDef.fieldName;
                  // Get value from request body or activityDetails
                  const numericValue = Number(req.body[numericFieldName] || activityDetails[numericFieldName]);
                  
                  if (!isNaN(numericValue) && numericValue > 0) {
                    // Calculate: selectedOption.pointFactor × numericValue (only if pointFactor is provided)
                    if (optionPointFactor !== null) {
                      totalPoints += optionPointFactor * numericValue;
                    }
                    
                    // Calculate: selectedOption.diamonds × numericValue (only if diamonds is provided)
                    if (optionDiamonds !== null) {
                      calculatedDiamonds += optionDiamonds * numericValue;
                    }
                  }
                }
              }
            }
          }
        }
      }
      
      // If no dropdown-based calculation was used, fall back to field-level pointFactor/diamonds
      if (!dropdownBasedCalculation) {
        // Loop through activitySpecificFields to find numeric fields
        for (const fieldDef of activitySpecificFields) {
          const fieldName = fieldDef.fieldName;
          // Get value from request body or activityDetails
          const fieldValue = req.body[fieldName] !== undefined ? req.body[fieldName] : activityDetails[fieldName];

          if (fieldValue !== undefined && fieldValue !== null) {
            // Check if it's a numeric field (type is 'number' or value can be parsed as number)
            const numericValue = Number(fieldValue);
            if (!isNaN(numericValue) && numericValue > 0) {
              // Get pointFactor and diamonds from field definition
              const pointFactor = Number(fieldDef.pointFactor) || 0;
              const diamonds = Number(fieldDef.diamonds) || 0;
              
              // Calculate points: pointFactor * numeric field value
              if (pointFactor > 0) {
                totalPoints += pointFactor * numericValue;
              }
              
              // Calculate diamonds: diamonds * numeric field value
              if (diamonds > 0) {
                calculatedDiamonds += diamonds * numericValue;
              }
            }
          }
        }
      }

      // Store calculated diamonds for new activity types (if calculated)
      if (calculatedDiamonds > 0) {
        newActivitySpecificDetails._calculatedDiamonds = calculatedDiamonds;
      }

      // Also handle brand-based calculation for new activity types (if brandName field exists)
      const hasBrandNameField = activitySpecificFields.some(field => field.fieldName === "brandName");
      if (hasBrandNameField && totalPoints === 0) {
        const targetBrandName = brandName || activityDetails.brandName;
        if (targetBrandName) {
          const [brandRows] = await connection.execute(
            "SELECT * FROM brands WHERE LOWER(TRIM(brandName)) = LOWER(TRIM(?))", 
            [targetBrandName.trim()]
          );

          if (brandRows.length > 0) {
            brand = brandRows[0];
            const brandPoints = parseInt(brand.points) || 0;

            // Check for noRxns field (prescription-like)
            const hasNoRxnsField = activitySpecificFields.some(field => field.fieldName === "noRxns");
            if (hasNoRxnsField) {
              const noRxnsValue = req.body.noRxns || activityDetails.noRxns;
              const noRxnsInt = parseInt(noRxnsValue) || 1;
              const rxnDurationInt = parseInt(brand.defaultRxnDuration) || 1;
              totalPoints = brandPoints * noRxnsInt * rxnDurationInt;
            } else {
              // POB-like: check for noOfUnits or allValue
              const hasNoOfUnitsField = activitySpecificFields.some(field => field.fieldName === "noOfUnits");
              const hasAllValueField = activitySpecificFields.some(field => field.fieldName === "allValue");
              
              if (hasNoOfUnitsField || hasAllValueField) {
                const brandCountType = brand.countType ? brand.countType.toLowerCase() : null;
                
                if (brandCountType === "unit") {
                  const noOfUnitsValue = req.body.noOfUnits || activityDetails.noOfUnits;
                  if (noOfUnitsValue) {
                    const noOfUnitsInt = parseInt(noOfUnitsValue) || 1;
                    const rxnDurationInt = parseInt(brand.defaultRxnDuration) || 1;
                    const factor = parseInt(brand.unitFactor) || 1;
                    totalPoints = brandPoints * noOfUnitsInt * rxnDurationInt * factor;
                  }
                } else if (brandCountType === "value") {
                  const allValueFromRequest = req.body.allValue || activityDetails.allValue;
                  if (allValueFromRequest) {
                    const allValueInt = parseInt(allValueFromRequest) || 1;
                    const rxnDurationInt = parseInt(brand.defaultRxnDuration) || 1;
                    const factor = parseInt(brand.valueFactor) || 1;
                    totalPoints = brandPoints * allValueInt * rxnDurationInt * factor;
                  }
                } else {
                  // Fallback: use whichever field is provided
                  const noOfUnitsValue = req.body.noOfUnits || activityDetails.noOfUnits;
                  const allValueFromRequest = req.body.allValue || activityDetails.allValue;
                  if (noOfUnitsValue || allValueFromRequest) {
                    const valueInt = parseInt(noOfUnitsValue || allValueFromRequest) || 1;
                    const rxnDurationInt = parseInt(brand.defaultRxnDuration) || 1;
                    totalPoints = brandPoints * valueInt * rxnDurationInt;
                  }
                }
              } else {
                // If brand is required but no specific calculation fields, use default
                totalPoints = brandPoints;
              }
            }
          }
        }
      }

      // Handle camp-based calculation for new activity types (if campName field exists)
      const hasCampNameField = activitySpecificFields.some(field => field.fieldName === "campName");
      if (hasCampNameField && totalPoints === 0) {
        const targetCampName = campName || activityDetails.campName;
        if (targetCampName) {
          const [campRows] = await connection.execute(
            "SELECT * FROM camps WHERE LOWER(TRIM(campName)) = LOWER(TRIM(?))", 
            [targetCampName.trim()]
          );

          if (campRows.length > 0) {
            camp = campRows[0];
            const campPoints = parseInt(camp.points) || 0;
            const campDefaultFactor = parseInt(camp.defaultFactor) || 1;
            
            // Get noOfCamps from request body or activitySpecificFields
            const noOfCampsValue = req.body.noOfCamps || activityDetails.noOfCamps;
            const noOfCampsInt = parseInt(noOfCampsValue) || 1;
            totalPoints = campPoints * noOfCampsInt * campDefaultFactor;
          }
        }
      }

      // Update activitySpecificDetails with all fields from request body
      activitySpecificFields.forEach((field) => {
        const fieldName = field.fieldName;
        const fieldValue = req.body[fieldName];
        
        // Skip reserved/system fields
        if (['reason', 'attempts', 'reviewDate', 'points', 'diceRollBalance', 'isCalculated', 
             'id', 'type', 'mrId', 'uploadImage', 'dateOfUpload', 'timeOfUpload', 
             'createdAt', 'updatedAt', 'status', 'drName', 'speciality', 'mobNo', 'scCode'].includes(fieldName)) {
          return;
        }

        if (fieldValue !== undefined && fieldValue !== null && fieldValue !== '') {
          // For numeric fields, ensure we store as number
          if (field.type === 'number' || field.type === 'integer') {
            const numValue = Number(fieldValue);
            if (!isNaN(numValue)) {
              newActivitySpecificDetails[fieldName] = numValue;
            }
          } else {
            newActivitySpecificDetails[fieldName] = fieldValue;
          }
        } else if (activityDetails[fieldName] !== undefined) {
          // If not in request body, keep existing value from activityDetails
          newActivitySpecificDetails[fieldName] = activityDetails[fieldName];
        }
      });
    }

    // Handle file upload
    let uploadImagePath = upload.uploadImage;
    if (req.file) {
      try {
        // Use activityType already fetched above
        const folderName = activityType.folderName || normalizedUploadType;
        const typeUploadsDir = path.join(baseUploadsDir, folderName);
        
        // Create directory if it doesn't exist
        if (!fs.existsSync(typeUploadsDir)) {
          fs.mkdirSync(typeUploadsDir, { recursive: true });
        }
        
        const fileExtension = path.extname(req.file.originalname) || ".jpg";
        const fileName = `${mrId}_${Date.now()}${fileExtension}`;
        const filePath = path.join(typeUploadsDir, fileName);

        // Write file to disk
        fs.writeFileSync(filePath, req.file.buffer);
        
        // Store path with type-specific folder (from activityType.folderName)
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
      "reason = NULL",
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

    // Capitalize activity type name for display
    // Special case: "pob" should be displayed as "POB"
    let activityTypeDisplayName = capitalizeWords(activityType.typeName);
    if (activityType.typeName.toLowerCase() === "pob") {
      activityTypeDisplayName = "POB";
    }

    res.status(200).json({
      success: true,
      message: `${activityTypeDisplayName} resubmitted for review`,
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

    // Generate a descriptive filename based on type (dynamic)
    const fileExtension = path.extname(absolutePath) || path.extname(imagePath) || "";
    // Use the actual upload type as the label (already normalized to lowercase)
    const typeLabel = uploadType || "upload";
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
