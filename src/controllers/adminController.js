import crypto from "node:crypto";
import db from "../config/db.js";
import { formatISTDateTimeForSQL } from "../utils/istDateTime.js";

//to create the boards for all teh players
export const startGame = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { numberOfPawnsUnlocked, creationMode, adminId } = req.body;
    if (!adminId) {
      return res.status(400).json({ message: "Admin ID is required" });
    }

    if (!["system", "manual"].includes(creationMode)) {
      return res.status(400).json({ message: "Invalid creation mode" });
    }

    // 1️⃣ Fetch all FLMs
    const [flmRows] = await connection.execute("SELECT flmId FROM flms");
    if (flmRows.length === 0) {
      return res.status(400).json({ message: "No FLMs found" });
    }

    const totalFLMs = flmRows.length;
    if (totalFLMs < 2) {
      return res.status(400).json({
        message: "At least two players are required to start a game",
      });
    }

    const flmIds = flmRows.map(row => row.flmId);

    const getPairKey = (a, b) => {
      const [first, second] = [a, b].sort();
      return `${first}|${second}`;
    };

    // 2️⃣ Gather historical pairings to avoid repeating teams
    const [previousBoards] = await connection.execute(
      "SELECT player1, player2, player3, player4 FROM boards"
    );

    const existingPairs = new Set();
    for (const board of previousBoards) {
      const players = [
        board.player1,
        board.player2,
        board.player3,
        board.player4,
      ].filter(Boolean);

      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          existingPairs.add(getPairKey(players[i], players[j]));
        }
      }
    }

    const shuffleArray = array => {
      for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
    };

    const getBoardSizes = count => {
      if (count < 2) return [];

      const boardSizes = [];
      const remainder = count % 4;

      if (remainder === 0) {
        for (let i = 0; i < count / 4; i++) boardSizes.push(4);
      } else if (remainder === 1) {
        if (count === 5) {
          boardSizes.push(3, 2);
        } else {
          const fullBoards = Math.floor((count - 5) / 4);
          for (let i = 0; i < fullBoards; i++) boardSizes.push(4);
          boardSizes.push(3, 2);
        }
      } else {
        const fullBoards = Math.floor(count / 4);
        for (let i = 0; i < fullBoards; i++) boardSizes.push(4);
        if (remainder === 2) boardSizes.push(2);
        if (remainder === 3) boardSizes.push(3);
      }

      const totalPlanned = boardSizes.reduce((sum, size) => sum + size, 0);
      if (totalPlanned !== count) return [];
      return boardSizes;
    };

    const boardSizes = getBoardSizes(totalFLMs);
    if (boardSizes.length === 0) {
      return res.status(400).json({
        message:
          "Unable to determine valid board distribution. Please ensure there are enough players.",
      });
    }

    const maxAttempts = 500;
    let finalBoards = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const shuffled = [...flmIds];
      shuffleArray(shuffled);

      const candidateBoards = [];
      const usedPairs = new Set(existingPairs);
      let valid = true;
      let cursor = 0;

      
      for (const groupSize of boardSizes) {
        const group = shuffled.slice(cursor, cursor + groupSize);
        cursor += groupSize;

        const players = group.filter(Boolean);

        let hasConflict = false;
        for (let x = 0; x < players.length; x++) {
          for (let y = x + 1; y < players.length; y++) {
            const key = getPairKey(players[x], players[y]);
            if (usedPairs.has(key)) {
              hasConflict = true;
              break;
            }
          }
          if (hasConflict) break;
        }

        if (hasConflict) {
          valid = false;
          break;
        }

        for (let x = 0; x < players.length; x++) {
          for (let y = x + 1; y < players.length; y++) {
            usedPairs.add(getPairKey(players[x], players[y]));
          }
        }

        const paddedGroup = [...group];
        while (paddedGroup.length < 4) paddedGroup.push(null);
        candidateBoards.push(paddedGroup);
      }

      if (valid) {
        finalBoards = candidateBoards;
        break;
      }
    }

    if (!finalBoards) {
      return res.status(400).json({
        message:
          "Unable to create new boards without repeating previous player pairings. Please try again later.",
      });
    }

    await connection.beginTransaction();

    const pawnColors = ["blue", "red", "green", "yellow"];
    const colorCellArea = { blue: 1, red: 2, green: 3, yellow: 4 };

    // 4️⃣ Insert boards and generate pawns
    // for (const [p1, p2, p3, p4] of finalBoards) {
    for (const group of finalBoards) {
      const [rawP1, rawP2, rawP3, rawP4] = group;
      const p1 = rawP1 ?? null;
      const p2 = rawP2 ?? null;
      const p3 = rawP3 ?? null;
      const p4 = rawP4 ?? null;

      const [boardResult] = await connection.execute(
        `INSERT INTO boards (player1, player2, player3, player4, creator, creationMode, status, numberOfPawnsUnlocked, endTime)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
        [p1, p2, p3, p4, adminId, creationMode, numberOfPawnsUnlocked]
      );
      const boardId = boardResult.insertId;

      const players = [p1, p2, p3, p4].filter(player => player !== null && player !== undefined);

      for (let index = 0; index < players.length; index++) {
        const playerId = players[index];
        const color = pawnColors[index % pawnColors.length];
        const areaNumber = colorCellArea[color];

        // Default: all pawns are 'base'
        let pawnTypes = new Array(4).fill("base");

        const unlockedCountRaw = Number(numberOfPawnsUnlocked);
        const unlockedCount = Number.isFinite(unlockedCountRaw)
          ? Math.min(Math.max(Math.floor(unlockedCountRaw), 0), 4)
          : 0;

        if (unlockedCount > 0) {
          const unlockedIndexes = [];
          while (unlockedIndexes.length < unlockedCount) {
            const rand = Math.floor(Math.random() * 4);
            if (!unlockedIndexes.includes(rand)) unlockedIndexes.push(rand);
          }
          unlockedIndexes.forEach(i => (pawnTypes[i] = "main"));
        }

        // Insert 4 pawns with proper attributes
        for (let i = 0; i < 4; i++) {
          const type = pawnTypes[i];

          let currentPos = 0;
          let prevPos = -1;

          if (type === "main") {
            currentPos = `cell-area-${areaNumber}-id-14`;
            prevPos = 0; 
          }

          await connection.execute(
            `INSERT INTO pawns (id, boardId, playerId, type, color, currentPosition, prevPosition, isSafe)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), boardId, playerId, type, color, currentPos, prevPos, 1]
          );
        }
      }
    }

    await connection.commit();

    res.status(200).json({
      message: `${finalBoards.length} boards created successfully with pawns initialized`,
      totalFLMs,
      totalBoards: finalBoards.length,
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error starting game:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

export const createBrand = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { brandName, points, defaultRxnDuration, countType, unitFactor, valueFactor, diamonds, diceRolls } = req.body;

    if (!brandName) {
      return res.status(400).json({
        success: false,
        message: "Brand name is required",
      });
    }

    // Validate countType if provided
    if (countType && !["unit", "value"].includes(countType.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "countType must be either 'unit' or 'value'",
      });
    }

    // Validate countType and corresponding factor
    if (countType) {
      const normalizedCountType = countType.toLowerCase();
      if (normalizedCountType === "unit" && !unitFactor) {
        return res.status(400).json({
          success: false,
          message: "unitFactor is required when countType is 'unit'",
        });
      }
      if (normalizedCountType === "value" && !valueFactor) {
        return res.status(400).json({
          success: false,
          message: "valueFactor is required when countType is 'value'",
        });
      }
    }

    // Check if brand already exists
    const [existingRows] = await connection.execute(
      "SELECT * FROM brands WHERE brandName = ?",
      [brandName]
    );

    if (existingRows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Brand with this name already exists",
      });
    }

    await connection.beginTransaction();

    const brandId = crypto.randomUUID();
    const normalizedCountType = countType ? countType.toLowerCase() : null;
    const finalUnitFactor = normalizedCountType === "unit" ? parseInt(unitFactor) : null;
    const finalValueFactor = normalizedCountType === "value" ? parseInt(valueFactor) : null;
    const istDateTimeString = formatISTDateTimeForSQL();

    await connection.execute(
      `INSERT INTO brands (id, brandName, points, defaultRxnDuration, countType, unitFactor, valueFactor, diamonds, diceRolls, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        brandId,
        brandName,
        points ? parseInt(points) : null,
        defaultRxnDuration ? parseInt(defaultRxnDuration) : 1,
        normalizedCountType,
        finalUnitFactor,
        finalValueFactor,
        diamonds ? parseInt(diamonds) : null,
        diceRolls ? parseInt(diceRolls) : null,
        istDateTimeString,
        istDateTimeString,
      ]
    );

    await connection.commit();

    res.status(201).json({
      success: true,
      message: "Brand created successfully",
      data: {
        id: brandId,
        brandName,
        points: points ? parseInt(points) : null,
        defaultRxnDuration: defaultRxnDuration ? parseInt(defaultRxnDuration) : 1,
        countType: normalizedCountType,
        unitFactor: finalUnitFactor,
        valueFactor: finalValueFactor,
        diamonds: diamonds ? parseInt(diamonds) : null,
        diceRolls: diceRolls ? parseInt(diceRolls) : null,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error creating brand:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const updateBrand = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;
    const { brandName, points, defaultRxnDuration, countType, unitFactor, valueFactor, diamonds, diceRolls } = req.body;

    // Check if brand exists
    const [brandRows] = await connection.execute(
      "SELECT * FROM brands WHERE id = ?",
      [id]
    );

    if (brandRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Brand not found",
      });
    }

    // If brandName is being updated, check if new name already exists
    if (brandName && brandName !== brandRows[0].brandName) {
      const [existingRows] = await connection.execute(
        "SELECT * FROM brands WHERE brandName = ? AND id != ?",
        [brandName, id]
      );

      if (existingRows.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Brand with this name already exists",
        });
      }
    }

    // Validate countType if provided
    if (countType !== undefined && countType !== null && !["unit", "value"].includes(countType.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "countType must be either 'unit' or 'value'",
      });
    }

    // Determine the effective countType (use provided or existing)
    const effectiveCountType = countType !== undefined 
      ? (countType ? countType.toLowerCase() : null)
      : brandRows[0].countType;

    // Validate countType and corresponding factor
    if (effectiveCountType) {
      if (effectiveCountType === "unit") {
        // If countType is being set to 'unit', require unitFactor
        if (countType !== undefined && !unitFactor) {
          return res.status(400).json({
            success: false,
            message: "unitFactor is required when countType is 'unit'",
          });
        }
      } else if (effectiveCountType === "value") {
        // If countType is being set to 'value', require valueFactor
        if (countType !== undefined && !valueFactor) {
          return res.status(400).json({
            success: false,
            message: "valueFactor is required when countType is 'value'",
          });
        }
      }
    }

    await connection.beginTransaction();

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (brandName !== undefined) {
      updates.push("brandName = ?");
      values.push(brandName);
    }

    if (points !== undefined) {
      updates.push("points = ?");
      values.push(points ? parseInt(points) : null);
    }

    if (defaultRxnDuration !== undefined) {
      updates.push("defaultRxnDuration = ?");
      values.push(parseInt(defaultRxnDuration) || 1);
    }

    if (countType !== undefined) {
      const normalizedCountType = countType ? countType.toLowerCase() : null;
      updates.push("countType = ?");
      values.push(normalizedCountType);

      // Set factors based on countType
      if (normalizedCountType === "unit") {
        updates.push("unitFactor = ?");
        updates.push("valueFactor = NULL");
        values.push(unitFactor ? parseInt(unitFactor) : null);
      } else if (normalizedCountType === "value") {
        updates.push("unitFactor = NULL");
        updates.push("valueFactor = ?");
        values.push(valueFactor ? parseInt(valueFactor) : null);
      } else {
        // If countType is null, clear both factors
        updates.push("unitFactor = NULL");
        updates.push("valueFactor = NULL");
      }
    } else {
      // If countType is not being updated, but factors are provided, validate against existing countType
      if (unitFactor !== undefined && effectiveCountType === "unit") {
        updates.push("unitFactor = ?");
        values.push(unitFactor ? parseInt(unitFactor) : null);
      }
      if (valueFactor !== undefined && effectiveCountType === "value") {
        updates.push("valueFactor = ?");
        values.push(valueFactor ? parseInt(valueFactor) : null);
      }
    }

    if (diamonds !== undefined) {
      updates.push("diamonds = ?");
      values.push(diamonds ? parseInt(diamonds) : null);
    }

    if (diceRolls !== undefined) {
      updates.push("diceRolls = ?");
      values.push(diceRolls ? parseInt(diceRolls) : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    // Always update updatedAt with IST time
    const istDateTimeString = formatISTDateTimeForSQL();
    updates.push("updatedAt = ?");
    values.push(istDateTimeString);
    values.push(id);

    await connection.execute(
      `UPDATE brands SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    await connection.commit();

    // Fetch updated brand
    const [updatedRows] = await connection.execute(
      "SELECT * FROM brands WHERE id = ?",
      [id]
    );

    res.status(200).json({
      success: true,
      message: "Brand updated successfully",
      data: updatedRows[0],
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error updating brand:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getBrandById = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;

    const [brandRows] = await connection.execute(
      "SELECT * FROM brands WHERE id = ?",
      [id]
    );

    if (brandRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Brand not found",
      });
    }

    res.status(200).json({
      success: true,
      data: brandRows[0],
    });
  } catch (error) {
    console.error("Error fetching brand:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getAllBrands = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { search, limit = 100, offset = 0 } = req.query;

    let query = "SELECT id, brandName, points, defaultRxnDuration, countType, unitFactor, valueFactor, diamonds, diceRolls, createdAt, updatedAt FROM brands WHERE 1=1";
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

// Camp management functions
export const createCamp = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { campName, points, defaultFactor, diamonds, diceRolls } = req.body;

    if (!campName) {
      return res.status(400).json({
        success: false,
        message: "Camp name is required",
      });
    }

    // Check if camp already exists
    const [existingRows] = await connection.execute(
      "SELECT * FROM camps WHERE campName = ?",
      [campName]
    );

    if (existingRows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Camp with this name already exists",
      });
    }

    await connection.beginTransaction();

    const campId = crypto.randomUUID();
    const istDateTimeString = formatISTDateTimeForSQL();

    await connection.execute(
      `INSERT INTO camps (id, campName, points, defaultFactor, diamonds, diceRolls, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campId,
        campName,
        points ? parseInt(points) : 0,
        defaultFactor ? parseInt(defaultFactor) : 1,
        diamonds ? parseInt(diamonds) : null,
        diceRolls ? parseInt(diceRolls) : null,
        istDateTimeString,
        istDateTimeString,
      ]
    );

    await connection.commit();

    res.status(201).json({
      success: true,
      message: "Camp created successfully",
      data: {
        id: campId,
        campName,
        points: points ? parseInt(points) : 0,
        defaultFactor: defaultFactor ? parseInt(defaultFactor) : 1,
        diamonds: diamonds ? parseInt(diamonds) : null,
        diceRolls: diceRolls ? parseInt(diceRolls) : null,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error creating camp:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const updateCamp = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;
    const { campName, points, defaultFactor, diamonds, diceRolls } = req.body;

    // Check if camp exists
    const [campRows] = await connection.execute(
      "SELECT * FROM camps WHERE id = ?",
      [id]
    );

    if (campRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Camp not found",
      });
    }

    // If campName is being updated, check if new name already exists
    if (campName && campName !== campRows[0].campName) {
      const [existingRows] = await connection.execute(
        "SELECT * FROM camps WHERE campName = ? AND id != ?",
        [campName, id]
      );

      if (existingRows.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Camp with this name already exists",
        });
      }
    }

    await connection.beginTransaction();

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (campName !== undefined) {
      updates.push("campName = ?");
      values.push(campName);
    }

    if (points !== undefined) {
      updates.push("points = ?");
      values.push(points ? parseInt(points) : 0);
    }

    if (defaultFactor !== undefined) {
      updates.push("defaultFactor = ?");
      values.push(parseInt(defaultFactor) || 1);
    }

    if (diamonds !== undefined) {
      updates.push("diamonds = ?");
      values.push(diamonds ? parseInt(diamonds) : null);
    }

    if (diceRolls !== undefined) {
      updates.push("diceRolls = ?");
      values.push(diceRolls ? parseInt(diceRolls) : null);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    // Always update updatedAt with IST time
    const istDateTimeString = formatISTDateTimeForSQL();
    updates.push("updatedAt = ?");
    values.push(istDateTimeString);
    values.push(id);

    await connection.execute(
      `UPDATE camps SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    await connection.commit();

    // Fetch updated camp
    const [updatedRows] = await connection.execute(
      "SELECT * FROM camps WHERE id = ?",
      [id]
    );

    res.status(200).json({
      success: true,
      message: "Camp updated successfully",
      data: updatedRows[0],
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error updating camp:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getCampById = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;

    const [campRows] = await connection.execute(
      "SELECT * FROM camps WHERE id = ?",
      [id]
    );

    if (campRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Camp not found",
      });
    }

    res.status(200).json({
      success: true,
      data: campRows[0],
    });
  } catch (error) {
    console.error("Error fetching camp:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getAllCamps = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { search, limit = 100, offset = 0 } = req.query;

    let query = "SELECT id, campName, points, defaultFactor, diamonds, diceRolls, createdAt, updatedAt FROM camps WHERE 1=1";
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

// //for points to move conversion
// export const applyMedianMoveAdjustment = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { medianValue, lessMedianFactor, greaterMedianFactor } = req.body;

//     if (
//       medianValue === undefined ||
//       lessMedianFactor === undefined ||
//       greaterMedianFactor === undefined
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "medianValue, lessMedianFactor, and greaterMedianFactor are required",
//       });
//     }

//     const median = Number(medianValue);
//     const lessFactor = Number(lessMedianFactor);
//     const greaterFactor = Number(greaterMedianFactor);

//     if (
//       Number.isNaN(median) ||
//       Number.isNaN(lessFactor) ||
//       Number.isNaN(greaterFactor)
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "medianValue, lessMedianFactor, and greaterMedianFactor must be valid numbers",
//       });
//     }

//     await connection.beginTransaction();

//     await connection.execute(
//       `INSERT INTO config (medianValue, lessMedianFactor, greaterMedianFactor)
//        VALUES (?, ?, ?)`,
//       [median, lessFactor, greaterFactor]
//     );

//     const [lessUpdate] = await connection.execute(
//       `UPDATE flms f
//        LEFT JOIN (
//          SELECT flmId, COUNT(*) AS mrCount
//          FROM mrs
//          WHERE flmId IS NOT NULL
//          GROUP BY flmId
//        ) m ON f.flmId = m.flmId
//        SET f.moves = COALESCE(f.moves, 0) + (COALESCE(f.points, 0) * ?)
//        WHERE COALESCE(m.mrCount, 0) < ?`,
//       [lessFactor, median]
//     );

//     const [greaterUpdate] = await connection.execute(
//       `UPDATE flms f
//        LEFT JOIN (
//          SELECT flmId, COUNT(*) AS mrCount
//          FROM mrs
//          WHERE flmId IS NOT NULL
//          GROUP BY flmId
//        ) m ON f.flmId = m.flmId
//        SET f.moves = COALESCE(f.moves, 0) + (COALESCE(f.points, 0) * ?)
//        WHERE COALESCE(m.mrCount, 0) > ?`,
//       [greaterFactor, median]
//     );

//     const [equalUpdate] = await connection.execute(
//       `UPDATE flms f
//        LEFT JOIN (
//          SELECT flmId, COUNT(*) AS mrCount
//          FROM mrs
//          WHERE flmId IS NOT NULL
//          GROUP BY flmId
//        ) m ON f.flmId = m.flmId
//        SET f.moves = COALESCE(f.moves, 0) + COALESCE(f.points, 0)
//        WHERE COALESCE(m.mrCount, 0) = ?`,
//       [median]
//     );

//     await connection.commit();

//     res.status(200).json({
//       success: true,
//       message: "Moves updated successfully based on median factors",
//       data: {
//         medianValue: median,
//         lessMedianFactor: lessFactor,
//         greaterMedianFactor: greaterFactor,
//         lessAffected: lessUpdate?.affectedRows ?? 0,
//         greaterAffected: greaterUpdate?.affectedRows ?? 0,
//         equalAffected: equalUpdate?.affectedRows ?? 0,
//       },
//     });
//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error applying median move adjustment:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };



export const config = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { medianValue, lessMedianFactor, greaterMedianFactor, pointToDiceRollRatio, diceRollsToDiamonds, isAutoApprovalAllowed } = req.body;

    if (
      medianValue === undefined ||
      lessMedianFactor === undefined ||
      greaterMedianFactor === undefined ||
      pointToDiceRollRatio === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "medianValue, lessMedianFactor, greaterMedianFactor, and pointToDiceRollRatio are required",
      });
    }

    const median = Number(medianValue);
    const lessFactor = Number(lessMedianFactor);
    const greaterFactor = Number(greaterMedianFactor);
    const pointToDiceRoll = Number(pointToDiceRollRatio);
    const diceRollsToDiamondsValue = diceRollsToDiamonds !== undefined ? Number(diceRollsToDiamonds) : 5;
    const isAutoApprovalAllowedValue = isAutoApprovalAllowed !== undefined ? (isAutoApprovalAllowed ? 1 : 0) : 1;
    
    if (
      Number.isNaN(median) ||
      Number.isNaN(lessFactor) ||
      Number.isNaN(greaterFactor) ||
      Number.isNaN(pointToDiceRoll) ||
      (diceRollsToDiamonds !== undefined && Number.isNaN(diceRollsToDiamondsValue))
    ) {
      return res.status(400).json({
        success: false,
        message: "medianValue, lessMedianFactor, greaterMedianFactor, pointToDiceRollRatio, and diceRollsToDiamonds (if provided) must be valid numbers",
      });
    }

    if (isAutoApprovalAllowed !== undefined && typeof isAutoApprovalAllowed !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: "isAutoApprovalAllowed must be a boolean value",
      });
    }

    await connection.beginTransaction();

    await connection.execute(
      `INSERT INTO config (medianValue, lessMedianFactor, greaterMedianFactor, pointToDiceRollRatio, diceRollsToDiamonds, isAutoApprovalAllowed)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [median, lessFactor, greaterFactor, pointToDiceRoll, diceRollsToDiamondsValue, isAutoApprovalAllowedValue]
    );

    await connection.commit();

    res.status(201).json({
      success: true,
      message: "Move adjustment config added successfully",
      data: {
        medianValue: median,
        lessMedianFactor: lessFactor,
        greaterMedianFactor: greaterFactor,
        pointToDiceRollRatio: pointToDiceRoll,
        diceRollsToDiamonds: diceRollsToDiamondsValue,
        isAutoApprovalAllowed: isAutoApprovalAllowedValue === 1,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error adding move adjustment configs:", error);
    res
      .status(500)
      .json({ success: false, message: "Internal server error", error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

export const updateConfig = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { id } = req.params;
    const { medianValue, lessMedianFactor, greaterMedianFactor, pointToDiceRollRatio, diceRollsToDiamonds, isAutoApprovalAllowed } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Config ID is required",
      });
    }

    // Check if config exists
    const [configRows] = await connection.execute(
      "SELECT * FROM config WHERE id = ?",
      [id]
    );

    if (configRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Config not found",
      });
    }

    await connection.beginTransaction();

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (medianValue !== undefined) {
      const median = Number(medianValue);
      if (Number.isNaN(median)) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "medianValue must be a valid number",
        });
      }
      updates.push("medianValue = ?");
      values.push(median);
    }

    if (lessMedianFactor !== undefined) {
      const lessFactor = Number(lessMedianFactor);
      if (Number.isNaN(lessFactor)) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "lessMedianFactor must be a valid number",
        });
      }
      updates.push("lessMedianFactor = ?");
      values.push(lessFactor);
    }

    if (greaterMedianFactor !== undefined) {
      const greaterFactor = Number(greaterMedianFactor);
      if (Number.isNaN(greaterFactor)) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "greaterMedianFactor must be a valid number",
        });
      }
      updates.push("greaterMedianFactor = ?");
      values.push(greaterFactor);
    }

    if (pointToDiceRollRatio !== undefined) {
      const pointToDiceRoll = Number(pointToDiceRollRatio);
      if (Number.isNaN(pointToDiceRoll)) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "pointToDiceRollRatio must be a valid number",
        });
      }
      updates.push("pointToDiceRollRatio = ?");
      values.push(pointToDiceRoll);
    }

    if (diceRollsToDiamonds !== undefined) {
      const diceRollsToDiamondsValue = Number(diceRollsToDiamonds);
      if (Number.isNaN(diceRollsToDiamondsValue)) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "diceRollsToDiamonds must be a valid number",
        });
      }
      updates.push("diceRollsToDiamonds = ?");
      values.push(diceRollsToDiamondsValue);
    }

    if (isAutoApprovalAllowed !== undefined) {
      if (typeof isAutoApprovalAllowed !== 'boolean') {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "isAutoApprovalAllowed must be a boolean value",
        });
      }
      updates.push("isAutoApprovalAllowed = ?");
      values.push(isAutoApprovalAllowed ? 1 : 0);
    }

    if (updates.length === 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    values.push(id);

    await connection.execute(
      `UPDATE config SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    await connection.commit();

    // Fetch updated config
    const [updatedRows] = await connection.execute(
      "SELECT * FROM config WHERE id = ?",
      [id]
    );

    const updatedConfig = updatedRows[0];
    if (updatedConfig) {
      updatedConfig.isAutoApprovalAllowed = updatedConfig.isAutoApprovalAllowed === 1;
    }

    res.status(200).json({
      success: true,
      message: "Config updated successfully",
      data: updatedConfig,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error updating config:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

// Start game with expiration date
export const startGameWithExpiration = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { numberOfPawnsUnlocked, creationMode, adminId, endTime } = req.body;
    if (!adminId) {
      return res.status(400).json({ message: "Admin ID is required" });
    }

    if (!["system", "manual"].includes(creationMode)) {
      return res.status(400).json({ message: "Invalid creation mode" });
    }

    if (!endTime) {
      return res.status(400).json({ message: "End time is required" });
    }

    // Validate end time format (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)
    const endTimeObj = new Date(endTime);
    if (isNaN(endTimeObj.getTime())) {
      return res.status(400).json({ message: "Invalid end time format" });
    }

    // 1️⃣ Fetch all FLMs
    const [flmRows] = await connection.execute("SELECT flmId FROM flms");
    if (flmRows.length === 0) {
      return res.status(400).json({ message: "No FLMs found" });
    }

    const totalFLMs = flmRows.length;
    if (totalFLMs < 2) {
      return res.status(400).json({
        message: "At least two players are required to start a game",
      });
    }

    const flmIds = flmRows.map(row => row.flmId);

    const getPairKey = (a, b) => {
      const [first, second] = [a, b].sort();
      return `${first}|${second}`;
    };

    // 2️⃣ Gather historical pairings to avoid repeating teams
    const [previousBoards] = await connection.execute(
      "SELECT player1, player2, player3, player4 FROM boards"
    );

    const existingPairs = new Set();
    for (const board of previousBoards) {
      const players = [
        board.player1,
        board.player2,
        board.player3,
        board.player4,
      ].filter(Boolean);

      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          existingPairs.add(getPairKey(players[i], players[j]));
        }
      }
    }

    const shuffleArray = array => {
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
    };

    const getBoardSizes = count => {
      if (count < 2) return [];

      const boardSizes = [];
      const remainder = count % 4;

      if (remainder === 0) {
        for (let i = 0; i < count / 4; i++) boardSizes.push(4);
      } else if (remainder === 1) {
        if (count === 5) {
          boardSizes.push(3, 2);
        } else {
          const fullBoards = Math.floor((count - 5) / 4);
          for (let i = 0; i < fullBoards; i++) boardSizes.push(4);
          boardSizes.push(3, 2);
        }
      } else {
        const fullBoards = Math.floor(count / 4);
        for (let i = 0; i < fullBoards; i++) boardSizes.push(4);
        if (remainder === 2) boardSizes.push(2);
        if (remainder === 3) boardSizes.push(3);
      }

      const totalPlanned = boardSizes.reduce((sum, size) => sum + size, 0);
      if (totalPlanned !== count) return [];
      return boardSizes;
    };

    const boardSizes = getBoardSizes(totalFLMs);
    if (boardSizes.length === 0) {
      return res.status(400).json({
        message:
          "Unable to determine valid board distribution. Please ensure there are enough players.",
      });
    }

    const maxAttempts = 500;
    let finalBoards = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const shuffled = [...flmIds];
      shuffleArray(shuffled);

      const candidateBoards = [];
      const usedPairs = new Set(existingPairs);
      let valid = true;
      let cursor = 0;

      for (const groupSize of boardSizes) {
        const group = shuffled.slice(cursor, cursor + groupSize);
        cursor += groupSize;

        const players = group.filter(Boolean);

        let hasConflict = false;
        for (let x = 0; x < players.length; x++) {
          for (let y = x + 1; y < players.length; y++) {
            const key = getPairKey(players[x], players[y]);
            if (usedPairs.has(key)) {
              hasConflict = true;
              break;
            }
          }
          if (hasConflict) break;
        }

        if (hasConflict) {
          valid = false;
          break;
        }

        for (let x = 0; x < players.length; x++) {
          for (let y = x + 1; y < players.length; y++) {
            usedPairs.add(getPairKey(players[x], players[y]));
          }
        }

        const paddedGroup = [...group];
        while (paddedGroup.length < 4) paddedGroup.push(null);
        candidateBoards.push(paddedGroup);
      }

      if (valid) {
        finalBoards = candidateBoards;
        break;
      }
    }

    if (!finalBoards) {
      return res.status(400).json({
        message:
          "Unable to create new boards without repeating previous player pairings. Please try again later.",
      });
    }

    await connection.beginTransaction();

    const pawnColors = ["blue", "red", "green", "yellow"];
    const colorCellArea = { blue: 1, red: 2, green: 3, yellow: 4 };

    // Format end time for SQL (IST)
    const endTimeIST = formatISTDateTimeForSQL(endTimeObj);

    // 4️⃣ Insert boards and generate pawns
    for (const group of finalBoards) {
      const [rawP1, rawP2, rawP3, rawP4] = group;
      const p1 = rawP1 ?? null;
      const p2 = rawP2 ?? null;
      const p3 = rawP3 ?? null;
      const p4 = rawP4 ?? null;

      const [boardResult] = await connection.execute(
        `INSERT INTO boards (player1, player2, player3, player4, creator, creationMode, status, numberOfPawnsUnlocked, endTime)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [p1, p2, p3, p4, adminId, creationMode, numberOfPawnsUnlocked, endTimeIST]
      );
      const boardId = boardResult.insertId;

      const players = [p1, p2, p3, p4].filter(player => player !== null && player !== undefined);

      for (let index = 0; index < players.length; index++) {
        const playerId = players[index];
        const color = pawnColors[index % pawnColors.length];
        const areaNumber = colorCellArea[color];

        // Default: all pawns are 'base'
        let pawnTypes = new Array(4).fill("base");

        const unlockedCountRaw = Number(numberOfPawnsUnlocked);
        const unlockedCount = Number.isFinite(unlockedCountRaw)
          ? Math.min(Math.max(Math.floor(unlockedCountRaw), 0), 4)
          : 0;

        if (unlockedCount > 0) {
          const unlockedIndexes = [];
          while (unlockedIndexes.length < unlockedCount) {
            const rand = Math.floor(Math.random() * 4);
            if (!unlockedIndexes.includes(rand)) unlockedIndexes.push(rand);
          }
          unlockedIndexes.forEach(i => (pawnTypes[i] = "main"));
        }

        // Insert 4 pawns with proper attributes
        for (let i = 0; i < 4; i++) {
          const type = pawnTypes[i];

          let currentPos = 0;
          let prevPos = -1;

          if (type === "main") {
            currentPos = `cell-area-${areaNumber}-id-14`;
            prevPos = 0;
          }

          await connection.execute(
            `INSERT INTO pawns (id, boardId, playerId, type, color, currentPosition, prevPosition, isSafe)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), boardId, playerId, type, color, currentPos, prevPos, 1]
          );
        }
      }
    }

    await connection.commit();

    res.status(200).json({
      message: `${finalBoards.length} boards created successfully with pawns initialized and end time set`,
      totalFLMs,
      totalBoards: finalBoards.length,
      endTime: endTimeIST,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error starting game with expiration:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  } finally {
    if (connection) connection.release();
  }
};

// Reset all boards - delete moveLogs, pawns, reset board fields, and recreate pawns
export const resetBoards = async (req, res) => {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Fetch all active boards with their configuration
    const [boards] = await connection.execute(
      `SELECT id, player1, player2, player3, player4, numberOfPawnsUnlocked 
       FROM boards
       WHERE status = 'active'`
    );

    const boardIds = boards.map(b => b.id);
    if (boardIds.length === 0) {
      await connection.commit();
      return res.status(200).json({
        success: true,
        message: "No boards to reset",
        data: {
          deletedMoveLogs: 0,
          deletedDiceRolls: 0,
          deletedPawns: 0,
          resetBoards: 0,
          recreatedPawns: 0,
          adjustedPlayers: 0,
        },
      });
    }

    // 2. Calculate net moves and dicerolls used/earned per player for these boards
    // Get all players involved in these boards
    const allPlayerIds = new Set();
    boards.forEach(board => {
      [board.player1, board.player2, board.player3, board.player4]
        .filter(Boolean)
        .forEach(playerId => allPlayerIds.add(playerId));
    });

    // Calculate game stats per player per board:
    // 1. Dice rolls used: count of distinct dice rolls (diceValue IS NOT NULL) - each decrements diceroll balance by 1
    // 2. Moves earned: sum of diceValue (dice value 1-6 = moves earned) - each adds to move balance
    // 3. Moves lost when killed: when gotCaptured=1, all moves earned on that board are deducted and transferred to killer
    const [gameStats] = await connection.execute(
      `SELECT 
        ml.playerId,
        ml.boardId,
        COUNT(DISTINCT CASE WHEN ml.diceValue IS NOT NULL THEN ml.id END) AS diceRollsUsed,
        COALESCE(SUM(CASE WHEN ml.diceValue IS NOT NULL THEN ml.diceValue ELSE 0 END), 0) AS movesEarnedFromDice,
        COALESCE(SUM(CASE WHEN ml.actualMoves > 0 THEN ml.actualMoves ELSE 0 END), 0) AS movesEarnedFromActualMoves,
        COALESCE(SUM(CASE WHEN ml.actualMoves < 0 THEN ABS(ml.actualMoves) ELSE 0 END), 0) AS movesLostFromActualMoves
       FROM moveLogs ml
       WHERE ml.boardId IN (${boardIds.map(() => '?').join(',')})
       GROUP BY ml.playerId, ml.boardId`,
      boardIds
    );

    // Calculate moves lost when pawn was killed (gotCaptured = 1)
    // When a pawn is killed, all moves earned on that board are deducted from killed player
    // and added to the killer. We need to track this per board.
    // Find kills: gotCaptured=1 entries show moves lost by killed player
    // Find killers: hasCaptured=1 entries on same board around same time show moves gained by killer
    const [killStats] = await connection.execute(
      `SELECT 
        killed.playerId AS killedPlayerId,
        killed.boardId,
        ABS(COALESCE(killed.actualMoves, 0)) AS movesLostWhenKilled
       FROM moveLogs killed
       WHERE killed.boardId IN (${boardIds.map(() => '?').join(',')})
         AND killed.gotCaptured = 1
         AND (killed.actualMoves IS NULL OR killed.actualMoves < 0)`,
      boardIds
    );
    
    // Find killers who gained moves from kills
    const [killerStats] = await connection.execute(
      `SELECT 
        killer.playerId AS killerPlayerId,
        killer.boardId,
        COALESCE(killer.actualMoves, 0) AS movesGainedFromKill
       FROM moveLogs killer
       WHERE killer.boardId IN (${boardIds.map(() => '?').join(',')})
         AND killer.hasCaptured = 1
         AND killer.actualMoves > 0`,
      boardIds
    );

    // Aggregate stats per player (across all boards being reset)
    let adjustedPlayers = 0;
    const playerAdjustments = new Map();

    // Process game stats
    gameStats.forEach(stat => {
      if (!playerAdjustments.has(stat.playerId)) {
        playerAdjustments.set(stat.playerId, { moves: 0, diceRolls: 0 });
      }
      const adj = playerAdjustments.get(stat.playerId);
      
      // Dice rolls used: add back to diceroll balance
      adj.diceRolls += stat.diceRollsUsed;
      
      // Moves earned from dice: subtract from move balance (they were added)
      // Use diceValue if available, otherwise use actualMoves
      const movesEarned = stat.movesEarnedFromDice > 0 
        ? stat.movesEarnedFromDice 
        : stat.movesEarnedFromActualMoves;
      adj.moves -= movesEarned;
      
      // Moves lost from actualMoves (negative values): add back (they were deducted)
      adj.moves += stat.movesLostFromActualMoves;
    });

    // Process kill stats - when killed, moves were deducted from killed player
    killStats.forEach(stat => {
      if (!playerAdjustments.has(stat.killedPlayerId)) {
        playerAdjustments.set(stat.killedPlayerId, { moves: 0, diceRolls: 0 });
      }
      const killedAdj = playerAdjustments.get(stat.killedPlayerId);
      // Moves lost when killed: add back (they were deducted)
      killedAdj.moves += stat.movesLostWhenKilled;
    });
    
    // Process killer stats - when killing, moves were added to killer
    killerStats.forEach(stat => {
      if (!playerAdjustments.has(stat.killerPlayerId)) {
        playerAdjustments.set(stat.killerPlayerId, { moves: 0, diceRolls: 0 });
      }
      const killerAdj = playerAdjustments.get(stat.killerPlayerId);
      // Moves gained from kill: subtract (they were added, need to remove)
      killerAdj.moves -= stat.movesGainedFromKill;
    });

    // Update FLM balances
    for (const [playerId, adjustments] of playerAdjustments.entries()) {
      if (adjustments.moves !== 0 || adjustments.diceRolls !== 0) {
        await connection.execute(
          `UPDATE flms 
           SET currentMoveBalance = GREATEST(COALESCE(currentMoveBalance, 0) + ?, 0),
               currentDiceRollBalance = GREATEST(COALESCE(currentDiceRollBalance, 0) + ?, 0),
               updatedAt = ?
           WHERE flmId = ?`,
          [adjustments.moves, adjustments.diceRolls, formatISTDateTimeForSQL(), playerId]
        );
        adjustedPlayers++;
      }
    }

    // 4. Delete moveLogs for these boards only
    const [moveLogsResult] = await connection.execute(
      `DELETE FROM moveLogs WHERE boardId IN (${boardIds.map(() => '?').join(',')})`,
      boardIds
    );
    const deletedMoveLogs = moveLogsResult.affectedRows || 0;

    // 5. Delete diceRolls for these boards only (using currentBoardId)
    const [diceRollsResult] = await connection.execute(
      `DELETE FROM diceRolls WHERE currentBoardId IN (${boardIds.map(() => '?').join(',')})`,
      boardIds
    );
    const deletedDiceRolls = diceRollsResult.affectedRows || 0;

    // 6. Delete all pawns for these boards
    const [pawnsResult] = await connection.execute(
      `DELETE FROM pawns WHERE boardId IN (${boardIds.map(() => '?').join(',')})`,
      boardIds
    );
    const deletedPawns = pawnsResult.affectedRows || 0;

    // 7. Reset all boards: status='active', clear winners/loser, reset timestamps
    const istDateTimeString = formatISTDateTimeForSQL();
    const [boardsResult] = await connection.execute(
      `UPDATE boards 
       SET status = 'active',
           winner1 = NULL,
           winner2 = NULL,
           winner3 = NULL,
           loser = NULL,
           endTime = NULL,
           startTime = ?
       WHERE id IN (${boardIds.map(() => '?').join(',')})`,
      [istDateTimeString, ...boardIds]
    );
    const resetBoards = boardsResult.affectedRows || 0;

    // 8. Recreate pawns for all boards (same logic as startGame)
    const pawnColors = ["blue", "red", "green", "yellow"];
    const colorCellArea = { blue: 1, red: 2, green: 3, yellow: 4 };
    let recreatedPawns = 0;

    for (const board of boards) {
      const players = [board.player1, board.player2, board.player3, board.player4].filter(
        player => player !== null && player !== undefined
      );

      for (let index = 0; index < players.length; index++) {
        const playerId = players[index];
        const color = pawnColors[index % pawnColors.length];
        const areaNumber = colorCellArea[color];

        // Default: all pawns are 'base'
        let pawnTypes = new Array(4).fill("base");

        const unlockedCountRaw = Number(board.numberOfPawnsUnlocked);
        const unlockedCount = Number.isFinite(unlockedCountRaw)
          ? Math.min(Math.max(Math.floor(unlockedCountRaw), 0), 4)
          : 0;

        if (unlockedCount > 0) {
          const unlockedIndexes = [];
          while (unlockedIndexes.length < unlockedCount) {
            const rand = Math.floor(Math.random() * 4);
            if (!unlockedIndexes.includes(rand)) unlockedIndexes.push(rand);
          }
          unlockedIndexes.forEach(i => (pawnTypes[i] = "main"));
        }

        // Insert 4 pawns with proper attributes
        for (let i = 0; i < 4; i++) {
          const type = pawnTypes[i];

          let currentPos = 0;
          let prevPos = -1;

          if (type === "main") {
            currentPos = `cell-area-${areaNumber}-id-14`;
            prevPos = 0;
          }

          await connection.execute(
            `INSERT INTO pawns (id, boardId, playerId, type, color, currentPosition, prevPosition, isSafe)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), board.id, playerId, type, color, currentPos, prevPos, 1]
          );
          recreatedPawns++;
        }
      }
    }

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "All boards reset successfully",
      data: {
        deletedMoveLogs,
        deletedDiceRolls,
        deletedPawns,
        resetBoards,
        recreatedPawns,
        adjustedPlayers,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error resetting boards:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

// Give points to FLM/SLM/TLM by admin (default: FLM)
export const givePoints = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { adminId, userId, userType = "flm", points, reason } = req.body;

    // Validation
    if (!adminId) {
      return res.status(400).json({
        success: false,
        message: "Admin ID is required",
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Recipient ID is required",
      });
    }

    const normalizedUserType = (userType || "flm").toLowerCase();
    if (!["flm", "slm", "tlm"].includes(normalizedUserType)) {
      return res.status(400).json({
        success: false,
        message: "User type must be 'flm', 'slm', or 'tlm' (default: 'flm')",
      });
    }

    if (!points || isNaN(parseInt(points))) {
      return res.status(400).json({
        success: false,
        message: "Points must be a valid number",
      });
    }

    const pointsInt = parseInt(points);
    if (pointsInt <= 0) {
      return res.status(400).json({
        success: false,
        message: "Points must be greater than 0",
      });
    }

    // Verify admin exists
    const [adminRows] = await connection.execute(
      "SELECT adminId FROM admins WHERE adminId = ?",
      [adminId]
    );

    if (adminRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    // Verify recipient exists and get their info
    let recipientTable;
    let userIdField;
    let recipientNameField;
    let recipientName;
    let diceRollBalanceField;

    if (normalizedUserType === "flm") {
      recipientTable = "flms";
      userIdField = "flmId";
      recipientNameField = "flmName";
      diceRollBalanceField = "currentDiceRollBalance";
      const [flmRows] = await connection.execute(
        "SELECT flmId, flmName, points, currentDiceRollBalance FROM flms WHERE flmId = ?",
        [userId]
      );
      if (flmRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "FLM not found",
        });
      }
      recipientName = flmRows[0].flmName;
    } else if (normalizedUserType === "slm") {
      recipientTable = "slms";
      userIdField = "slmId";
      recipientNameField = "slmName";
      diceRollBalanceField = "currentDiceRollBalance";
      const [slmRows] = await connection.execute(
        "SELECT slmId, slmName, points, currentDiceRollBalance FROM slms WHERE slmId = ?",
        [userId]
      );
      if (slmRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "SLM not found",
        });
      }
      recipientName = slmRows[0].slmName;
    } else if (normalizedUserType === "tlm") {
      recipientTable = "tlms";
      userIdField = "tlmId";
      recipientNameField = "tlmName";
      diceRollBalanceField = "currentDiceRollBalance";
      const [tlmRows] = await connection.execute(
        "SELECT tlmId, tlmName, points, currentDiceRollBalance FROM tlms WHERE tlmId = ?",
        [userId]
      );
      if (tlmRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "TLM not found",
        });
      }
      recipientName = tlmRows[0].tlmName;
    }

    // Get pointToDiceRollRatio from config
    const [configRows] = await connection.execute(
      `SELECT pointToDiceRollRatio
       FROM config
       WHERE pointToDiceRollRatio IS NOT NULL
       ORDER BY createdAt DESC
       LIMIT 1`
    );
    const pointToDiceRollRatio = Number(configRows?.[0]?.pointToDiceRollRatio) || 1;
    const diceRollsToAdd = pointsInt * pointToDiceRollRatio;

    await connection.beginTransaction();

    // Get current points and dice roll balance
    const [currentDataRows] = await connection.execute(
      `SELECT points, ${diceRollBalanceField} AS diceRollBalance
       FROM ${recipientTable} WHERE ${userIdField} = ?`,
      [userId]
    );
    const currentPoints = currentDataRows[0].points || 0;
    const currentDiceRollBalance = currentDataRows[0].diceRollBalance || 0;
    const newPoints = currentPoints + pointsInt;
    const newDiceRollBalance = currentDiceRollBalance + diceRollsToAdd;

    // Update recipient's points and dice roll balance
    const istDateTimeString = formatISTDateTimeForSQL();
    await connection.execute(
      `UPDATE ${recipientTable} 
       SET points = ?, ${diceRollBalanceField} = ?, updatedAt = ?
       WHERE ${userIdField} = ?`,
      [newPoints, newDiceRollBalance, istDateTimeString, userId]
    );

    // Record in adminPoints table for the recipient
    const adminPointsId = crypto.randomUUID();
    await connection.execute(
      `INSERT INTO adminPoints (id, adminId, userId, userType, points, reason, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [adminPointsId, adminId, userId, normalizedUserType, pointsInt, reason || null, istDateTimeString, istDateTimeString]
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: `Points given successfully to ${normalizedUserType.toUpperCase()}`,
      data: {
        id: adminPointsId,
        adminId,
        userId,
        recipientName,
        userType: normalizedUserType,
        pointsGiven: pointsInt,
        diceRollsGiven: diceRollsToAdd,
        previousPoints: currentPoints,
        newPoints: newPoints,
        previousDiceRollBalance: currentDiceRollBalance,
        newDiceRollBalance: newDiceRollBalance,
        reason: reason || null,
        createdAt: istDateTimeString,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error giving points:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};


export const startManualGame = async(req,res) => {
  const connection = await db.getConnection();
  try{
    const { playerIds, numberOfPawnsUnlocked, adminId, endTime } = req.body;
    
    // Validate adminId
    if (!adminId) {
      return res.status(400).json({ 
        success: false,
        message: "Admin ID is required" 
      });
    }

    // Validate playerIds - can be array or individual players
    let players = [];
    if (Array.isArray(playerIds)) {
      players = playerIds.filter(p => p != null && p !== '');
    } else if (req.body.player1 || req.body.player2) {
      // Support legacy format with player1, player2, etc.
      players = [
        req.body.player1,
        req.body.player2,
        req.body.player3,
        req.body.player4
      ].filter(p => p != null && p !== '');
    } else {
      return res.status(400).json({ 
        success: false,
        message: "Player IDs are required. Provide playerIds array or player1, player2, etc." 
      });
    }

    // Validate player count (min 2, max 4)
    if (players.length < 2) {
      return res.status(400).json({ 
        success: false,
        message: "Minimum 2 players are required" 
      });
    }
    if (players.length > 4) {
      return res.status(400).json({ 
        success: false,
        message: "Maximum 4 players are allowed" 
      });
    }

    // Validate numberOfPawnsUnlocked (default 1, range 0-4)
    const pawnsUnlocked = numberOfPawnsUnlocked !== undefined 
      ? Number(numberOfPawnsUnlocked) 
      : 1;
    
    if (isNaN(pawnsUnlocked) || pawnsUnlocked < 0 || pawnsUnlocked > 4) {
      return res.status(400).json({ 
        success: false,
        message: "numberOfPawnsUnlocked must be a number between 0 and 4" 
      });
    }

    // Check for duplicate player IDs
    const uniquePlayers = [...new Set(players)];
    if (uniquePlayers.length !== players.length) {
      return res.status(400).json({ 
        success: false,
        message: "Duplicate player IDs are not allowed" 
      });
    }

    await connection.beginTransaction();

    // Check if each player is NOT active in diceRolls table
    // A player is considered active if they have a currentBoardId pointing to a board with status 'active'
    const placeholders = players.map(() => '?').join(',');
    const [activePlayers] = await connection.execute(
      `SELECT dr.playerId, dr.currentBoardId, b.status as boardStatus
       FROM diceRolls dr
       INNER JOIN boards b ON dr.currentBoardId = b.id
       WHERE dr.playerId IN (${placeholders}) 
       AND dr.currentBoardId IS NOT NULL
       AND b.status = 'active'`,
      players
    );

    if (activePlayers.length > 0) {
      await connection.rollback();
      const activePlayerIds = activePlayers.map(p => p.playerId).join(', ');
      return res.status(400).json({ 
        success: false,
        message: `The following players are already active in a game: ${activePlayerIds}` 
      });
    }

    // Verify all players exist in flms table
    const [existingPlayers] = await connection.execute(
      `SELECT flmId FROM flms WHERE flmId IN (${placeholders})`,
      players
    );

    if (existingPlayers.length !== players.length) {
      await connection.rollback();
      const existingPlayerIds = existingPlayers.map(p => p.flmId);
      const missingPlayers = players.filter(p => !existingPlayerIds.includes(p));
      return res.status(400).json({ 
        success: false,
        message: `The following player IDs do not exist: ${missingPlayers.join(', ')}` 
      });
    }

    // Get current IST time for startTime
    const startTimeIST = formatISTDateTimeForSQL();

    // Format end time if provided
    let endTimeIST = null;
    if (endTime) {
      const endTimeObj = new Date(endTime);
      if (isNaN(endTimeObj.getTime())) {
        await connection.rollback();
        return res.status(400).json({ 
          success: false,
          message: "Invalid end time format"
        });
      }
      endTimeIST = formatISTDateTimeForSQL(endTimeObj);
    }

    // Create board
    const [p1, p2, p3, p4] = players;
    
    const [boardResult] = await connection.execute(
      `INSERT INTO boards (player1, player2, player3, player4, creator, creationMode, status, numberOfPawnsUnlocked, startTime, endTime)
       VALUES (?, ?, ?, ?, ?, 'manual', 'active', ?, ?, ?)`,
      [p1, p2, p3 || null, p4 || null, adminId, pawnsUnlocked, startTimeIST, endTimeIST]
    );
    const boardId = boardResult.insertId;

    // Create pawns for all players
    const pawnColors = ["blue", "red", "green", "yellow"];
    const colorCellArea = { blue: 1, red: 2, green: 3, yellow: 4 };

    for (let index = 0; index < players.length; index++) {
      const playerId = players[index];
      const color = pawnColors[index % pawnColors.length];
      const areaNumber = colorCellArea[color];

      // Default: all pawns are 'base'
      let pawnTypes = new Array(4).fill("base");

      // Set unlocked pawns to 'main' type
      if (pawnsUnlocked > 0) {
        const unlockedIndexes = [];
        while (unlockedIndexes.length < pawnsUnlocked) {
          const rand = Math.floor(Math.random() * 4);
          if (!unlockedIndexes.includes(rand)) unlockedIndexes.push(rand);
        }
        unlockedIndexes.forEach(i => (pawnTypes[i] = "main"));
      }

      // Insert 4 pawns with proper attributes
      for (let i = 0; i < 4; i++) {
        const type = pawnTypes[i];

        let currentPos = 0;
        let prevPos = -1;

        if (type === "main") {
          currentPos = `cell-area-${areaNumber}-id-14`;
          prevPos = 0;
        }

        await connection.execute(
          `INSERT INTO pawns (id, boardId, playerId, type, color, currentPosition, prevPosition, isSafe)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [crypto.randomUUID(), boardId, playerId, type, color, currentPos, prevPos, 1]
        );
      }
    }

    // // Set currentTurn to the blue player (first player)
    // const bluePlayerId = players[0];
    // await connection.execute(
    //   `UPDATE boards SET currentTurn = ? WHERE id = ?`,
    //   [bluePlayerId, boardId]
    // );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "Manual game started successfully",
      data: {
        boardId,
        players: players,
        numberOfPawnsUnlocked: pawnsUnlocked,
        creationMode: "manual",
        creator: adminId,
        startTime: startTimeIST,
        endTime: endTimeIST,
        currentTurn: bluePlayerId
      }
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error starting manual game:", error);
    res.status(500).json({ 
      success: false,
      message: "Internal server error", 
      error: error.message 
    });
  } finally {
    if (connection) connection.release();
  }
}

// Upload Types management functions
export const createUploadType = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { typeName, folderName, requiresBrand, requiresCamp, isActive, displayOrder } = req.body;

    if (!typeName) {
      return res.status(400).json({
        success: false,
        message: "Type name is required",
      });
    }

    if (!folderName) {
      return res.status(400).json({
        success: false,
        message: "Folder name is required",
      });
    }

    // Check if upload type already exists (case-insensitive check)
    const [existingRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE LOWER(typeName) = ?",
      [typeName.toLowerCase()]
    );

    if (existingRows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Upload type with this name already exists",
      });
    }

    await connection.beginTransaction();

    const uploadTypeId = crypto.randomUUID();
    const istDateTimeString = formatISTDateTimeForSQL();
    // Preserve capitalization: if all lowercase, capitalize first letter; otherwise keep as is
    const normalizedTypeName = typeName === typeName.toLowerCase()
      ? typeName.charAt(0).toUpperCase() + typeName.slice(1).toLowerCase()
      : typeName;

    await connection.execute(
      `INSERT INTO activityTypes (id, typeName, folderName, requiresBrand, requiresCamp, isActive, displayOrder, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uploadTypeId,
        normalizedTypeName,
        folderName,
        requiresBrand ? 1 : 0,
        requiresCamp ? 1 : 0,
        isActive !== undefined ? (isActive ? 1 : 0) : 1,
        displayOrder ? parseInt(displayOrder) : 0,
        istDateTimeString,
        istDateTimeString,
      ]
    );

    await connection.commit();

    res.status(201).json({
      success: true,
      message: "Upload type created successfully",
      data: {
        id: uploadTypeId,
        typeName: normalizedTypeName,
        folderName,
        requiresBrand: requiresBrand ? true : false,
        requiresCamp: requiresCamp ? true : false,
        isActive: isActive !== undefined ? (isActive ? true : false) : true,
        displayOrder: displayOrder ? parseInt(displayOrder) : 0,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error creating upload type:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const updateUploadType = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;
    const { typeName, folderName, requiresBrand, requiresCamp, isActive, displayOrder } = req.body;

    // Check if upload type exists
    const [uploadTypeRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE id = ?",
      [id]
    );

    if (uploadTypeRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Upload type not found",
      });
    }

    // If typeName is being updated, check if new name already exists
    if (typeName && typeName.toLowerCase() !== uploadTypeRows[0].typeName) {
      const [existingRows] = await connection.execute(
        "SELECT * FROM activityTypes WHERE typeName = ? AND id != ?",
        [typeName.toLowerCase(), id]
      );

      if (existingRows.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Upload type with this name already exists",
        });
      }
    }

    await connection.beginTransaction();

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (typeName !== undefined) {
      updates.push("typeName = ?");
      // Preserve capitalization: if all lowercase, capitalize first letter; otherwise keep as is
      const processedTypeName = typeName === typeName.toLowerCase()
        ? typeName.charAt(0).toUpperCase() + typeName.slice(1).toLowerCase()
        : typeName;
      values.push(processedTypeName);
    }

    if (folderName !== undefined) {
      updates.push("folderName = ?");
      values.push(folderName);
    }

    if (requiresBrand !== undefined) {
      updates.push("requiresBrand = ?");
      values.push(requiresBrand ? 1 : 0);
    }

    if (requiresCamp !== undefined) {
      updates.push("requiresCamp = ?");
      values.push(requiresCamp ? 1 : 0);
    }

    if (isActive !== undefined) {
      updates.push("isActive = ?");
      values.push(isActive ? 1 : 0);
    }

    if (displayOrder !== undefined) {
      updates.push("displayOrder = ?");
      values.push(parseInt(displayOrder) || 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    // Always update updatedAt with IST time
    const istDateTimeString = formatISTDateTimeForSQL();
    updates.push("updatedAt = ?");
    values.push(istDateTimeString);
    values.push(id);

    await connection.execute(
      `UPDATE activityTypes SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    await connection.commit();

    // Fetch updated upload type
    const [updatedRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE id = ?",
      [id]
    );

    res.status(200).json({
      success: true,
      message: "Upload type updated successfully",
      data: updatedRows[0],
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error updating upload type:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getUploadTypeById = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;

    const [uploadTypeRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE id = ?",
      [id]
    );

    if (uploadTypeRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Upload type not found",
      });
    }

    res.status(200).json({
      success: true,
      data: uploadTypeRows[0],
    });
  } catch (error) {
    console.error("Error fetching upload type:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getAllUploadTypes = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { isActive, search } = req.query;

    let query = "SELECT * FROM activityTypes WHERE 1=1";
    const params = [];

    if (isActive !== undefined) {
      query += " AND isActive = ?";
      params.push(isActive === "true" ? 1 : 0);
    }

    if (search) {
      query += " AND (typeName LIKE ? OR folderName LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }

    query += " ORDER BY displayOrder ASC, typeName ASC";

    const [uploadTypes] = await connection.execute(query, params);

    res.status(200).json({
      success: true,
      data: {
        uploadTypes,
        total: uploadTypes.length,
      },
    });
  } catch (error) {
    console.error("Error fetching upload types:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const deleteUploadType = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;

    // Check if upload type exists
    const [uploadTypeRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE id = ?",
      [id]
    );

    if (uploadTypeRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Upload type not found",
      });
    }

    // Check if there are any uploads using this type
    const [uploadRows] = await connection.execute(
      "SELECT COUNT(*) as count FROM uploads WHERE type = ?",
      [uploadTypeRows[0].typeName]
    );

    if (uploadRows[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete upload type. There are ${uploadRows[0].count} upload(s) using this type.`,
      });
    }

    await connection.beginTransaction();

    await connection.execute("DELETE FROM activityTypes WHERE id = ?", [id]);

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "Upload type deleted successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error deleting upload type:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

// Activity Types management functions (new APIs with activitySpecificFields support)
export const createActivityType = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { typeName, folderName, activitySpecificFields, isActive, displayOrder } = req.body;

    if (!typeName) {
      return res.status(400).json({
        success: false,
        message: "Type name is required",
      });
    }

    if (!folderName) {
      return res.status(400).json({
        success: false,
        message: "Folder name is required",
      });
    }

    // Check if activity type already exists (case-insensitive check)
    const [existingRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE LOWER(typeName) = ?",
      [typeName.toLowerCase()]
    );

    if (existingRows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Activity type with this name already exists",
      });
    }

    await connection.beginTransaction();

    const activityTypeId = crypto.randomUUID();
    const istDateTimeString = formatISTDateTimeForSQL();
    // Preserve capitalization: if all lowercase, capitalize first letter; otherwise keep as is
    const normalizedTypeName = typeName === typeName.toLowerCase()
      ? typeName.charAt(0).toUpperCase() + typeName.slice(1).toLowerCase()
      : typeName;

    // Handle activitySpecificFields - convert to JSON string if provided
    // Expected format: [{fieldName: "campname", type: "string", required: true}, ...]
    let activitySpecificFieldsJson = null;
    if (activitySpecificFields !== undefined && activitySpecificFields !== null) {
      let parsedFields = null;
      
      if (typeof activitySpecificFields === 'string') {
        try {
          parsedFields = JSON.parse(activitySpecificFields);
        } catch (e) {
          return res.status(400).json({
            success: false,
            message: "activitySpecificFields must be valid JSON",
          });
        }
      } else {
        parsedFields = activitySpecificFields;
      }

      // Validate structure: should be an array of field definitions
      if (!Array.isArray(parsedFields)) {
        return res.status(400).json({
          success: false,
          message: "activitySpecificFields must be an array of field definitions",
        });
      }

      // Validate each field definition
      for (let i = 0; i < parsedFields.length; i++) {
        const field = parsedFields[i];
        if (!field.fieldName || typeof field.fieldName !== 'string') {
          return res.status(400).json({
            success: false,
            message: `activitySpecificFields[${i}]: fieldName is required and must be a string`,
          });
        }
        if (!field.type || typeof field.type !== 'string') {
          return res.status(400).json({
            success: false,
            message: `activitySpecificFields[${i}]: type is required and must be a string`,
          });
        }
        if (field.required !== undefined && typeof field.required !== 'boolean') {
          return res.status(400).json({
            success: false,
            message: `activitySpecificFields[${i}]: required must be a boolean`,
          });
        }
        
        // Validate pointFactor: optional, but if provided must be a number
        if (field.pointFactor !== undefined && (typeof field.pointFactor !== 'number' || isNaN(field.pointFactor))) {
          return res.status(400).json({
            success: false,
            message: `activitySpecificFields[${i}]: pointFactor must be a number`,
          });
        }
        
        // Validate diamonds: optional, but if provided must be a number
        if (field.diamonds !== undefined && (typeof field.diamonds !== 'number' || isNaN(field.diamonds))) {
          return res.status(400).json({
            success: false,
            message: `activitySpecificFields[${i}]: diamonds must be a number`,
          });
        }
        
        // Validate diamonds: optional, but if provided must be a number
        if (field.diamonds !== undefined && (typeof field.diamonds !== 'number' || isNaN(field.diamonds))) {
          return res.status(400).json({
            success: false,
            message: `activitySpecificFields[${i}]: diamonds must be a number`,
          });
        }
        
        // Validate dropdown fields: must have options array
        if (field.type === 'dropdown') {
          if (!field.options || !Array.isArray(field.options)) {
            return res.status(400).json({
              success: false,
              message: `activitySpecificFields[${i}]: dropdown type requires an options array`,
            });
          }
          if (field.options.length === 0) {
            return res.status(400).json({
              success: false,
              message: `activitySpecificFields[${i}]: dropdown options array cannot be empty`,
            });
          }
          // Validate each option: can be string or object with value/label
          for (let j = 0; j < field.options.length; j++) {
            const option = field.options[j];
            if (typeof option === 'string') {
              // String option is valid
              continue;
            } else if (typeof option === 'object' && option !== null) {
              // Object option must have value or label
              if (!option.value && !option.label) {
                return res.status(400).json({
                  success: false,
                  message: `activitySpecificFields[${i}]: options[${j}] must be a string or object with value/label`,
                });
              }
              // Validate pointFactor: optional, can be null, undefined, or a number
              if (option.pointFactor !== undefined && option.pointFactor !== null) {
                if (typeof option.pointFactor !== 'number' || isNaN(option.pointFactor)) {
                  return res.status(400).json({
                    success: false,
                    message: `activitySpecificFields[${i}]: options[${j}].pointFactor must be a number or null`,
                  });
                }
              }
              // Validate diamonds: optional, can be null, undefined, or a number
              if (option.diamonds !== undefined && option.diamonds !== null) {
                if (typeof option.diamonds !== 'number' || isNaN(option.diamonds)) {
                  return res.status(400).json({
                    success: false,
                    message: `activitySpecificFields[${i}]: options[${j}].diamonds must be a number or null`,
                  });
                }
              }
              // Validate diamonds: optional, can be null, undefined, or a number
              if (option.diamonds !== undefined && option.diamonds !== null) {
                if (typeof option.diamonds !== 'number' || isNaN(option.diamonds)) {
                  return res.status(400).json({
                    success: false,
                    message: `activitySpecificFields[${i}]: options[${j}].diamonds must be a number or null`,
                  });
                }
              }
            } else {
              return res.status(400).json({
                success: false,
                message: `activitySpecificFields[${i}]: options[${j}] must be a string or object`,
              });
            }
          }
        }
      }

      activitySpecificFieldsJson = JSON.stringify(parsedFields);
    }

    await connection.execute(
      `INSERT INTO activityTypes (id, typeName, folderName, activitySpecificFields, isActive, displayOrder, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activityTypeId,
        normalizedTypeName,
        folderName,
       
        activitySpecificFieldsJson,
        isActive !== undefined ? (isActive ? 1 : 0) : 1,
        displayOrder ? parseInt(displayOrder) : 0,
        istDateTimeString,
        istDateTimeString,
      ]
    );

    await connection.commit();

    // Parse activitySpecificFields for response
    let parsedActivitySpecificFields = null;
    if (activitySpecificFieldsJson) {
      try {
        parsedActivitySpecificFields = JSON.parse(activitySpecificFieldsJson);
      } catch (e) {
        parsedActivitySpecificFields = activitySpecificFieldsJson;
      }
    }

    res.status(201).json({
      success: true,
      message: "Activity type created successfully",
      data: {
        id: activityTypeId,
        typeName: normalizedTypeName,
        folderName,
       
        activitySpecificFields: parsedActivitySpecificFields,
        isActive: isActive !== undefined ? (isActive ? true : false) : true,
        displayOrder: displayOrder ? parseInt(displayOrder) : 0,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error creating activity type:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const updateActivityType = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;
    const { typeName, folderName, requiresBrand, requiresCamp, activitySpecificFields, isActive, displayOrder } = req.body;

    // Check if activity type exists
    const [activityTypeRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE id = ?",
      [id]
    );

    if (activityTypeRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Activity type not found",
      });
    }

    // If typeName is being updated, check if new name already exists
    if (typeName && typeName.toLowerCase() !== activityTypeRows[0].typeName.toLowerCase()) {
      const [existingRows] = await connection.execute(
        "SELECT * FROM activityTypes WHERE LOWER(typeName) = ? AND id != ?",
        [typeName.toLowerCase(), id]
      );

      if (existingRows.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Activity type with this name already exists",
        });
      }
    }

    await connection.beginTransaction();

    // Build update query dynamically
    const updates = [];
    const values = [];

    if (typeName !== undefined) {
      updates.push("typeName = ?");
      // Preserve capitalization: if all lowercase, capitalize first letter; otherwise keep as is
      const processedTypeName = typeName === typeName.toLowerCase()
        ? typeName.charAt(0).toUpperCase() + typeName.slice(1).toLowerCase()
        : typeName;
      values.push(processedTypeName);
    }

    if (folderName !== undefined) {
      updates.push("folderName = ?");
      values.push(folderName);
    }

    if (requiresBrand !== undefined) {
      updates.push("requiresBrand = ?");
      values.push(requiresBrand ? 1 : 0);
    }

    if (requiresCamp !== undefined) {
      updates.push("requiresCamp = ?");
      values.push(requiresCamp ? 1 : 0);
    }

    if (activitySpecificFields !== undefined) {
      let activitySpecificFieldsJson = null;
      if (activitySpecificFields !== null) {
        let parsedFields = null;
        
        if (typeof activitySpecificFields === 'string') {
          try {
            parsedFields = JSON.parse(activitySpecificFields);
          } catch (e) {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: "activitySpecificFields must be valid JSON",
            });
          }
        } else {
          parsedFields = activitySpecificFields;
        }

        // Validate structure: should be an array of field definitions
        if (!Array.isArray(parsedFields)) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: "activitySpecificFields must be an array of field definitions",
          });
        }

        // Validate each field definition
        for (let i = 0; i < parsedFields.length; i++) {
          const field = parsedFields[i];
          if (!field.fieldName || typeof field.fieldName !== 'string') {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `activitySpecificFields[${i}]: fieldName is required and must be a string`,
            });
          }
          if (!field.type || typeof field.type !== 'string') {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `activitySpecificFields[${i}]: type is required and must be a string`,
            });
          }
          if (field.required !== undefined && typeof field.required !== 'boolean') {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `activitySpecificFields[${i}]: required must be a boolean`,
            });
          }
          
          // Validate pointFactor: optional, but if provided must be a number
          if (field.pointFactor !== undefined && (typeof field.pointFactor !== 'number' || isNaN(field.pointFactor))) {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `activitySpecificFields[${i}]: pointFactor must be a number`,
            });
          }
          
          // Validate diamonds: optional, but if provided must be a number
          if (field.diamonds !== undefined && (typeof field.diamonds !== 'number' || isNaN(field.diamonds))) {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `activitySpecificFields[${i}]: diamonds must be a number`,
            });
          }
          
          // Validate diamonds: optional, but if provided must be a number
          if (field.diamonds !== undefined && (typeof field.diamonds !== 'number' || isNaN(field.diamonds))) {
            await connection.rollback();
            return res.status(400).json({
              success: false,
              message: `activitySpecificFields[${i}]: diamonds must be a number`,
            });
          }
          
          // Validate dropdown fields: must have options array
          if (field.type === 'dropdown') {
            if (!field.options || !Array.isArray(field.options)) {
              await connection.rollback();
              return res.status(400).json({
                success: false,
                message: `activitySpecificFields[${i}]: dropdown type requires an options array`,
              });
            }
            if (field.options.length === 0) {
              await connection.rollback();
              return res.status(400).json({
                success: false,
                message: `activitySpecificFields[${i}]: dropdown options array cannot be empty`,
              });
            }
            // Validate each option: can be string or object with value/label
            for (let j = 0; j < field.options.length; j++) {
              const option = field.options[j];
              if (typeof option === 'string') {
                // String option is valid
                continue;
              } else if (typeof option === 'object' && option !== null) {
                // Object option must have value or label
                if (!option.value && !option.label) {
                  await connection.rollback();
                  return res.status(400).json({
                    success: false,
                    message: `activitySpecificFields[${i}]: options[${j}] must be a string or object with value/label`,
                  });
                }
                // Validate pointFactor: optional, can be null, undefined, or a number
                if (option.pointFactor !== undefined && option.pointFactor !== null) {
                  if (typeof option.pointFactor !== 'number' || isNaN(option.pointFactor)) {
                    await connection.rollback();
                    return res.status(400).json({
                      success: false,
                      message: `activitySpecificFields[${i}]: options[${j}].pointFactor must be a number or null`,
                    });
                  }
                }
                // Validate diamonds: optional, can be null, undefined, or a number
                if (option.diamonds !== undefined && option.diamonds !== null) {
                  if (typeof option.diamonds !== 'number' || isNaN(option.diamonds)) {
                    await connection.rollback();
                    return res.status(400).json({
                      success: false,
                      message: `activitySpecificFields[${i}]: options[${j}].diamonds must be a number or null`,
                    });
                  }
                }
                // Validate diamonds: optional, can be null, undefined, or a number
                if (option.diamonds !== undefined && option.diamonds !== null) {
                  if (typeof option.diamonds !== 'number' || isNaN(option.diamonds)) {
                    await connection.rollback();
                    return res.status(400).json({
                      success: false,
                      message: `activitySpecificFields[${i}]: options[${j}].diamonds must be a number or null`,
                    });
                  }
                }
              } else {
                await connection.rollback();
                return res.status(400).json({
                  success: false,
                  message: `activitySpecificFields[${i}]: options[${j}] must be a string or object`,
                });
              }
            }
          }
        }

        activitySpecificFieldsJson = JSON.stringify(parsedFields);
      }
      updates.push("activitySpecificFields = ?");
      values.push(activitySpecificFieldsJson);
    }

    if (isActive !== undefined) {
      updates.push("isActive = ?");
      values.push(isActive ? 1 : 0);
    }

    if (displayOrder !== undefined) {
      updates.push("displayOrder = ?");
      values.push(parseInt(displayOrder) || 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    // Always update updatedAt with IST time
    const istDateTimeString = formatISTDateTimeForSQL();
    updates.push("updatedAt = ?");
    values.push(istDateTimeString);
    values.push(id);

    await connection.execute(
      `UPDATE activityTypes SET ${updates.join(", ")} WHERE id = ?`,
      values
    );

    await connection.commit();

    // Fetch updated activity type
    const [updatedRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE id = ?",
      [id]
    );

    // Parse activitySpecificFields for response
    const updatedType = updatedRows[0];
    if (updatedType.activitySpecificFields) {
      try {
        updatedType.activitySpecificFields = JSON.parse(updatedType.activitySpecificFields);
      } catch (e) {
        // Keep as string if parsing fails
      }
    }

    res.status(200).json({
      success: true,
      message: "Activity type updated successfully",
      data: updatedType,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error updating activity type:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getActivityTypeById = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;

    const [activityTypeRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE id = ?",
      [id]
    );

    if (activityTypeRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Activity type not found",
      });
    }

    // Parse activitySpecificFields for response
    const activityType = activityTypeRows[0];
    if (activityType.activitySpecificFields) {
      try {
        activityType.activitySpecificFields = JSON.parse(activityType.activitySpecificFields);
      } catch (e) {
        // Keep as string if parsing fails
      }
    }

    res.status(200).json({
      success: true,
      data: activityType,
    });
  } catch (error) {
    console.error("Error fetching activity type:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getAllActivityTypes = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { isActive, search } = req.query;

    let query = "SELECT * FROM activityTypes WHERE 1=1";
    const params = [];

    if (isActive !== undefined) {
      query += " AND isActive = ?";
      params.push(isActive === "true" ? 1 : 0);
    }

    if (search) {
      query += " AND (typeName LIKE ? OR folderName LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }

    query += " ORDER BY displayOrder ASC, typeName ASC";

    const [activityTypes] = await connection.execute(query, params);

    // Parse activitySpecificFields for each activity type
    activityTypes.forEach(activityType => {
      if (activityType.activitySpecificFields) {
        try {
          activityType.activitySpecificFields = JSON.parse(activityType.activitySpecificFields);
        } catch (e) {
          // Keep as string if parsing fails
        }
      }
    });

    res.status(200).json({
      success: true,
      data: {
        activityTypes,
        total: activityTypes.length,
      },
    });
  } catch (error) {
    console.error("Error fetching activity types:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const deleteActivityType = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { id } = req.params;

    // Check if activity type exists
    const [activityTypeRows] = await connection.execute(
      "SELECT * FROM activityTypes WHERE id = ?",
      [id]
    );

    if (activityTypeRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Activity type not found",
      });
    }

    // Check if there are any uploads using this type
    const [uploadRows] = await connection.execute(
      "SELECT COUNT(*) as count FROM uploads WHERE type = ?",
      [activityTypeRows[0].typeName]
    );

    if (uploadRows[0].count > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete activity type. There are ${uploadRows[0].count} upload(s) using this type.`,
      });
    }

    await connection.beginTransaction();

    await connection.execute("DELETE FROM activityTypes WHERE id = ?", [id]);

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "Activity type deleted successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error deleting activity type:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};





//unlock 1,3,4 pawns
// export const startGame = async (req, res) => {
//   const connection = await db.getConnection();
//   try {
//     const { numberOfPawnsUnlocked, creationMode, adminId } = req.body;
//     if (!adminId) {
//       return res.status(400).json({ message: "Admin ID is required" });
//     }

//     if (!["system", "manual"].includes(creationMode)) {
//       return res.status(400).json({ message: "Invalid creation mode" });
//     }

//     // 1️⃣ Fetch all FLMs
//     const [flmRows] = await connection.execute("SELECT flmId FROM flms");
//     if (flmRows.length === 0) {
//       return res.status(400).json({ message: "No FLMs found" });
//     }

//     const totalFLMs = flmRows.length;
//     const flmIds = flmRows.map(row => row.flmId);

//     // 2️⃣ Shuffle FLMs
//     for (let i = flmIds.length - 1; i > 0; i--) {
//       const j = Math.floor(Math.random() * (i + 1));
//       [flmIds[i], flmIds[j]] = [flmIds[j], flmIds[i]];
//     }

//     // 3️⃣ Group into boards (2–4 players)
//     const boards = [];
//     for (let i = 0; i < flmIds.length; ) {
//       const remaining = flmIds.length - i;
//       let groupSize = remaining >= 4 ? 4 : remaining >= 2 ? remaining : 2;
//       if (remaining === 3) groupSize = 3;

//       const group = flmIds.slice(i, i + groupSize);
//       i += groupSize;

//       while (group.length < 4) group.push(null);
//       boards.push(group);
//     }

//     await connection.beginTransaction();

//     const pawnColors = ["blue", "red", "green", "yellow"];
//     const colorCellArea = { blue: 1, red: 2, green: 3, yellow: 4 };

//     // 4️⃣ Insert boards and generate pawns
//     for (const [p1, p2, p3, p4] of boards) {
//       const boardId = crypto.randomUUID();

//       await connection.execute(
//         `INSERT INTO boards (id, player1, player2, player3, player4, creator, creationMode, status, numberOfPawnsUnlocked)
//          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
//         [boardId, p1, p2, p3, p4, adminId, creationMode, numberOfPawnsUnlocked]
//       );

//       const players = [p1, p2, p3, p4].filter(Boolean);

//       for (let index = 0; index < players.length; index++) {
//         const playerId = players[index];
//         const color = pawnColors[index % pawnColors.length];
//         const areaNumber = colorCellArea[color];

//         // Default: all pawns are 'base'
//         let pawnTypes = new Array(4).fill("base");
//         const unlockedCountRaw = Number(numberOfPawnsUnlocked);
//         const unlockedCount = Number.isFinite(unlockedCountRaw)
//           ? Math.min(Math.max(Math.floor(unlockedCountRaw), 0), 4)
//           : 0;

//         if (unlockedCount > 0) {
//           const unlockedIndexes = [];
//           while (unlockedIndexes.length < unlockedCount) {
//             const rand = Math.floor(Math.random() * 4);
//             if (!unlockedIndexes.includes(rand)) unlockedIndexes.push(rand);
//           }
//           unlockedIndexes.forEach(i => (pawnTypes[i] = "main"));
//         }

//         // Insert 4 pawns with proper attributes
//         for (let i = 0; i < 4; i++) {
//           const type = pawnTypes[i];

//           let currentPos = 0;
//           let prevPos = -1;

//           if (type === "main") {
//             currentPos = `cell-area-${areaNumber}-id-14`;
//             prevPos = 0; 
//           }

//           await connection.execute(
//             `INSERT INTO pawns (id, boardId, playerId, type, color, currentPosition, prevPosition, isSafe)
//              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
//             [crypto.randomUUID(), boardId, playerId, type, color, currentPos, prevPos, 1]
//           );
//         }
//       }

//       // ✅ Find player with blue color and set as currentTurn
//       const [bluePlayerRows] = await connection.execute(
//         `SELECT DISTINCT playerId FROM pawns 
//          WHERE boardId = ? AND color = 'blue' 
//          LIMIT 1`,
//         [boardId]
//       );

//       if (bluePlayerRows.length > 0) {
//         const bluePlayerId = bluePlayerRows[0].playerId;
//         await connection.execute(
//           `UPDATE boards SET currentTurn = ? WHERE id = ?`,
//           [bluePlayerId, boardId]
//         );
//       }
//     }

//     await connection.commit();

//     res.status(200).json({
//       message: `${boards.length} boards created successfully with pawns initialized`,
//       totalFLMs,
//       totalBoards: boards.length,
//     });

//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error starting game:", error);
//     res.status(500).json({ message: "Internal server error", error: error.message });
//   } finally {
//     if (connection) connection.release();
//   }
// };





//didnt unlock 1,3,4 pawns
// export const startGame = async (req, res) => {
//   const connection = await db.getConnection();
//   try {
//     const { numberOfPawnsUnlocked, creationMode, adminId } = req.body;
//     if (!adminId) {
//       return res.status(400).json({ message: "Admin ID is required" });
//     }

//     if (!["system", "manual"].includes(creationMode)) {
//       return res.status(400).json({ message: "Invalid creation mode" });
//     }

//     // 1️⃣ Fetch all FLMs
//     const [flmRows] = await connection.execute("SELECT flmId FROM flms");
//     if (flmRows.length === 0) {
//       return res.status(400).json({ message: "No FLMs found" });
//     }

//     const totalFLMs = flmRows.length;
//     const flmIds = flmRows.map(row => row.flmId);

//     // 2️⃣ Shuffle FLMs
//     for (let i = flmIds.length - 1; i > 0; i--) {
//       const j = Math.floor(Math.random() * (i + 1));
//       [flmIds[i], flmIds[j]] = [flmIds[j], flmIds[i]];
//     }

//     // 3️⃣ Group into boards (2–4 players)
//     const boards = [];
//     for (let i = 0; i < flmIds.length; ) {
//       const remaining = flmIds.length - i;
//       let groupSize = remaining >= 4 ? 4 : remaining >= 2 ? remaining : 2;
//       if (remaining === 3) groupSize = 3;

//       const group = flmIds.slice(i, i + groupSize);
//       i += groupSize;

//       while (group.length < 4) group.push(null);
//       boards.push(group);
//     }

//     await connection.beginTransaction();

//     const pawnColors = ["blue", "red", "green", "yellow"];
//     const colorCellArea = { blue: 1, red: 2, green: 3, yellow: 4 };

//     // 4️⃣ Insert boards and generate pawns
//     for (const [p1, p2, p3, p4] of boards) {
//       const boardId = crypto.randomUUID();

//       await connection.execute(
//         `INSERT INTO boards (id, player1, player2, player3, player4, creator, creationMode, status, numberOfPawnsUnlocked)
//          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
//         [boardId, p1, p2, p3, p4, adminId, creationMode, numberOfPawnsUnlocked]
//       );

//       const players = [p1, p2, p3, p4].filter(Boolean);

//       for (let index = 0; index < players.length; index++) {
//         const playerId = players[index];
//         const color = pawnColors[index % pawnColors.length];
//         const areaNumber = colorCellArea[color];

//         // Default: all pawns are 'base'
//         let pawnTypes = new Array(4).fill("base");

//         // If 2 pawns unlocked → pick 2 random pawns to be 'main'
//         if (Number(numberOfPawnsUnlocked) === 2) {
//           const unlockedIndexes = [];
//           while (unlockedIndexes.length < 2) {
//             const rand = Math.floor(Math.random() * 4);
//             if (!unlockedIndexes.includes(rand)) unlockedIndexes.push(rand);
//           }
//           unlockedIndexes.forEach(i => (pawnTypes[i] = "main"));
//         }

//         // Insert 4 pawns with proper attributes
//         for (let i = 0; i < 4; i++) {
//           const type = pawnTypes[i];

//           let currentPos = 0;
//           let prevPos = -1;

//           if (type === "main") {
//             currentPos = `cell-area-${areaNumber}-id-14`;
//             prevPos = 0; 
//           }

//           await connection.execute(
//             `INSERT INTO pawns (id, boardId, playerId, type, color, currentPosition, prevPosition, isSafe)
//              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
//             [crypto.randomUUID(), boardId, playerId, type, color, currentPos, prevPos, 1]
//           );
//         }
//       }

//       // ✅ Find player with blue color and set as currentTurn
//       const [bluePlayerRows] = await connection.execute(
//         `SELECT DISTINCT playerId FROM pawns 
//          WHERE boardId = ? AND color = 'blue' 
//          LIMIT 1`,
//         [boardId]
//       );

//       if (bluePlayerRows.length > 0) {
//         const bluePlayerId = bluePlayerRows[0].playerId;
//         await connection.execute(
//           `UPDATE boards SET currentTurn = ? WHERE id = ?`,
//           [bluePlayerId, boardId]
//         );
//       }
//     }

//     await connection.commit();

//     res.status(200).json({
//       message: `${boards.length} boards created successfully with pawns initialized`,
//       totalFLMs,
//       totalBoards: boards.length,
//     });

//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error starting game:", error);
//     res.status(500).json({ message: "Internal server error", error: error.message });
//   } finally {
//     if (connection) connection.release();
//   }


// Give dice rolls to all players in a specific role
export const giveDiceRollsToRole = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { adminId, userType, diceRolls, reason } = req.body;

    // Validation
    if (!adminId) {
      return res.status(400).json({
        success: false,
        message: "Admin ID is required",
      });
    }

    const normalizedUserType = (userType || "flm").toLowerCase();
    if (!["flm", "mr", "slm", "tlm"].includes(normalizedUserType)) {
      return res.status(400).json({
        success: false,
        message: "User type must be 'flm', 'mr', 'slm', or 'tlm'",
      });
    }

    if (!diceRolls || isNaN(parseInt(diceRolls))) {
      return res.status(400).json({
        success: false,
        message: "Dice rolls must be a valid number",
      });
    }

    const diceRollsInt = parseInt(diceRolls);
    if (diceRollsInt <= 0) {
      return res.status(400).json({
        success: false,
        message: "Dice rolls must be greater than 0",
      });
    }

    // Verify admin exists
    const [adminRows] = await connection.execute(
      "SELECT adminId FROM admins WHERE adminId = ?",
      [adminId]
    );

    if (adminRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    // Determine table and field names based on user type
    let recipientTable;
    let userIdField;
    let diceRollBalanceField;

    if (normalizedUserType === "flm") {
      recipientTable = "flms";
      userIdField = "flmId";
      diceRollBalanceField = "currentDiceRollBalance";
    } else if (normalizedUserType === "mr") {
      recipientTable = "mrs";
      userIdField = "mrId";
      diceRollBalanceField = "diceRollBalance";
    } else if (normalizedUserType === "slm") {
      recipientTable = "slms";
      userIdField = "slmId";
      diceRollBalanceField = "currentDiceRollBalance";
    } else if (normalizedUserType === "tlm") {
      recipientTable = "tlms";
      userIdField = "tlmId";
      diceRollBalanceField = "currentDiceRollBalance";
    }

    await connection.beginTransaction();

    // Get all active players of the specified role
    const [playerRows] = await connection.execute(
      `SELECT ${userIdField} AS userId FROM ${recipientTable} WHERE status = 'Active'`
    );

    if (playerRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: `No active ${normalizedUserType.toUpperCase()} players found`,
      });
    }

    const istDateTimeString = formatISTDateTimeForSQL();
    const updatedPlayers = [];
    const failedPlayers = [];

    // Update each player's dice roll balance and record in adminDiceRolls table
    for (const player of playerRows) {
      try {
        // Get current dice roll balance for logging/response
        const [currentDataRows] = await connection.execute(
          `SELECT ${diceRollBalanceField} AS diceRollBalance FROM ${recipientTable} WHERE ${userIdField} = ?`,
          [player.userId]
        );

        const currentDiceRollBalance = currentDataRows[0]?.diceRollBalance || 0;
        const newDiceRollBalance = currentDiceRollBalance + diceRollsInt;

        // Update player's dice roll balance atomically (prevents race conditions)
        await connection.execute(
          `UPDATE ${recipientTable} 
           SET ${diceRollBalanceField} = ${diceRollBalanceField} + ?, updatedAt = ?
           WHERE ${userIdField} = ?`,
          [diceRollsInt, istDateTimeString, player.userId]
        );

        // Record in adminDiceRolls table
        const adminDiceRollsId = crypto.randomUUID();
        // await connection.execute(
        //   `INSERT INTO adminDiceRolls (id, adminId, userId, userType, diceRolls, reason, createdAt, updatedAt)
        //    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        //   [adminDiceRollsId, adminId, player.userId, normalizedUserType, diceRollsInt, reason || null, istDateTimeString, istDateTimeString]
        // );
        await connection.execute(
          `INSERT INTO adminDiceRolls (id, adminId, userId, userType, diceRolls, previousBalance, newBalance, reason, mode, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            adminDiceRollsId,
            adminId,
            player.userId,
            normalizedUserType,
            diceRollsInt,
            currentDiceRollBalance,   // <=== ADD
            newDiceRollBalance,       // <=== ADD
            reason || null,
            "role",
            istDateTimeString,
            istDateTimeString
          ]
        );
        

        updatedPlayers.push({
          userId: player.userId,
          previousDiceRollBalance: currentDiceRollBalance,
          newDiceRollBalance: newDiceRollBalance,
        });
      } catch (error) {
        console.error(`Error updating player ${player.userId}:`, error);
        failedPlayers.push({
          userId: player.userId,
          error: error.message,
        });
      }
    }

    await connection.commit();

    res.status(200).json({
      success: true,
      message: `Dice rolls given successfully to ${updatedPlayers.length} ${normalizedUserType.toUpperCase()} players`,
      data: {
        adminId,
        userType: normalizedUserType,
        diceRollsGiven: diceRollsInt,
        totalPlayers: playerRows.length,
        updatedPlayers: updatedPlayers.length,
        failedPlayers: failedPlayers.length,
        players: updatedPlayers,
        failures: failedPlayers.length > 0 ? failedPlayers : undefined,
        reason: reason || null,
        createdAt: istDateTimeString,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error giving dice rolls to role:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};


// Give dice rolls to selected players (same amount or different amounts per player)
export const giveDiceRollsToPlayers = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { adminId, diceRolls, players, reason } = req.body;

    // Validation
    if (!adminId) {
      return res.status(400).json({
        success: false,
        message: "Admin ID is required",
      });
    }

    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Players array is required and must not be empty",
      });
    }

    // Check if global diceRolls is provided
    const hasGlobalDiceRolls = diceRolls !== undefined && diceRolls !== null;
    let globalDiceRollsInt = null;

    if (hasGlobalDiceRolls) {
      // Validate global diceRolls
      if (isNaN(parseInt(diceRolls))) {
        return res.status(400).json({
          success: false,
          message: "diceRolls must be a valid number",
        });
      }

      globalDiceRollsInt = parseInt(diceRolls);
      if (globalDiceRollsInt <= 0) {
        return res.status(400).json({
          success: false,
          message: "diceRolls must be greater than 0",
        });
      }
    }

    // Verify admin exists
    const [adminRows] = await connection.execute(
      "SELECT adminId FROM admins WHERE adminId = ?",
      [adminId]
    );

    if (adminRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    await connection.beginTransaction();

    const istDateTimeString = formatISTDateTimeForSQL();
    const updatedPlayers = [];
    const failedPlayers = [];

    // Process each player
    for (const player of players) {
      try {
        // Validate player object
        if (!player.userId) {
          failedPlayers.push({
            player,
            error: "userId is required",
          });
          continue;
        }

        // Determine dice rolls: use global if provided, otherwise use player-specific
        let diceRollsInt;
        if (hasGlobalDiceRolls) {
          // Use global diceRolls for all players
          diceRollsInt = globalDiceRollsInt;
        } else {
          // Each player must have their own diceRolls
          if (!player.diceRolls || isNaN(parseInt(player.diceRolls))) {
            failedPlayers.push({
              userId: player.userId,
              error: "diceRolls must be a valid number (either provide global diceRolls or diceRolls for each player)",
            });
            continue;
          }

          diceRollsInt = parseInt(player.diceRolls);
          if (diceRollsInt <= 0) {
            failedPlayers.push({
              userId: player.userId,
              error: "diceRolls must be greater than 0",
            });
            continue;
          }
        }

        const normalizedUserType = (player.userType || "flm").toLowerCase();
        if (!["flm", "mr", "slm", "tlm"].includes(normalizedUserType)) {
          failedPlayers.push({
            userId: player.userId,
            error: "userType must be 'flm', 'mr', 'slm', or 'tlm'",
          });
          continue;
        }

        // Determine table and field names based on user type
        let recipientTable;
        let userIdField;
        let diceRollBalanceField;

        if (normalizedUserType === "flm") {
          recipientTable = "flms";
          userIdField = "flmId";
          diceRollBalanceField = "currentDiceRollBalance";
        } else if (normalizedUserType === "mr") {
          recipientTable = "mrs";
          userIdField = "mrId";
          diceRollBalanceField = "diceRollBalance";
        } else if (normalizedUserType === "slm") {
          recipientTable = "slms";
          userIdField = "slmId";
          diceRollBalanceField = "currentDiceRollBalance";
        } else if (normalizedUserType === "tlm") {
          recipientTable = "tlms";
          userIdField = "tlmId";
          diceRollBalanceField = "currentDiceRollBalance";
        }

        // Verify player exists
        const [playerRows] = await connection.execute(
          `SELECT ${userIdField} AS userId, ${diceRollBalanceField} AS diceRollBalance FROM ${recipientTable} WHERE ${userIdField} = ?`,
          [player.userId]
        );

        if (playerRows.length === 0) {
          failedPlayers.push({
            userId: player.userId,
            userType: normalizedUserType,
            error: `${normalizedUserType.toUpperCase()} not found`,
          });
          continue;
        }

        const currentDiceRollBalance = playerRows[0].diceRollBalance || 0;
        const newDiceRollBalance = currentDiceRollBalance + diceRollsInt;

        // Update player's dice roll balance atomically (prevents race conditions)
        await connection.execute(
          `UPDATE ${recipientTable} 
           SET ${diceRollBalanceField} = ${diceRollBalanceField} + ?, updatedAt = ?
           WHERE ${userIdField} = ?`,
          [diceRollsInt, istDateTimeString, player.userId]
        );

        // Record in adminDiceRolls table
        const adminDiceRollsId = crypto.randomUUID();
        // await connection.execute(
        //   `INSERT INTO adminDiceRolls (id, adminId, userId, userType, diceRolls, reason, createdAt, updatedAt)
        //    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        //   [adminDiceRollsId, adminId, player.userId, normalizedUserType, diceRollsInt, reason || null, istDateTimeString, istDateTimeString]
        // );
        await connection.execute(
          `INSERT INTO adminDiceRolls (id, adminId, userId, userType, diceRolls, previousBalance, newBalance, reason, mode, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            adminDiceRollsId,
            adminId,
            player.userId,
            normalizedUserType,
            diceRollsInt,
            currentDiceRollBalance,  // <=== ADD
            newDiceRollBalance,      // <=== ADD
            reason || null,
            "player",
            istDateTimeString,
            istDateTimeString
          ]
        );
        

        updatedPlayers.push({
          userId: player.userId,
          userType: normalizedUserType,
          diceRollsGiven: diceRollsInt,
          previousDiceRollBalance: currentDiceRollBalance,
          newDiceRollBalance: newDiceRollBalance,
        });
      } catch (error) {
        console.error(`Error updating player ${player.userId}:`, error);
        failedPlayers.push({
          userId: player.userId || "unknown",
          error: error.message,
        });
      }
    }

    await connection.commit();

    res.status(200).json({
      success: true,
      message: `Dice rolls given successfully to ${updatedPlayers.length} player(s)`,
      data: {
        adminId,
        totalPlayers: players.length,
        updatedPlayers: updatedPlayers.length,
        failedPlayers: failedPlayers.length,
        players: updatedPlayers,
        failures: failedPlayers.length > 0 ? failedPlayers : undefined,
        reason: reason || null,
        createdAt: istDateTimeString,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error giving dice rolls to players:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

