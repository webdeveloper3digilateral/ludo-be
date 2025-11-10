import crypto from "node:crypto";
import db from "../config/db.js";


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
        `INSERT INTO boards (id, player1, player2, player3, player4, creator, creationMode, status, numberOfPawnsUnlocked)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
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

      // ✅ Find player with blue color and set as currentTurn
      const [bluePlayerRows] = await connection.execute(
        `SELECT DISTINCT playerId FROM pawns 
         WHERE boardId = ? AND color = 'blue' 
         LIMIT 1`,
        [boardId]
      );

      if (bluePlayerRows.length > 0) {
        const bluePlayerId = bluePlayerRows[0].playerId;
        await connection.execute(
          `UPDATE boards SET currentTurn = ? WHERE id = ?`,
          [bluePlayerId, boardId]
        );
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
    const { brandName, points, defaultRxnDuration } = req.body;

    if (!brandName) {
      return res.status(400).json({
        success: false,
        message: "Brand name is required",
      });
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
    await connection.execute(
      `INSERT INTO brands (id, brandName, points, defaultRxnDuration)
       VALUES (?, ?, ?, ?)`,
      [
        brandId,
        brandName,
        points ? parseInt(points) : null,
        defaultRxnDuration ? parseInt(defaultRxnDuration) : 1,
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
    const { brandName, points, defaultRxnDuration } = req.body;

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

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

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

//for points to move conversion
export const applyMedianMoveAdjustment = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { medianValue, lessMedianFactor, greaterMedianFactor } = req.body;

    if (
      medianValue === undefined ||
      lessMedianFactor === undefined ||
      greaterMedianFactor === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "medianValue, lessMedianFactor, and greaterMedianFactor are required",
      });
    }

    const median = Number(medianValue);
    const lessFactor = Number(lessMedianFactor);
    const greaterFactor = Number(greaterMedianFactor);

    if (
      Number.isNaN(median) ||
      Number.isNaN(lessFactor) ||
      Number.isNaN(greaterFactor)
    ) {
      return res.status(400).json({
        success: false,
        message: "medianValue, lessMedianFactor, and greaterMedianFactor must be valid numbers",
      });
    }

    await connection.beginTransaction();

    await connection.execute(
      `INSERT INTO moveAdjustmentConfigs (medianValue, lessMedianFactor, greaterMedianFactor)
       VALUES (?, ?, ?)`,
      [median, lessFactor, greaterFactor]
    );

    const [lessUpdate] = await connection.execute(
      `UPDATE flms f
       LEFT JOIN (
         SELECT flmId, COUNT(*) AS mrCount
         FROM mrs
         WHERE flmId IS NOT NULL
         GROUP BY flmId
       ) m ON f.flmId = m.flmId
       SET f.moves = COALESCE(f.moves, 0) + (COALESCE(f.points, 0) * ?)
       WHERE COALESCE(m.mrCount, 0) < ?`,
      [lessFactor, median]
    );

    const [greaterUpdate] = await connection.execute(
      `UPDATE flms f
       LEFT JOIN (
         SELECT flmId, COUNT(*) AS mrCount
         FROM mrs
         WHERE flmId IS NOT NULL
         GROUP BY flmId
       ) m ON f.flmId = m.flmId
       SET f.moves = COALESCE(f.moves, 0) + (COALESCE(f.points, 0) * ?)
       WHERE COALESCE(m.mrCount, 0) > ?`,
      [greaterFactor, median]
    );

    const [equalUpdate] = await connection.execute(
      `UPDATE flms f
       LEFT JOIN (
         SELECT flmId, COUNT(*) AS mrCount
         FROM mrs
         WHERE flmId IS NOT NULL
         GROUP BY flmId
       ) m ON f.flmId = m.flmId
       SET f.moves = COALESCE(f.moves, 0) + COALESCE(f.points, 0)
       WHERE COALESCE(m.mrCount, 0) = ?`,
      [median]
    );

    await connection.commit();

    res.status(200).json({
      success: true,
      message: "Moves updated successfully based on median factors",
      data: {
        medianValue: median,
        lessMedianFactor: lessFactor,
        greaterMedianFactor: greaterFactor,
        lessAffected: lessUpdate?.affectedRows ?? 0,
        greaterAffected: greaterUpdate?.affectedRows ?? 0,
        equalAffected: equalUpdate?.affectedRows ?? 0,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error applying median move adjustment:", error);
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
// };