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

      const boardId = crypto.randomUUID();

      await connection.execute(
        `INSERT INTO boards (id, player1, player2, player3, player4, creator, creationMode, status, numberOfPawnsUnlocked, expirationDate)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
        [boardId, p1, p2, p3, p4, adminId, creationMode, numberOfPawnsUnlocked]
      );

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
    const { brandName, points, defaultRxnDuration, countType, unitFactor, valueFactor, hearts, diceRolls } = req.body;

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
      `INSERT INTO brands (id, brandName, points, defaultRxnDuration, countType, unitFactor, valueFactor, hearts, diceRolls, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        brandId,
        brandName,
        points ? parseInt(points) : null,
        defaultRxnDuration ? parseInt(defaultRxnDuration) : 1,
        normalizedCountType,
        finalUnitFactor,
        finalValueFactor,
        hearts ? parseInt(hearts) : null,
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
        hearts: hearts ? parseInt(hearts) : null,
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
    const { brandName, points, defaultRxnDuration, countType, unitFactor, valueFactor, hearts, diceRolls } = req.body;

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

    if (hearts !== undefined) {
      updates.push("hearts = ?");
      values.push(hearts ? parseInt(hearts) : null);
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

    let query = "SELECT id, brandName, points, defaultRxnDuration, countType, unitFactor, valueFactor, hearts, diceRolls, createdAt, updatedAt FROM brands WHERE 1=1";
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
    const { campName, points, defaultFactor, hearts, diceRolls } = req.body;

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
      `INSERT INTO camps (id, campName, points, defaultFactor, hearts, diceRolls, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        campId,
        campName,
        points ? parseInt(points) : 0,
        defaultFactor ? parseInt(defaultFactor) : 1,
        hearts ? parseInt(hearts) : null,
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
        hearts: hearts ? parseInt(hearts) : null,
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
    const { campName, points, defaultFactor, hearts, diceRolls } = req.body;

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

    if (hearts !== undefined) {
      updates.push("hearts = ?");
      values.push(hearts ? parseInt(hearts) : null);
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

    let query = "SELECT id, campName, points, defaultFactor, hearts, diceRolls, createdAt, updatedAt FROM camps WHERE 1=1";
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
//       `INSERT INTO moveAdjustmentConfigs (medianValue, lessMedianFactor, greaterMedianFactor)
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



export const addMoveAdjustmentConfig = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { medianValue, lessMedianFactor, greaterMedianFactor, pointToDiceRollRatio } = req.body;

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
    if (
      Number.isNaN(median) ||
      Number.isNaN(lessFactor) ||
      Number.isNaN(greaterFactor) ||
      Number.isNaN(pointToDiceRoll)
    ) {
      return res.status(400).json({
        success: false,
        message: "medianValue, lessMedianFactor, greaterMedianFactor, and pointToDiceRollRatio must be valid numbers",
      });
    }

    await connection.beginTransaction();

    await connection.execute(
      `INSERT INTO moveAdjustmentConfigs (medianValue, lessMedianFactor, greaterMedianFactor, pointToDiceRollRatio)
       VALUES (?, ?, ?, ?)`,
      [median, lessFactor, greaterFactor, pointToDiceRoll]
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

// Start game with expiration date
export const startGameWithExpiration = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const { numberOfPawnsUnlocked, creationMode, adminId, expirationDate } = req.body;
    if (!adminId) {
      return res.status(400).json({ message: "Admin ID is required" });
    }

    if (!["system", "manual"].includes(creationMode)) {
      return res.status(400).json({ message: "Invalid creation mode" });
    }

    if (!expirationDate) {
      return res.status(400).json({ message: "Expiration date is required" });
    }

    // Validate expiration date format (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)
    const expirationDateObj = new Date(expirationDate);
    if (isNaN(expirationDateObj.getTime())) {
      return res.status(400).json({ message: "Invalid expiration date format" });
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

    // Format expiration date for SQL (IST)
    const expirationDateIST = formatISTDateTimeForSQL(expirationDateObj);

    // 4️⃣ Insert boards and generate pawns
    for (const group of finalBoards) {
      const [rawP1, rawP2, rawP3, rawP4] = group;
      const p1 = rawP1 ?? null;
      const p2 = rawP2 ?? null;
      const p3 = rawP3 ?? null;
      const p4 = rawP4 ?? null;

      const boardId = crypto.randomUUID();

      await connection.execute(
        `INSERT INTO boards (id, player1, player2, player3, player4, creator, creationMode, status, numberOfPawnsUnlocked, expirationDate)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [boardId, p1, p2, p3, p4, adminId, creationMode, numberOfPawnsUnlocked, expirationDateIST]
      );

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
      message: `${finalBoards.length} boards created successfully with pawns initialized and expiration date set`,
      totalFLMs,
      totalBoards: finalBoards.length,
      expirationDate: expirationDateIST,
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

    // Get pointToDiceRollRatio from moveAdjustmentConfigs
    const [configRows] = await connection.execute(
      `SELECT pointToDiceRollRatio
       FROM moveAdjustmentConfigs
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
    const { playerIds, numberOfPawnsUnlocked, adminId, expirationDate } = req.body;
    
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

    // Format expiration date if provided
    let expirationDateIST = null;
    if (expirationDate) {
      const expirationDateObj = new Date(expirationDate);
      if (isNaN(expirationDateObj.getTime())) {
        await connection.rollback();
        return res.status(400).json({ 
          success: false,
          message: "Invalid expiration date format" 
        });
      }
      expirationDateIST = formatISTDateTimeForSQL(expirationDateObj);
    }

    // Create board
    const boardId = crypto.randomUUID();
    const [p1, p2, p3, p4] = players;
    
    await connection.execute(
      `INSERT INTO boards (id, player1, player2, player3, player4, creator, creationMode, status, numberOfPawnsUnlocked, startTime, expirationDate)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', 'active', ?, ?, ?)`,
      [boardId, p1, p2, p3 || null, p4 || null, adminId, pawnsUnlocked, startTimeIST, expirationDateIST]
    );

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
        expirationDate: expirationDateIST,
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
// };