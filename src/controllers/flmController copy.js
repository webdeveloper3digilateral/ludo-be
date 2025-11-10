import db from "../config/db.js";
import { emitPawnMove, emitBoardUpdate, emitGameEvent } from "../socket/socketHandlers.js";

export const getMyBoard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { boardId } = req.params;

    if (!boardId) {
      return res.status(400).json({
        success: false,
        message: "Board ID is required",
      });
    }

    // Get board details to verify it exists
    const [boardRows] = await connection.execute(
      `SELECT * FROM boards WHERE id = ?`,
      [boardId]
    );

    if (boardRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Board not found",
      });
    }

    // Get all pawns for this board directly from pawns table
    const [pawns] = await connection.execute(
      `SELECT * FROM pawns WHERE boardId = ? ORDER BY playerId, id`,
      [boardId]
    );

    res.status(200).json({
      success: true,
      data: {
        pawns,
      },
    });
  } catch (error) {
    console.error("Error fetching board:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const movePawn = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { pawnId, playerId, boardId, diceNumber } = req.body;

    // ✅ Basic validation
    if (!pawnId || !playerId || !boardId || diceNumber == null) {
      return res.status(400).json({
        success: false,
        message: "pawnId, playerId, boardId, and diceNumber are required",
      });
    }

    // ✅ Validate pawn belongs to this player & board
    const [pawnRows] = await connection.execute(
      `SELECT * FROM pawns 
       WHERE id = ? AND playerId = ? AND boardId = ?`,
      [pawnId, playerId, boardId]
    );

    if (pawnRows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized move or pawn not found",
      });
    }

    const pawn = pawnRows[0];

    // ✅ Handle null/undefined current position as 0
    const currentPos = pawn.current_position ? parseInt(pawn.current_position) : 0;
    const diceVal = parseInt(diceNumber);
    const newPos = currentPos + diceVal;

    // ✅ Prevent overshooting
    if (newPos > 57) {
      return res.status(400).json({
        success: false,
        message: "Invalid move. Pawn cannot go beyond position 57.",
      });
    }

    // ✅ Determine new pawn type
    let newType = "main";
    if (newPos === 0) newType = "base";
    else if (newPos >= 1 && newPos <= 51) newType = "main";
    else if (newPos >= 52 && newPos <= 56) newType = "home";
    else if (newPos === 57) newType = "center";

    // ✅ Safe positions
    const safePositions = [1, 9, 14, 22, 27, 35, 40, 48];
    const isSafe = safePositions.includes(newPos) ? 1 : 0;

    // ✅ Begin transaction
    await connection.beginTransaction();

    // ✅ Update pawn position
    await connection.execute(
      `UPDATE pawns 
       SET current_position = ?, 
           next_position = ?, 
           type = ?, 
           is_safe = ?
       WHERE id = ? AND playerId = ? AND boardId = ?`,
      [newPos, newPos + 1, newType, isSafe, pawnId, playerId, boardId]
    );

    // Track if player completed and became a winner
    let playerCompleted = false;
    let winnerPosition = null;

    // 🏁 Check if pawn reached final (center)
    if (newPos === 57) {
      // ✅ Check if all 4 pawns of this player on this board reached center
      const [playerPawns] = await connection.execute(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN current_position = 57 THEN 1 ELSE 0 END) AS finished
         FROM pawns
         WHERE playerId = ? AND boardId = ?`,
        [playerId, boardId]
      );

      const total = playerPawns[0].total;
      const finished = playerPawns[0].finished;

      if (finished === total && total > 0) {
        playerCompleted = true;
        
        // ✅ Player has completed all pawns → check board winners
        const [boardRows] = await connection.execute(
          `SELECT winner1, winner2, winner3 
           FROM boards WHERE id = ?`,
          [boardId]
        );

        if (boardRows.length > 0) {
          const { winner1, winner2, winner3 } = boardRows[0];

          let winnerField = null;
          if (!winner1) {
            winnerField = "winner1";
            winnerPosition = 1;
          } else if (!winner2) {
            winnerField = "winner2";
            winnerPosition = 2;
          } else if (!winner3) {
            winnerField = "winner3";
            winnerPosition = 3;
          }

          if (winnerField) {
            await connection.execute(
              `UPDATE boards SET ${winnerField} = ? WHERE id = ?`,
              [playerId, boardId]
            );
          }
        }
      }
    }

    await connection.commit();

    // ✅ Fetch updated pawn
    const [updatedPawnRows] = await connection.execute(
      `SELECT * FROM pawns WHERE id = ?`,
      [pawnId]
    );

    const updatedPawn = updatedPawnRows[0];

    // 🔌 Emit socket event for real-time update
    emitPawnMove(boardId, updatedPawn);
    
    // Also emit full board update for consistency
    emitBoardUpdate(boardId);

    // 🏁 Emit game events if player completed
    if (playerCompleted) {
      emitGameEvent(boardId, "player_completed", {
        playerId,
        message: `Player ${playerId} has completed all pawns!`,
      });

      if (winnerPosition) {
        emitGameEvent(boardId, "winner_updated", {
          playerId,
          position: winnerPosition,
          message: `Player ${playerId} is now winner #${winnerPosition}!`,
        });
      }
    }

    res.status(200).json({
      success: true,
      message: "Pawn moved successfully",
      pawn: updatedPawn,
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error moving pawn:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};






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