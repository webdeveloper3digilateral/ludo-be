import db from "../config/db.js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "../../uploads/prescriptions");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

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
      dateOfUpload,
    } = req.body;

    // Validate required fields
    if (!brandName || !noRxns || !dateOfUpload) {
      return res.status(400).json({
        success: false,
        message: "Please fill all required details: brandName, noRxns, dateOfUpload",
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

    const mr = mrRows[0];

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
    let prescriptionImagePath = null;
    
    
    if (req.file) {
      try {
        const fileExtension = path.extname(req.file.originalname) || ".jpg";
        const fileName = `${mrId}_${Date.now()}${fileExtension}`;
        const filePath = path.join(uploadsDir, fileName);
        
        // Ensure directory exists
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        // Write file to disk
        fs.writeFileSync(filePath, req.file.buffer);
        prescriptionImagePath = `/uploads/prescriptions/${fileName}`;
        
        console.log("File saved successfully:", {
          fileName,
          filePath,
          prescriptionImagePath,
          fileSize: req.file.buffer.length,
        });
      } catch (fileError) {
        console.error("Error saving file:", fileError);
        // Continue without file if there's an error
      }
    } else {
      console.log("No file received in request");
    }

    // Get current time
    const uploadTime = new Date();
    const formattedTime = `${uploadTime.getHours().toString().padStart(2, "0")}:${uploadTime.getMinutes().toString().padStart(2, "0")}`;

    await connection.beginTransaction();

    // Insert prescription with isCalculated = 0 initially
    const prescriptionId = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO prescriptions 
       (id, mrId, brandId, brandName, drName, speciality, mobNo, scCode, noRxns, rxnDuration, prescriptionImage, dateOfUpload, timeOfUpload, points, isCalculated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        prescriptionId,
        mrId,
        brand.id,
        brandName,
        drName || null,
        speciality || null,
        mobNo || null,
        scCode || null,
        noRxnsInt,
        rxnDurationInt,
        prescriptionImagePath,
        dateOfUpload,
        formattedTime,
        totalPoints,
      ]
    );

    // Update FLM's points field by adding the calculated points
    if (mr.flmId) {
      await connection.execute(
        `UPDATE flms 
         SET points = points + ? 
         WHERE flmId = ?`,
        [totalPoints, mr.flmId]
      );

      // Mark prescription as calculated
      await connection.execute(
        `UPDATE prescriptions 
         SET isCalculated = 1 
         WHERE id = ?`,
        [prescriptionId]
      );
    } else {
      // Even if no FLM, mark as calculated (no points to add)
      await connection.execute(
        `UPDATE prescriptions 
         SET isCalculated = 1 
         WHERE id = ?`,
        [prescriptionId]
      );
    }

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
        prescriptionImage: prescriptionImagePath,
        isCalculated: true,
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

    let query = `
      SELECT p.*, b.points as brandPoints
      FROM prescriptions p
      JOIN brands b ON p.brandId = b.id
      WHERE p.mrId = ?
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

    // Get total count
    let countQuery = "SELECT COUNT(*) as total FROM prescriptions WHERE mrId = ?";
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

    res.status(200).json({
      success: true,
      data: {
        prescriptions,
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


export const getBrands = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { search, limit = 100, offset = 0 } = req.query;

    let query = "SELECT id, brandName, points, defaultRxnDuration, createdAt, updatedAt FROM brands WHERE 1=1";
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

