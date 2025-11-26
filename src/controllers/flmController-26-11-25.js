//before adding the activity type pointfactor and hearts logic
import db from "../config/db.js";
import {
  getISTDateTime,
  formatISTDateTimeForSQL,
  formatISTDateForSQL,
} from "../utils/istDateTime.js";
import { emitBoardUpdate } from "../socket/socketHandlers.js";
import path from "node:path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIN_FILTER_YEAR = 2025;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_SHORT_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const padNumber = value => value.toString().padStart(2, "0");

const parseIsoDate = (value, endOfDay = false) => {
  if (!value || !ISO_DATE_REGEX.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (year < MIN_FILTER_YEAR) return null;
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
};

const formatDateForSql = date =>
  `${date.getUTCFullYear()}-${padNumber(date.getUTCMonth() + 1)}-${padNumber(
    date.getUTCDate()
  )} ${padNumber(date.getUTCHours())}:${padNumber(date.getUTCMinutes())}:${padNumber(
    date.getUTCSeconds()
  )}`;

const formatIsoDateOnly = date =>
  `${date.getUTCFullYear()}-${padNumber(date.getUTCMonth() + 1)}-${padNumber(date.getUTCDate())}`;

const formatWeekLabel = (start, end) =>
  `${padNumber(start.getUTCDate())} ${MONTH_SHORT_NAMES[start.getUTCMonth()]} - ${padNumber(
    end.getUTCDate()
  )} ${MONTH_SHORT_NAMES[end.getUTCMonth()]}`;

const generateWeeksForMonth = (year, monthIndex) => {
  const firstDay = new Date(Date.UTC(year, monthIndex, 1));
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));

  const firstMonday = new Date(firstDay);
  const weekday = firstMonday.getUTCDay(); // 0 (Sun) - 6 (Sat)
  const diff =
    weekday === 1
      ? 0
      : weekday === 0
        ? -6
        : 1 - weekday;
  firstMonday.setUTCDate(firstMonday.getUTCDate() + diff);

  const weeks = [];
  let currentStart = new Date(firstMonday);
  while (currentStart <= lastDay) {
    const currentEnd = new Date(currentStart);
    currentEnd.setUTCDate(currentEnd.getUTCDate() + 6);
    weeks.push({
      label: formatWeekLabel(currentStart, currentEnd),
      startDate: formatIsoDateOnly(currentStart),
      endDate: formatIsoDateOnly(currentEnd),
      isPartialWeek: currentStart < firstDay || currentEnd > lastDay,
    });
    currentStart = new Date(currentStart);
    currentStart.setUTCDate(currentStart.getUTCDate() + 7);
  }

  return weeks;
};

const buildFilterCte = () => `
  WITH latestLogs AS (
    SELECT
      ml.playerId,
      ml.prevMoveBalance,
      ml.moveTime,
      ROW_NUMBER() OVER (PARTITION BY ml.playerId ORDER BY ml.moveTime DESC, ml.id DESC) AS rn
    FROM moveLogs ml
    WHERE ml.moveTime BETWEEN ? AND ?
  ),
  flmMetrics AS (
    SELECT
      f.flmId,
      f.flmName,
      f.slmId,
      COALESCE(ll.prevMoveBalance, 0) AS metricValue
    FROM flms f
    LEFT JOIN latestLogs ll ON ll.playerId = f.flmId AND ll.rn = 1
  )
`;

const buildPointsFilterCte = (brandFilter = null, hasDateFilter = true) => {
  let brandWhereClause = "";
  if (brandFilter && brandFilter.brandId) {
    brandWhereClause = " AND JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandId')) = ?";
  } else if (brandFilter && brandFilter.brandName) {
    brandWhereClause = " AND JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandName')) = ?";
  }
  
  const dateWhereClause = hasDateFilter ? "AND p.reviewDate BETWEEN ? AND ?" : "";
  
  // Always include all upload types (prescription, pob, camp)
  const typeWhereClause = "AND p.type IN ('prescription', 'pob', 'camp')";
  
  return `
  WITH filteredPoints AS (
    SELECT
      m.flmId,
      SUM(p.points) AS totalPoints
    FROM uploads p
    JOIN mrs m ON p.mrId = m.mrId
    WHERE p.status = 'approved'
      AND p.isCalculated = 1
      ${typeWhereClause}
      ${dateWhereClause}
      ${brandWhereClause}
    GROUP BY m.flmId
  ),
  flmPointMetrics AS (
    SELECT
      f.flmId,
      f.flmName,
      f.slmId,
      COALESCE(fp.totalPoints, 0) AS metricValue
    FROM flms f
    LEFT JOIN filteredPoints fp ON fp.flmId = f.flmId
  )
`;
};

const buildKillsFilterCte = () => `
  WITH filteredKills AS (
    SELECT
      ml.playerId,
      SUM(ml.hasCaptured) AS totalKills
    FROM moveLogs ml
    WHERE ml.hasCaptured = 1
      AND ml.moveTime BETWEEN ? AND ?
    GROUP BY ml.playerId
  ),
  flmKillMetrics AS (
    SELECT
      f.flmId,
      f.flmName,
      f.slmId,
      COALESCE(fk.totalKills, 0) AS metricValue
    FROM flms f
    LEFT JOIN filteredKills fk ON fk.playerId = f.flmId
  )
`;

const buildMovesEarnedFilterCte = () => `
  WITH filteredMoves AS (
    SELECT
      ml.playerId,
      SUM(CASE WHEN ml.actualMoves > 0 THEN ml.actualMoves ELSE 0 END) AS totalMovesEarned
    FROM moveLogs ml
    WHERE ml.actualMoves IS NOT NULL
      AND ml.moveTime BETWEEN ? AND ?
    GROUP BY ml.playerId
  ),
  flmMovesEarnedMetrics AS (
    SELECT
      f.flmId,
      f.flmName,
      f.slmId,
      COALESCE(fm.totalMovesEarned, 0) AS metricValue
    FROM flms f
    LEFT JOIN filteredMoves fm ON fm.playerId = f.flmId
  )
`;

const buildMovesLostFilterCte = includeDateFilter => `
  WITH filteredMovesLost AS (
    SELECT
      ml.playerId,
      SUM(
        CASE
          WHEN ml.actualMoves < 0 THEN ABS(ml.actualMoves)
          ELSE 0
        END
      ) AS totalMovesLost
    FROM moveLogs ml
    WHERE ml.actualMoves IS NOT NULL
      AND ml.actualMoves < 0
      ${includeDateFilter ? "AND ml.moveTime BETWEEN ? AND ?" : ""}
    GROUP BY ml.playerId
  ),
  flmMovesLostMetrics AS (
    SELECT
      f.flmId,
      f.flmName,
      f.slmId,
      COALESCE(fml.totalMovesLost, 0) AS metricValue
    FROM flms f
    LEFT JOIN filteredMovesLost fml ON fml.playerId = f.flmId
  )
`;

const buildDiceRollBalanceFilterCte = () => `
  WITH latestLogs AS (
    SELECT
      ml.playerId,
      ml.atDiceRollBalance,
      ml.moveTime,
      ROW_NUMBER() OVER (PARTITION BY ml.playerId ORDER BY ml.moveTime DESC, ml.id DESC) AS rn
    FROM moveLogs ml
    WHERE ml.moveTime BETWEEN ? AND ?
      AND ml.atDiceRollBalance IS NOT NULL
  ),
  flmDiceRollMetrics AS (
    SELECT
      f.flmId,
      f.flmName,
      f.slmId,
      COALESCE(ll.atDiceRollBalance, 0) AS metricValue
    FROM flms f
    LEFT JOIN latestLogs ll ON ll.playerId = f.flmId AND ll.rn = 1
  )
`;

const buildMrDiceRollBalanceFilterCte = () => `
  WITH filteredMrDiceRoll AS (
    SELECT
      m.mrId,
      SUM(p.diceRollBalance) AS totalDiceRollBalance
    FROM uploads p
    JOIN mrs m ON p.mrId = m.mrId
    WHERE p.type = 'prescription'
      AND p.status = 'approved'
      AND p.isCalculated = 1
      AND p.reviewDate BETWEEN ? AND ?
    GROUP BY m.mrId
  ),
  mrDiceRollMetrics AS (
    SELECT
      m.mrId,
      COALESCE(m.mrName, 'Unassigned') AS mrName,
      COALESCE(fmdr.totalDiceRollBalance, 0) AS metricValue
    FROM mrs m
    LEFT JOIN filteredMrDiceRoll fmdr ON fmdr.mrId = m.mrId
  )
`;



//to view the board
export const getMyBoard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required",
      });
    }

    const [boardRows] = await connection.execute(
      `SELECT * FROM boards 
       WHERE status = 'active' 
         AND (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)
       ORDER BY startTime DESC, id DESC
       LIMIT 1`,
      [userId, userId, userId, userId]
    );

    if (boardRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Active board not found for this user",
      });
    }

    const board = boardRows[0];

    const playerIds = [board.player1, board.player2, board.player3, board.player4].filter(
      playerId => playerId && playerId !== ""
    );

    const [pawns] = await connection.execute(
      `SELECT * FROM pawns WHERE boardId = ? ORDER BY playerId, id`,
      [board.id]
    );

    let players = [];

    if (playerIds.length > 0) {
      const placeholders = playerIds.map(() => "?").join(", ");

      const [playerRows] = await connection.execute(
        `SELECT flmId, flmName, currentBalanceMoves, hearts
         FROM flms
         WHERE flmId IN (${placeholders})`,
        playerIds
      );

      const [killRows] = await connection.execute(
        `SELECT playerId, SUM(hasCaptured) AS kills
         FROM moveLogs
         WHERE boardId = ?
           AND hasCaptured = 1
           AND playerId IN (${placeholders})
         GROUP BY playerId`,
        [board.id, ...playerIds]
      );

      const killsByPlayer = new Map();
      killRows.forEach(row => {
        killsByPlayer.set(row.playerId, Number(row.kills) || 0);
      });

      const playerInfoById = new Map();
      playerRows.forEach(row => {
        playerInfoById.set(row.flmId, row);
      });

      const colorByPlayer = new Map();
      pawns.forEach(pawn => {
        if (!colorByPlayer.has(pawn.playerId) && pawn.color) {
          colorByPlayer.set(pawn.playerId, pawn.color);
        }
      });

      players = playerIds.map(playerId => {
        const playerInfo = playerInfoById.get(playerId) || {};
        return {
          playerId,
          playerName: playerInfo.flmName || null,
          kills: killsByPlayer.get(playerId) || 0,
          color: colorByPlayer.get(playerId) || null,
          currentBalanceMoves:
            playerInfo.currentBalanceMoves !== undefined
              ? Number(playerInfo.currentBalanceMoves)
              : null,
          hearts: playerInfo.hearts !== undefined ? Number(playerInfo.hearts) : null,
        };
      });
    }

    let diceValue=[];
      [diceValue] = await connection.execute(
      `SELECT
        p.playerId,
        f.flmName,
        diceValue,
        dr.rolledAt
      FROM (
        -- Unpivot the player columns into rows
        SELECT id as boardId, player1 as playerId FROM boards WHERE id = ?
        UNION ALL
        SELECT id as boardId, player2 as playerId FROM boards WHERE id = ?
        UNION ALL
        SELECT id as boardId, player3 as playerId FROM boards WHERE id = ? AND player3 IS NOT NULL
        UNION ALL
        SELECT id as boardId, player4 as playerId FROM boards WHERE id = ? AND player4 IS NOT NULL
      ) p
      INNER JOIN flms f ON p.playerId = f.flmId
      LEFT JOIN diceRolls dr ON dr.playerId = p.playerId
      ORDER BY dr.rolledAt DESC`,
[board.id, board.id, board.id, board.id]
    )

    // let currentTurn = null;
    // const currentTurnPlayerId = board.currentTurn || null;

    // if (currentTurnPlayerId) {
    //   const currentTurnPawn = pawns.find(pawn => pawn.playerId === currentTurnPlayerId);

    //   currentTurn = {
    //     playerId: currentTurnPlayerId,
    //     color: currentTurnPawn ? currentTurnPawn.color : null,
    //   };
    // }

    res.status(200).json({
      success: true,
      data: {
        boardId: board.id,
        // currentTurn,
         players,
         diceValue,
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

//improv - takes userid as well, and for mr, check if the flm has given access to the board
// export const getMyBoard = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { boardId } = req.params;
//     const { userId } = req.query;

//     if (!boardId) {
//       return res.status(400).json({
//         success: false,
//         message: "Board ID is required",
//       });
//     }

//     if (!userId) {
//       return res.status(400).json({
//         success: false,
//         message: "User ID is required",
//       });
//     }

//     let userRole = null;
//     let mrRecord = null;

//     const [flmRows] = await connection.execute(
//       `SELECT flmId FROM flms WHERE flmId = ? LIMIT 1`,
//       [userId]
//     );

//     if (flmRows.length > 0) {
//       userRole = "FLM";
//     } else {
//       const [mrRows] = await connection.execute(
//         `SELECT mrId, flmId, hasAccess FROM mrs WHERE mrId = ? LIMIT 1`,
//         [userId]
//       );

//       if (mrRows.length > 0) {
//         userRole = "MR";
//         mrRecord = mrRows[0];
//       }
//     }

//     if (!userRole) {
//       return res.status(404).json({
//         success: false,
//         message: "User not found or role not supported for board access",
//       });
//     }

//     let board = null;

//     if (userRole === "FLM") {
//       const [boardRows] = await connection.execute(
//         `SELECT * FROM boards 
//          WHERE id = ? 
//            AND status = 'active'
//            AND (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)
//          LIMIT 1`,
//         [boardId, userId, userId, userId, userId]
//       );

//       if (boardRows.length === 0) {
//         return res.status(404).json({
//           success: false,
//           message: "Active board not found for this FLM",
//         });
//       }

//       board = boardRows[0];
//     } else if (userRole === "MR") {
//       if (!mrRecord.flmId) {
//         return res.status(400).json({
//           success: false,
//           message: "MR is not associated with any FLM",
//         });
//       }

//       const hasAccess =
//         mrRecord.hasAccess === 1 ||
//         mrRecord.hasAccess === true ||
//         mrRecord.hasAccess === "1" ||
//         mrRecord.hasAccess === "true";

//       if (!hasAccess) {
//         return res.status(403).json({
//           success: false,
//           message: "MR does not have access to play",
//         });
//       }

//       const [boardRows] = await connection.execute(
//         `SELECT * FROM boards 
//          WHERE id = ? 
//            AND status = 'active'
//            AND (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)
//          LIMIT 1`,
//         [boardId, mrRecord.flmId, mrRecord.flmId, mrRecord.flmId, mrRecord.flmId]
//       );

//       if (boardRows.length === 0) {
//         return res.status(404).json({
//           success: false,
//           message: "Active board not found for this MR's FLM",
//         });
//       }

//       board = boardRows[0];
//     }

//     const [pawns] = await connection.execute(
//       `SELECT * FROM pawns WHERE boardId = ? ORDER BY playerId, id`,
//       [board.id]
//     );

//     res.status(200).json({
//       success: true,
//       data: {
//         board,
//         pawns,
//       },
//     });
//   } catch (error) {
//     console.error("Error fetching board:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };



//to update the db with every move and also calculate for killings


export const movePawnFromFE = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      pawnId,
      boardId,
      playerId,
      prevPosition,
      currentPosition,
      pawnType,
      isSafe,
      nextPlayerId,
      diceValue,
    } = req.body;

    if (
      !pawnId ||
      !boardId ||
      !playerId ||
      prevPosition === undefined ||
      currentPosition === undefined ||
      !pawnType ||
      isSafe === undefined ||
      !nextPlayerId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "pawnId, boardId, playerId, prevPosition, currentPosition, pawnType, isSafe, and nextPlayerId are required",
      });
    }

    // ✅ Validate pawn type
    const validTypes = ["base", "main", "home", "center"];
    if (!validTypes.includes(pawnType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid pawnType. Must be one of: ${validTypes.join(", ")}`,
      });
    }

    // ✅ Validate position 
    if (currentPosition === null || currentPosition === undefined) {
      return res.status(400).json({
        success: false,
        message: "currentPosition is required",
      });
    }

    // ✅ Validate pawn belongs to this player & board
    const [pawnRows] = await connection.execute(
      `SELECT * FROM pawns WHERE id = ? AND playerId = ? AND boardId = ?`,
      [pawnId, playerId, boardId]
    );

    if (pawnRows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized move or pawn not found",
      });
    }

    // ✅ Verify board exists
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

    const board = boardRows[0];

    // ✅ Verify it's this player's turn
    if (board.currentTurn !== playerId) {
      return res.status(403).json({
        success: false,
        message: "It's not your turn",
      });
    }

    const prevPosString =
      prevPosition !== null && prevPosition !== undefined
        ? prevPosition.toString()
        : "0";
    const nextPosString =
      currentPosition !== null && currentPosition !== undefined
        ? currentPosition.toString()
        : "0";

    // ✅ Begin transaction
    await connection.beginTransaction();

    // Check if currentPosition is already occupied by another pawn
    let killedPawn = null;
    let hasCaptured = 0;
    let updatedBalanceMoves = null;
    
    // Only check for killing if not in base (position 0 or base type)
    const isBasePosition = currentPosition === 0 || currentPosition === "0" || pawnType === "base";
    
    if (!isBasePosition) {
      // Find the pawn at the same position (excluding the moving pawn itself)
      const [opponentPawns] = await connection.execute(
        `SELECT * FROM pawns 
         WHERE boardId = ? 
         AND id != ?
         AND currentPosition = ?
         LIMIT 1`,
        [boardId, pawnId, currentPosition.toString()]
      );

      // Kill the opponent pawn if found (send it back to base)
      if (opponentPawns.length > 0) {
        const opponentPawn = opponentPawns[0];
        const killedPrevPos = opponentPawn.currentPosition;
        
        await connection.execute(
          `UPDATE pawns 
          SET prevPosition = ?,
              currentPosition = 0,
               type = 'base',
              isSafe = 1
           WHERE id = ? AND boardId = ?`,
          [killedPrevPos, opponentPawn.id, boardId]
        );

        killedPawn = {
          pawnId: opponentPawn.id,
          playerId: opponentPawn.playerId,
          previousPosition: killedPrevPos,
        };
        hasCaptured = 1;
      }
    }

    // ✅ Update the moving pawn with data from request body
    
    await connection.execute(
      `UPDATE pawns 
       SET prevPosition = ?,
           currentPosition = ?,
           type = ?,
           isSafe = ?
       WHERE id = ? AND playerId = ? AND boardId = ?`,
      [
        prevPosition,
        currentPosition,
        pawnType,
        isSafe,
        pawnId,
        playerId,
        boardId,
      ]
    );

    // ✅ Update currentTurn in boards table
    await connection.execute(
      `UPDATE boards SET currentTurn = ? WHERE id = ?`,
      [nextPlayerId, boardId]
    );

    // ✅ Log move in moveLogs table
    await connection.execute(
      `INSERT INTO moveLogs (
        boardId,
        playerId,
        pawnId,
        diceValue,
        prevPos,
        nextPos,
        hasCaptured,
        gotCaptured
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        boardId,
        playerId,
        pawnId,
        diceValue ?? null,
        prevPosString,
        nextPosString,
        hasCaptured,
        0,
      ]
    );

    //update the moves and currentBalanceMoves for the flm
    const [flmMoveRows] = await connection.execute(
      `SELECT moves, currentBalanceMoves FROM flms WHERE flmId = ? LIMIT 1`,
      [playerId]
    );

    if (flmMoveRows.length > 0) {
      const { moves: totalMoves, currentBalanceMoves } = flmMoveRows[0];

      if (currentBalanceMoves === null || currentBalanceMoves === undefined) {
        const baseMoves = Number.isFinite(Number(totalMoves)) ? Number(totalMoves) : 0;
        const newMoves = Math.max(baseMoves - 1, 0);

        const updatedAtIST = formatISTDateTimeForSQL();
        await connection.execute(
          `UPDATE flms 
           SET moves = ?, currentBalanceMoves = ?, updatedAt = ?
           WHERE flmId = ?`,
          [newMoves, newMoves, updatedAtIST, playerId]
        );

        updatedBalanceMoves = newMoves;
      } else {
        const balanceValue = Number.isFinite(Number(currentBalanceMoves))
          ? Number(currentBalanceMoves)
          : 0;
        const newBalance = Math.max(balanceValue - 1, 0);

        const updatedAtIST = formatISTDateTimeForSQL();
        await connection.execute(
          `UPDATE flms 
           SET currentBalanceMoves = ?, updatedAt = ?
           WHERE flmId = ?`,
          [newBalance, updatedAtIST, playerId]
        );

        updatedBalanceMoves = newBalance;
      }
    }
//end of update the moves and currentBalanceMoves for the flm
    if (killedPawn) {
      await connection.execute(
        `INSERT INTO moveLogs (
          boardId,
          playerId,
          pawnId,
          diceValue,
          prevPos,
          nextPos,
          hasCaptured,
          gotCaptured
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          boardId,
          killedPawn.playerId,
          killedPawn.pawnId,
          null,
          killedPawn.previousPosition?.toString() ?? "0",
          "0",
          0,
          1,
        ]
      );

      const updatedAtIST = formatISTDateTimeForSQL();
      await connection.execute(
        `UPDATE flms 
         SET kills = COALESCE(kills, 0) + 1, updatedAt = ?
         WHERE flmId = ?`,
        [updatedAtIST, playerId]
      );
    }

    // Track if player completed and became a winner
    let playerCompleted = false;
    let winnerPosition = null;
    let gameFinished = false;
    let loserInfo = null;

    // 🏁 Check if pawn reached final (center)
    if (pawnType === "center") {
      // ✅ Check if all 4 pawns of this player on this board reached center
      const [playerPawns] = await connection.execute(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN type = 'center' THEN 1 ELSE 0 END) AS finished
         FROM pawns
         WHERE playerId = ? AND boardId = ?`,
        [playerId, boardId]
      );

      const total = playerPawns[0].total;
      const finished = playerPawns[0].finished;

      if (finished === total && total > 0) {
        playerCompleted = true;

        // ✅ Player has completed all pawns → check board winners
        const [updatedBoardRows] = await connection.execute(
          `SELECT winner1, winner2, winner3 FROM boards WHERE id = ?`,
          [boardId]
        );

        if (updatedBoardRows.length > 0) {
          const { winner1, winner2, winner3 } = updatedBoardRows[0];

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

            // 🏁 Check if all 3 winners are set → mark remaining player as loser
            if (winnerField === "winner3") {
              // Fetch updated board with all winners and players
              const [finalBoardRows] = await connection.execute(
                `SELECT winner1, winner2, winner3, player1, player2, player3, player4 
                 FROM boards WHERE id = ?`,
                [boardId]
              );

              if (finalBoardRows.length > 0) {
                const finalBoard = finalBoardRows[0];
                const { winner1: w1, winner2: w2, winner3: w3, player1, player2, player3, player4 } = finalBoard;

                // Check if all 3 winners are now set
                if (w1 && w2 && w3) {
                  // Get all players on the board
                  const allPlayers = [player1, player2, player3, player4].filter(Boolean);
                  const winners = [w1, w2, w3];

                  // Find the player who is not a winner (the loser)
                  const loser = allPlayers.find(player => !winners.includes(player));

                  if (loser) {
                    // Update loser and mark game as finished
                    const endTimeIST = formatISTDateTimeForSQL();
                    await connection.execute(
                      `UPDATE boards 
                       SET loser = ?, 
                           status = 'finished',
                           endTime = ?
                       WHERE id = ?`,
                      [loser, endTimeIST, boardId]
                    );

                    gameFinished = true;
                    loserInfo = {
                      loser,
                      winners: {
                        first: w1,
                        second: w2,
                        third: w3,
                      },
                    };
                  }
                }
              }
            }
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

    let killedPawnPayload = null;
    if (killedPawn) {
      const [killedPawnData] = await connection.execute(
        `SELECT * FROM pawns WHERE id = ?`,
        [killedPawn.pawnId]
      );
      if (killedPawnData.length > 0) {
        killedPawnPayload = {
          pawn: killedPawnData[0],
          killedBy: playerId,
        };
      }
    }

    const notifications = [];
    if (playerCompleted) {
      notifications.push({
        type: "player_completed",
        playerId,
        message: `Player ${playerId} has completed all pawns!`,
      });

      if (winnerPosition) {
        notifications.push({
          type: "winner_updated",
          playerId,
          position: winnerPosition,
          message: `Player ${playerId} is now winner #${winnerPosition}!`,
        });
      }
    }

    if (gameFinished && loserInfo) {
      notifications.push({
        type: "game_finished",
        loser: loserInfo.loser,
        winners: loserInfo.winners,
        message: `Game finished! Player ${loserInfo.loser} has lost the game!.`,
      });
    }

    await emitBoardUpdate(boardId, {
      updatedPawn,
      currentBalanceMoves: updatedBalanceMoves,
      killedPawn: killedPawnPayload,
      notifications,
      playerCompleted,
      winnerPosition,
      gameFinished,
      diceValue,
      loser: loserInfo ? loserInfo.loser : null,
      winners: loserInfo ? loserInfo.winners : null,
      nextTurn: nextPlayerId,
    });

    res.status(200).json({
      success: true,
      message: "Pawn moved successfully",
      data: {
        pawn: updatedPawn,
        diceValue,
        killedPawn: killedPawn,
        playerCompleted,
        winnerPosition,
        gameFinished: gameFinished || false,
        loser: loserInfo ? loserInfo.loser : null,
        currentBalanceMoves: updatedBalanceMoves,
      },
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

// //before adding teh moves logic
// export const movePawnFromFE = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const {
//       pawnId,
//       boardId,
//       playerId,
//       prevPosition,
//       currentPosition,
//       pawnType,
//       isSafe,
//       nextPlayerId,
//       diceValue,
//     } = req.body;

//     if (
//       !pawnId ||
//       !boardId ||
//       !playerId ||
//       prevPosition === undefined ||
//       currentPosition === undefined ||
//       !pawnType ||
//       isSafe === undefined ||
//       !nextPlayerId
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           "pawnId, boardId, playerId, prevPosition, currentPosition, pawnType, isSafe, and nextPlayerId are required",
//       });
//     }

//     // ✅ Validate pawn type
//     const validTypes = ["base", "main", "home", "center"];
//     if (!validTypes.includes(pawnType)) {
//       return res.status(400).json({
//         success: false,
//         message: `Invalid pawnType. Must be one of: ${validTypes.join(", ")}`,
//       });
//     }

//     // ✅ Validate position 
//     if (currentPosition === null || currentPosition === undefined) {
//       return res.status(400).json({
//         success: false,
//         message: "currentPosition is required",
//       });
//     }

//     // ✅ Validate pawn belongs to this player & board
//     const [pawnRows] = await connection.execute(
//       `SELECT * FROM pawns WHERE id = ? AND playerId = ? AND boardId = ?`,
//       [pawnId, playerId, boardId]
//     );

//     if (pawnRows.length === 0) {
//       return res.status(403).json({
//         success: false,
//         message: "Unauthorized move or pawn not found",
//       });
//     }

//     // ✅ Verify board exists
//     const [boardRows] = await connection.execute(
//       `SELECT * FROM boards WHERE id = ?`,
//       [boardId]
//     );

//     if (boardRows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: "Board not found",
//       });
//     }

//     const board = boardRows[0];

//     // ✅ Verify it's this player's turn
//     if (board.currentTurn !== playerId) {
//       return res.status(403).json({
//         success: false,
//         message: "It's not your turn",
//       });
//     }

//     const prevPosString =
//       prevPosition !== null && prevPosition !== undefined
//         ? prevPosition.toString()
//         : "0";
//     const nextPosString =
//       currentPosition !== null && currentPosition !== undefined
//         ? currentPosition.toString()
//         : "0";

//     // ✅ Begin transaction
//     await connection.beginTransaction();

//     // Check if currentPosition is already occupied by another pawn
//     let killedPawn = null;
//     let hasCaptured = 0;
    
//     // Only check for killing if not in base (position 0 or base type)
//     const isBasePosition = currentPosition === 0 || currentPosition === "0" || pawnType === "base";
    
//     if (!isBasePosition) {
//       // Find the pawn at the same position (excluding the moving pawn itself)
//       const [opponentPawns] = await connection.execute(
//         `SELECT * FROM pawns 
//          WHERE boardId = ? 
//          AND id != ?
//          AND currentPosition = ?
//          LIMIT 1`,
//         [boardId, pawnId, currentPosition.toString()]
//       );

//       // Kill the opponent pawn if found (send it back to base)
//       if (opponentPawns.length > 0) {
//         const opponentPawn = opponentPawns[0];
//         const killedPrevPos = opponentPawn.currentPosition;
        
//         await connection.execute(
//           `UPDATE pawns 
//           SET prevPosition = ?,
//               currentPosition = 0,
//                type = 'base',
//               isSafe = 1
//            WHERE id = ? AND boardId = ?`,
//           [killedPrevPos, opponentPawn.id, boardId]
//         );

//         killedPawn = {
//           pawnId: opponentPawn.id,
//           playerId: opponentPawn.playerId,
//           previousPosition: killedPrevPos,
//         };
//         hasCaptured = 1;
//       }
//     }

//     // ✅ Update the moving pawn with data from request body
    
//     await connection.execute(
//       `UPDATE pawns 
//        SET prevPosition = ?,
//            currentPosition = ?,
//            type = ?,
//            isSafe = ?
//        WHERE id = ? AND playerId = ? AND boardId = ?`,
//       [
//         prevPosition,
//         currentPosition,
//         pawnType,
//         isSafe,
//         pawnId,
//         playerId,
//         boardId,
//       ]
//     );

//     // ✅ Update currentTurn in boards table
//     await connection.execute(
//       `UPDATE boards SET currentTurn = ? WHERE id = ?`,
//       [nextPlayerId, boardId]
//     );

//     // ✅ Log move in moveLogs table
//     await connection.execute(
//       `INSERT INTO moveLogs (
//         boardId,
//         playerId,
//         pawnId,
//         diceValue,
//         prevPos,
//         nextPos,
//         hasCaptured,
//         gotCaptured
//       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
//       [
//         boardId,
//         playerId,
//         pawnId,
//         diceValue ?? null,
//         prevPosString,
//         nextPosString,
//         hasCaptured,
//         0,
//       ]
//     );

//     if (killedPawn) {
//       await connection.execute(
//         `INSERT INTO moveLogs (
//           boardId,
//           playerId,
//           pawnId,
//           diceValue,
//           prevPos,
//           nextPos,
//           hasCaptured,
//           gotCaptured
//         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
//         [
//           boardId,
//           killedPawn.playerId,
//           killedPawn.pawnId,
//           null,
//           killedPawn.previousPosition?.toString() ?? "0",
//           "0",
//           0,
//           1,
//         ]
//       );

//       await connection.execute(
//         `UPDATE flms 
//          SET kills = COALESCE(kills, 0) + 1 
//          WHERE flmId = ?`,
//         [playerId]
//       );
//     }

//     // Track if player completed and became a winner
//     let playerCompleted = false;
//     let winnerPosition = null;
//     let gameFinished = false;
//     let loserInfo = null;

//     // 🏁 Check if pawn reached final (center)
//     if (pawnType === "center") {
//       // ✅ Check if all 4 pawns of this player on this board reached center
//       const [playerPawns] = await connection.execute(
//         `SELECT COUNT(*) AS total,
//                 SUM(CASE WHEN type = 'center' THEN 1 ELSE 0 END) AS finished
//          FROM pawns
//          WHERE playerId = ? AND boardId = ?`,
//         [playerId, boardId]
//       );

//       const total = playerPawns[0].total;
//       const finished = playerPawns[0].finished;

//       if (finished === total && total > 0) {
//         playerCompleted = true;

//         // ✅ Player has completed all pawns → check board winners
//         const [updatedBoardRows] = await connection.execute(
//           `SELECT winner1, winner2, winner3 FROM boards WHERE id = ?`,
//           [boardId]
//         );

//         if (updatedBoardRows.length > 0) {
//           const { winner1, winner2, winner3 } = updatedBoardRows[0];

//           let winnerField = null;
//           if (!winner1) {
//             winnerField = "winner1";
//             winnerPosition = 1;
//           } else if (!winner2) {
//             winnerField = "winner2";
//             winnerPosition = 2;
//           } else if (!winner3) {
//             winnerField = "winner3";
//             winnerPosition = 3;
//           }

//           if (winnerField) {
//             await connection.execute(
//               `UPDATE boards SET ${winnerField} = ? WHERE id = ?`,
//               [playerId, boardId]
//             );

//             // 🏁 Check if all 3 winners are set → mark remaining player as loser
//             if (winnerField === "winner3") {
//               // Fetch updated board with all winners and players
//               const [finalBoardRows] = await connection.execute(
//                 `SELECT winner1, winner2, winner3, player1, player2, player3, player4 
//                  FROM boards WHERE id = ?`,
//                 [boardId]
//               );

//               if (finalBoardRows.length > 0) {
//                 const finalBoard = finalBoardRows[0];
//                 const { winner1: w1, winner2: w2, winner3: w3, player1, player2, player3, player4 } = finalBoard;

//                 // Check if all 3 winners are now set
//                 if (w1 && w2 && w3) {
//                   // Get all players on the board
//                   const allPlayers = [player1, player2, player3, player4].filter(Boolean);
//                   const winners = [w1, w2, w3];

//                   // Find the player who is not a winner (the loser)
//                   const loser = allPlayers.find(player => !winners.includes(player));

//                   if (loser) {
//                     // Update loser and mark game as finished
//                     await connection.execute(
//                       `UPDATE boards 
//                        SET loser = ?, 
//                            status = 'finished',
//                            endTime = NOW()
//                        WHERE id = ?`,
//                       [loser, boardId]
//                     );

//                     gameFinished = true;
//                     loserInfo = {
//                       loser,
//                       winners: {
//                         first: w1,
//                         second: w2,
//                         third: w3,
//                       },
//                     };
//                   }
//                 }
//               }
//             }
//           }
//         }
//       }
//     }

//     await connection.commit();

//     // ✅ Fetch updated pawn
//     const [updatedPawnRows] = await connection.execute(
//       `SELECT * FROM pawns WHERE id = ?`,
//       [pawnId]
//     );

//     const updatedPawn = updatedPawnRows[0];

//     let killedPawnPayload = null;
//     if (killedPawn) {
//       const [killedPawnData] = await connection.execute(
//         `SELECT * FROM pawns WHERE id = ?`,
//         [killedPawn.pawnId]
//       );
//       if (killedPawnData.length > 0) {
//         killedPawnPayload = {
//           pawn: killedPawnData[0],
//           killedBy: playerId,
//         };
//       }
//     }

//     const notifications = [];
//     if (playerCompleted) {
//       notifications.push({
//         type: "player_completed",
//         playerId,
//         message: `Player ${playerId} has completed all pawns!`,
//       });

//       if (winnerPosition) {
//         notifications.push({
//           type: "winner_updated",
//           playerId,
//           position: winnerPosition,
//           message: `Player ${playerId} is now winner #${winnerPosition}!`,
//         });
//       }
//     }

//     if (gameFinished && loserInfo) {
//       notifications.push({
//         type: "game_finished",
//         loser: loserInfo.loser,
//         winners: loserInfo.winners,
//         message: `Game finished! Player ${loserInfo.loser} has lost the game!.`,
//       });
//     }

//     await emitBoardUpdate(boardId, {
//       updatedPawn,
//       killedPawn: killedPawnPayload,
//       notifications,
//       playerCompleted,
//       winnerPosition,
//       gameFinished,
//       diceValue,
//       loser: loserInfo ? loserInfo.loser : null,
//       winners: loserInfo ? loserInfo.winners : null,
//       nextTurn: nextPlayerId,
//     });

//     res.status(200).json({
//       success: true,
//       message: "Pawn moved successfully",
//       data: {
//         pawn: updatedPawn,
//       diceValue,
//         killedPawn: killedPawn,
//         playerCompleted,
//         winnerPosition,
//         gameFinished: gameFinished || false,
//         loser: loserInfo ? loserInfo.loser : null,
//       },
//     });
//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error moving pawn:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };














//socket based moves
export const movePawnFromSocket = async (socket, data) => {
  const connection = await db.getConnection();

  try {
    const {
      pawnId,
      boardId,
      playerId,
      prevPosition,
      currentPosition,
      pawnType,
      isSafe,
      nextPlayerId,
      diceValue,
    } = data;

    // ✅ Validate required fields
    if (
      !pawnId ||
      !boardId ||
      !playerId ||
      prevPosition === undefined ||
      currentPosition === undefined ||
      !pawnType ||
      isSafe === undefined ||
      !nextPlayerId
    ) {
      return socket.emit("error_message", {
        success: false,
        message:
          "pawnId, boardId, playerId, prevPosition, currentPosition, pawnType, isSafe, and nextPlayerId are required",
      });
    }

    const validTypes = ["base", "main", "home", "center"];
    if (!validTypes.includes(pawnType)) {
      return socket.emit("error_message", {
        success: false,
        message: `Invalid pawnType. Must be one of: ${validTypes.join(", ")}`,
      });
    }

    // ✅ Validate pawn belongs to this player & board
    const [pawnRows] = await connection.execute(
      `SELECT * FROM pawns WHERE id = ? AND playerId = ? AND boardId = ?`,
      [pawnId, playerId, boardId]
    );

    if (pawnRows.length === 0) {
      return socket.emit("error_message", {
        success: false,
        message: "Unauthorized move or pawn not found",
      });
    }

    // ✅ Verify board and turn
    const [boardRows] = await connection.execute(
      `SELECT * FROM boards WHERE id = ?`,
      [boardId]
    );

    if (boardRows.length === 0) {
      return socket.emit("error_message", {
        success: false,
        message: "Board not found",
      });
    }

    const board = boardRows[0];

    if (board.currentTurn !== playerId) {
      return socket.emit("error_message", {
        success: false,
        message: "It's not your turn",
      });
    }

    const prevPosString = prevPosition?.toString() ?? "0";
    const nextPosString = currentPosition?.toString() ?? "0";

    await connection.beginTransaction();

    // 🧩 Pawn kill logic
    let killedPawn = null;
    let hasCaptured = 0;
    let updatedBalanceMoves = null;

    const isBasePosition =
      currentPosition === 0 || currentPosition === "0" || pawnType === "base";

    if (!isBasePosition) {
      const [opponentPawns] = await connection.execute(
        `SELECT * FROM pawns 
         WHERE boardId = ? 
         AND id != ?
         AND currentPosition = ?
         LIMIT 1`,
        [boardId, pawnId, currentPosition.toString()]
      );

      if (opponentPawns.length > 0) {
        const opponentPawn = opponentPawns[0];
        const killedPrevPos = opponentPawn.currentPosition;

        await connection.execute(
          `UPDATE pawns 
           SET prevPosition = ?, currentPosition = 0, type = 'base', isSafe = 1
           WHERE id = ? AND boardId = ?`,
          [killedPrevPos, opponentPawn.id, boardId]
        );

        killedPawn = {
          pawnId: opponentPawn.id,
          playerId: opponentPawn.playerId,
          previousPosition: killedPrevPos,
        };
        hasCaptured = 1;
      }
    }

    // ✅ Update moving pawn
    await connection.execute(
      `UPDATE pawns 
       SET prevPosition = ?, currentPosition = ?, type = ?, isSafe = ?
       WHERE id = ? AND playerId = ? AND boardId = ?`,
      [
        prevPosition,
        currentPosition,
        pawnType,
        isSafe,
        pawnId,
        playerId,
        boardId,
      ]
    );

    // ✅ Update board turn
    await connection.execute(
      `UPDATE boards SET currentTurn = ? WHERE id = ?`,
      [nextPlayerId, boardId]
    );

    // ✅ Move log
    await connection.execute(
      `INSERT INTO moveLogs (
        boardId, playerId, pawnId, diceValue, prevPos, nextPos, hasCaptured, gotCaptured
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        boardId,
        playerId,
        pawnId,
        diceValue ?? null,
        prevPosString,
        nextPosString,
        hasCaptured,
        0,
      ]
    );

    // ✅ Update FLM moves
    const [flmMoveRows] = await connection.execute(
      `SELECT moves, currentBalanceMoves FROM flms WHERE flmId = ? LIMIT 1`,
      [playerId]
    );

    if (flmMoveRows.length > 0) {
      const { moves: totalMoves, currentBalanceMoves } = flmMoveRows[0];
      const baseMoves = Number.isFinite(Number(currentBalanceMoves))
        ? Number(currentBalanceMoves)
        : Number(totalMoves) || 0;
      const newBalance = Math.max(baseMoves - 1, 0);

      const updatedAtIST = formatISTDateTimeForSQL();
      await connection.execute(
        `UPDATE flms 
         SET currentBalanceMoves = ?, moves = GREATEST(moves - 1, 0), updatedAt = ?
         WHERE flmId = ?`,
        [newBalance, updatedAtIST, playerId]
      );

      updatedBalanceMoves = newBalance;
    }

    // ✅ Record kill logs
    if (killedPawn) {
      await connection.execute(
        `INSERT INTO moveLogs (
          boardId, playerId, pawnId, diceValue, prevPos, nextPos, hasCaptured, gotCaptured
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          boardId,
          killedPawn.playerId,
          killedPawn.pawnId,
          null,
          killedPawn.previousPosition?.toString() ?? "0",
          "0",
          0,
          1,
        ]
      );

      const updatedAtIST = formatISTDateTimeForSQL();
      await connection.execute(
        `UPDATE flms SET kills = COALESCE(kills, 0) + 1, updatedAt = ? WHERE flmId = ?`,
        [updatedAtIST, playerId]
      );
    }

    // 🏁 Winner & game-finish logic
    let playerCompleted = false;
    let winnerPosition = null;
    let gameFinished = false;
    let loserInfo = null;

    if (pawnType === "center") {
      const [playerPawns] = await connection.execute(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN type = 'center' THEN 1 ELSE 0 END) AS finished
         FROM pawns WHERE playerId = ? AND boardId = ?`,
        [playerId, boardId]
      );

      const total = playerPawns[0].total;
      const finished = playerPawns[0].finished;

      if (finished === total && total > 0) {
        playerCompleted = true;

        const [updatedBoardRows] = await connection.execute(
          `SELECT winner1, winner2, winner3 FROM boards WHERE id = ?`,
          [boardId]
        );

        if (updatedBoardRows.length > 0) {
          const { winner1, winner2, winner3 } = updatedBoardRows[0];
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

            if (winnerField === "winner3") {
              const [finalBoardRows] = await connection.execute(
                `SELECT winner1, winner2, winner3, player1, player2, player3, player4 
                 FROM boards WHERE id = ?`,
                [boardId]
              );

              if (finalBoardRows.length > 0) {
                const finalBoard = finalBoardRows[0];
                const { winner1: w1, winner2: w2, winner3: w3 } = finalBoard;
                if (w1 && w2 && w3) {
                  const allPlayers = [
                    finalBoard.player1,
                    finalBoard.player2,
                    finalBoard.player3,
                    finalBoard.player4,
                  ].filter(Boolean);
                  const losers = allPlayers.find(
                    (p) => ![w1, w2, w3].includes(p)
                  );

                  if (losers) {
                    const endTimeIST = formatISTDateTimeForSQL();
                    await connection.execute(
                      `UPDATE boards 
                       SET loser = ?, status = 'finished', endTime = ?
                       WHERE id = ?`,
                      [losers, endTimeIST, boardId]
                    );

                    gameFinished = true;
                    loserInfo = {
                      loser: losers,
                      winners: { first: w1, second: w2, third: w3 },
                    };
                  }
                }
              }
            }
          }
        }
      }
    }

    await connection.commit();

    const [updatedPawnRows] = await connection.execute(
      `SELECT * FROM pawns WHERE id = ?`,
      [pawnId]
    );

    const updatedPawn = updatedPawnRows[0];

    let killedPawnPayload = null;
    if (killedPawn) {
      const [killedPawnData] = await connection.execute(
        `SELECT * FROM pawns WHERE id = ?`,
        [killedPawn.pawnId]
      );
      if (killedPawnData.length > 0) {
        killedPawnPayload = { pawn: killedPawnData[0], killedBy: playerId };
      }
    }

    const notifications = [];
    if (playerCompleted) {
      notifications.push({
        type: "player_completed",
        playerId,
        message: `Player ${playerId} has completed all pawns!`,
      });
      if (winnerPosition) {
        notifications.push({
          type: "winner_updated",
          playerId,
          position: winnerPosition,
          message: `Player ${playerId} is now winner #${winnerPosition}!`,
        });
      }
    }

    if (gameFinished && loserInfo) {
      notifications.push({
        type: "game_finished",
        loser: loserInfo.loser,
        winners: loserInfo.winners,
        message: `Game finished! Player ${loserInfo.loser} has lost!`,
      });
    }

    // ✅ Emit live updates to all players on this board
    await emitBoardUpdate(boardId, {
      updatedPawn,
      currentBalanceMoves: updatedBalanceMoves,
      killedPawn: killedPawnPayload,
      notifications,
      playerCompleted,
      winnerPosition,
      gameFinished,
      diceValue,
      loser: loserInfo?.loser ?? null,
      winners: loserInfo?.winners ?? null,
      nextTurn: nextPlayerId,
    });

    // ✅ Confirm success to current player
    socket.emit("move_success", {
      success: true,
      message: "Pawn moved successfully",
      data: {
        pawn: updatedPawn,
        diceValue,
        killedPawn,
        playerCompleted,
        winnerPosition,
        gameFinished,
        loser: loserInfo?.loser ?? null,
        currentBalanceMoves: updatedBalanceMoves,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error in movePawnFromSocket:", error);
    socket.emit("error_message", {
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};


export const getFlmStats = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId } = req.params;

    if (!flmId) {
      return res.status(400).json({
        success: false,
        message: "FLM ID is required",
      });
    }

    const [flmRows] = await connection.execute(
      `SELECT flmId, flmName, hq, zone, region, points, moves, currentBalanceMoves, kills
       FROM flms
       WHERE flmId = ?
       LIMIT 1`,
      [flmId]
    );

    if (flmRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "FLM not found",
      });
    }

    const flm = flmRows[0];

    const [mrStatsRows] = await connection.execute(
      `SELECT COUNT(*) AS totalMrs,
              SUM(CASE WHEN hasAccess = 1 THEN 1 ELSE 0 END) AS activeMrs
       FROM mrs
       WHERE flmId = ?`,
      [flmId]
    );

    const [boardStatsRows] = await connection.execute(
      `SELECT 
         COUNT(*) AS totalBoards,
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeBoards,
         SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS finishedBoards
       FROM boards
       WHERE player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?`,
      [flmId, flmId, flmId, flmId]
    );

    const mrStats = mrStatsRows[0] || { totalMrs: 0, activeMrs: 0 };
    const boardStats =
      boardStatsRows[0] || {
        totalBoards: 0,
        activeBoards: 0,
        finishedBoards: 0,
      };

    res.status(200).json({
      success: true,
      data: {
        flm: {
          id: flm.flmId,
          name: flm.flmName,
          zone: flm.zone,
          hq: flm.hq,
          region: flm.region,
          points: flm.points ?? 0,
          moves: flm.moves ?? 0,
          currentBalanceMoves: flm.currentBalanceMoves ?? 0,
          kills: flm.kills ?? 0,
          status: flm.status,
        },
        mrStats: {
          total: mrStats.totalMrs ?? 0,
          withAccess: mrStats.activeMrs ?? 0,
        },
        boardStats: {
          total: boardStats.totalBoards ?? 0,
          active: boardStats.activeBoards ?? 0,
          finished: boardStats.finishedBoards ?? 0,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching FLM stats:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

//only prescription related functions
//not in use currently
export const getPendingPrescriptionsForFlm = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId } = req.params;
    const {
      date,
      startDate,
      endDate,
      today,
    } = req.query;

    if (!flmId) {
      return res.status(400).json({
        success: false,
        message: "FLM ID is required",
      });
    }

    const [flmRows] = await connection.execute(
      "SELECT flmId FROM flms WHERE flmId = ? LIMIT 1",
      [flmId]
    );

    if (flmRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "FLM not found",
      });
    }

    const dateFilters = [];
    const dateParams = [];

    const normalizedToday =
      today === true || today === "true" || today === "1";

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

    const whereDateClause =
      dateFilters.length > 0 ? ` AND ${dateFilters.join(" AND ")}` : "";

    const [pendingPrescriptions] = await connection.execute(
      `SELECT 
          p.*,
          m.mrName,
          m.mrId,
          m.zone AS mrZone,
          m.region AS mrRegion,
          b.points AS brandPoints,
          (p.points) AS totalPoints
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       LEFT JOIN brands b ON p.brandId = b.id
       WHERE p.type = 'prescription'
         AND m.flmId = ?
         AND p.status = 'pending'
          ${whereDateClause}
       ORDER BY p.updatedAt DESC, p.dateOfUpload DESC, p.timeOfUpload DESC`,
      [flmId, ...dateParams]
    );

    res.status(200).json({
      success: true,
      data: pendingPrescriptions,
      total: pendingPrescriptions.length,
    });
  } catch (error) {
    console.error("Error fetching pending prescriptions for FLM:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

//only prescription related functions
//not in use currently
export const getPrescriptionForFlm = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId, prescriptionId } = req.params;

    if (!flmId || !prescriptionId) {
      return res.status(400).json({
        success: false,
        message: "flmId and prescriptionId are required",
      });
    }

    // OLD CODE - using prescriptions table
    // const [rows] = await connection.execute(
    //   `SELECT 
    //      p.*,
    //      m.mrName,
    //      m.mrId,
    //      m.zone AS mrZone,
    //      m.region AS mrRegion,
    //      m.hq AS mrHq,
    //      b.points AS brandPoints,
    //      p.points AS totalPoints
    //    FROM prescriptions p
    //    JOIN mrs m ON p.mrId = m.mrId
    //    JOIN flms f ON m.flmId = f.flmId
    //    LEFT JOIN brands b ON p.brandId = b.id
    //    WHERE f.flmId = ? AND p.id = ?
    //    LIMIT 1`,
    //   [flmId, prescriptionId]
    // );

    const [rows] = await connection.execute(
      `SELECT 
         p.*,
         m.mrName,
         m.mrId,
         m.zone AS mrZone,
         m.region AS mrRegion,
         m.hq AS mrHq,
         b.points AS brandPoints,
         p.points AS totalPoints
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       JOIN flms f ON m.flmId = f.flmId
       LEFT JOIN brands b ON p.brandId = b.id
       WHERE p.type = 'prescription'
         AND f.flmId = ? AND p.id = ?
       LIMIT 1`,
      [flmId, prescriptionId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Prescription not found for this FLM",
      });
    }

    const prescription = rows[0];

    return res.status(200).json({
      success: true,
      data: {
        id: prescription.id,
        mrId: prescription.mrId,
        mrName: prescription.mrName,
        mrZone: prescription.mrZone,
        mrRegion: prescription.mrRegion,
        mrHq: prescription.mrHq,
        brandId: prescription.brandId,
        brandName: prescription.brandName,
        brandPoints: prescription.brandPoints ?? 0,
        drName: prescription.drName,
        speciality: prescription.speciality,
        mobNo: prescription.mobNo,
        scCode: prescription.scCode,
        noRxns: prescription.noRxns,
        rxnDuration: prescription.rxnDuration,
        prescriptionImage: prescription.uploadImage,
        dateOfUpload: prescription.dateOfUpload,
        timeOfUpload: prescription.timeOfUpload,
        points: prescription.points,
        totalPoints: prescription.totalPoints,
        status: prescription.status,
        rejectionReason: prescription.rejectionReason,
        attempts: prescription.attempts,
        isCalculated: prescription.isCalculated,
        reviewDate: prescription.reviewDate,
        createdAt: prescription.createdAt,
        updatedAt: prescription.updatedAt,
      },
    });
  } catch (error) {
    console.error("Error fetching prescription for FLM:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};
//end only prescription related functions



export const getPendingUploadsForFlm = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId } = req.params;
    const {
      date,
      startDate,
      endDate,
      today,
      type, // Optional: filter by type ('prescription', 'pob', 'camp')
    } = req.query;

    if (!flmId) {
      return res.status(400).json({
        success: false,
        message: "FLM ID is required",
      });
    }

    const [flmRows] = await connection.execute(
      "SELECT flmId FROM flms WHERE flmId = ? LIMIT 1",
      [flmId]
    );

    if (flmRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "FLM not found",
      });
    }

    const dateFilters = [];
    const dateParams = [];

    const normalizedToday =
      today === true || today === "true" || today === "1";

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

    const whereDateClause =
      dateFilters.length > 0 ? ` AND ${dateFilters.join(" AND ")}` : "";

    // Build type filter clause - allow any activity type dynamically
    let typeFilterClause = "";
    if (type && type.trim()) {
      typeFilterClause = " AND p.type = ?";
      dateParams.push(type.trim());
    }

    const [pendingUploads] = await connection.execute(
      `SELECT 
          p.*,
          m.mrName
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       WHERE m.flmId = ?
          ${whereDateClause}
          ${typeFilterClause}
       ORDER BY p.updatedAt DESC, p.dateOfUpload DESC, p.timeOfUpload DESC`,
      [flmId, ...dateParams]
    );

    // Flatten activitySpecificDetails to top level for frontend compatibility
    // Exclude database column fields that should not be overridden
    // Note: 'status' is filtered out to prevent overriding database status,
    // but user-defined status from activitySpecificDetails should still be accessible
    const dbColumnFields = new Set([
      'id', 'type', 'mrId', 'uploadImage', 'dateOfUpload', 'timeOfUpload',
      'status', 'reason', 'attempts', 'reviewDate', 'points', 'diceRollBalance',
      'isCalculated', 'activitySpecificDetails', 'drName', 'speciality', 'mobNo',
      'scCode', 'createdAt', 'updatedAt', 'mrName', 'mrZone', 'mrHq', 'mrRegion',
      'brandPoints', 'countType', 'unitFactor', 'valueFactor', 'campPoints', 'campDefaultFactor'
    ]);
    
    const flattenedUploads = pendingUploads.map(upload => {
      if (upload.activitySpecificDetails) {
        try {
          const activityDetails = typeof upload.activitySpecificDetails === 'string' 
            ? JSON.parse(upload.activitySpecificDetails) 
            : upload.activitySpecificDetails;
          
          if (activityDetails) {
            // Store user-defined status separately before filtering
            const userDefinedStatus = activityDetails.status;
            
            // Filter out database column fields from activityDetails to prevent overriding
            const filteredActivityDetails = {};
            Object.keys(activityDetails).forEach(key => {
              if (!dbColumnFields.has(key)) {
                filteredActivityDetails[key] = activityDetails[key];
              }
            });
            
            // Build result: spread filtered activityDetails first, then database fields take precedence
            const result = {
              ...upload,
              ...filteredActivityDetails,
              // Ensure database status is not overridden
              status: upload.status,
              // Keep activitySpecificDetails for reference (with original status)
              activitySpecificDetails: activityDetails
            };
            
            // If there's a user-defined status in activityDetails, add it back
            // This allows frontend to access it without overriding database status
            if (userDefinedStatus !== undefined && userDefinedStatus !== null) {
              // The status from activitySpecificDetails is already in activitySpecificDetails
              // Frontend can access it from there, or we can add it with a different key
              // For now, it's accessible via activitySpecificDetails.status
            }
            
            return result;
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
    console.error("Error fetching pending uploads for FLM:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getUploadForFlm = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId, uploadId } = req.params;

    if (!flmId || !uploadId) {
      return res.status(400).json({
        success: false,
        message: "flmId and uploadId are required",
      });
    }

    const [rows] = await connection.execute(
      `SELECT 
         p.*,
         m.mrName,
         m.mrId,
         m.zone AS mrZone,
         m.hq AS mrHq,
         m.region AS mrRegion,
         b.id AS brandId,
         b.brandName,
         b.points AS brandPoints,
         b.countType AS countType,
         b.unitFactor AS unitFactor,
         b.valueFactor AS valueFactor,
         c.id AS campId,
         c.campName,
         c.points AS campPoints,
         c.defaultFactor AS campDefaultFactor,
         (p.points) AS totalPoints
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       JOIN flms f ON m.flmId = f.flmId
       LEFT JOIN brands b ON JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandId')) = b.id
       LEFT JOIN camps c ON JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.campId')) = c.id
       WHERE f.flmId = ? AND p.id = ?
       LIMIT 1`,
      [flmId, uploadId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Upload not found for this FLM",
      });
    }

    const upload = rows[0];
    
    // Flatten activitySpecificDetails to top level for frontend compatibility
    // Exclude database column fields that should not be overridden
    // Note: 'status' is filtered out to prevent overriding database status,
    // but user-defined status from activitySpecificDetails is preserved in activitySpecificDetails
    const dbColumnFields = new Set([
      'id', 'type', 'mrId', 'uploadImage', 'dateOfUpload', 'timeOfUpload',
      'status', 'reason', 'attempts', 'reviewDate', 'points', 'diceRollBalance',
      'isCalculated', 'activitySpecificDetails', 'drName', 'speciality', 'mobNo',
      'scCode', 'createdAt', 'updatedAt', 'mrName', 'mrZone', 'mrHq', 'mrRegion',
      'brandPoints', 'countType', 'unitFactor', 'valueFactor', 'campPoints', 'totalPoints',
      'brandId', 'campId' // Exclude these from activityDetails to use JOIN values
    ]);
    
    // Start with upload data, ensuring brandName and campName from JOINs are included
    let flattenedUpload = {
      ...upload,
      // Ensure brandName and campName from JOINs are always included
      brandName: upload.brandName || null,
      campName: upload.campName || null,
      brandId: upload.brandId || null,
      campId: upload.campId || null,
    };
    
    if (upload.activitySpecificDetails) {
      try {
        const activityDetails = typeof upload.activitySpecificDetails === 'string' 
          ? JSON.parse(upload.activitySpecificDetails) 
          : upload.activitySpecificDetails;
        
        // Filter out database column fields from activityDetails to prevent overriding
        if (activityDetails) {
          const filteredActivityDetails = {};
          Object.keys(activityDetails).forEach(key => {
            if (!dbColumnFields.has(key)) {
              filteredActivityDetails[key] = activityDetails[key];
            }
          });
          
          // Build result: spread filtered activityDetails, but prioritize JOIN values for brandName/campName
          flattenedUpload = {
            ...flattenedUpload,
            ...filteredActivityDetails,
            // Ensure database status is not overridden (must come after spreading filteredActivityDetails)
            status: upload.status,
            // Use brandName and campName from JOINs (current database values) if available, otherwise from activityDetails
            brandName: upload.brandName || filteredActivityDetails.brandName || null,
            campName: upload.campName || filteredActivityDetails.campName || null,
            // Use brandId and campId from JOINs if available, otherwise from activityDetails
            brandId: upload.brandId || filteredActivityDetails.brandId || null,
            campId: upload.campId || filteredActivityDetails.campId || null,
            // Keep activitySpecificDetails for reference (includes original user-defined status)
            activitySpecificDetails: activityDetails
          };
        }
      } catch (error) {
        console.error("Error parsing activitySpecificDetails:", error);
        // If parsing fails, return upload as-is (already set above)
      }
    }

    return res.status(200).json({
      success: true,
      data: flattenedUpload,
    });
  } catch (error) {
    console.error("Error fetching upload for FLM:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

// Helper function to check if FLM has active or recent (non-expired) boards
const hasActiveOrRecentBoards = async (connection, flmId) => {
  // Get current IST date
  const todayDateIST = formatISTDateForSQL();
  
  // Check for active boards or boards that haven't expired yet
  // A board expires when: DATE(expirationDate) + INTERVAL 1 DAY <= DATE(NOW())
  // So a board is still valid if: DATE(expirationDate) + INTERVAL 1 DAY > DATE(NOW())
  // Or if expirationDate is NULL (no expiration)
  const [boardRows] = await connection.execute(
    `SELECT id FROM boards
     WHERE (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)
       AND (
         expirationDate IS NULL 
         OR DATE(DATE_ADD(expirationDate, INTERVAL 1 DAY)) > DATE(?)
       )
     LIMIT 1`,
    [flmId, flmId, flmId, flmId, todayDateIST]
  );
  
  return boardRows.length > 0;
};

export const reviewUpload = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId, uploadId } = req.params;
    const { action, rejectionReason } = req.body;

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Invalid action. Use 'approve' or 'reject'.",
      });
    }

    if (!uploadId) {
      return res.status(400).json({
        success: false,
        message: "uploadId is required",
      });
    }

    await connection.beginTransaction();

    const [uploadRows] = await connection.execute(
      `SELECT p.*, m.mrId
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       WHERE p.id = ? AND m.flmId = ?
       LIMIT 1
       FOR UPDATE`,
      [uploadId, flmId]
    );

    if (uploadRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Upload not found for this FLM",
      });
    }

    const upload = uploadRows[0];

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

    if (action === "approve") {
      // Only allow approving pending uploads
      // Pending uploads can be first-time uploads (if auto-approval is disabled) or resubmissions
      if (upload.status !== "pending") {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Only pending uploads can be approved",
        });
      }
      // Get IST datetime for reviewDate and updatedAt (always IST regardless of server timezone)
      const reviewDateIST = formatISTDateTimeForSQL();
      const updatedAtIST = formatISTDateTimeForSQL();

      await connection.execute(
        `UPDATE uploads
         SET status = 'approved',
             reason = 'approved by manager',
             reviewDate = ?,
             isCalculated = 1,
             updatedAt = ?
         WHERE id = ?`,
        [reviewDateIST, reviewDateIST, uploadId]
      );

      const points = Number(upload.points) || 0;

      if (points > 0) {
        const [configRows] = await connection.execute(
          `SELECT medianValue, lessMedianFactor, greaterMedianFactor
           FROM config
           ORDER BY createdAt DESC
           LIMIT 1`
        );

        const config = configRows?.[0] ?? {};
        const medianValue = Number(config.medianValue);
        const lessMedianFactor = Number(config.lessMedianFactor);
        const greaterMedianFactor = Number(config.greaterMedianFactor);

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

        const computedMoves = points * moveFactor;
        const movesToAdd = Number.isFinite(computedMoves) ? computedMoves : points;
        const diceRollBalance = movesToAdd;

        await connection.execute(
          `UPDATE uploads
           SET diceRollBalance = ?
           WHERE id = ?`,
          [diceRollBalance, uploadId]
        );

        await connection.execute(
          `UPDATE mrs 
           SET points = COALESCE(points, 0) + ?,
               diceRollBalance = COALESCE(diceRollBalance, 0) + ?,
               updatedAt = ?
           WHERE mrId = ?`,
          [points, diceRollBalance, updatedAtIST, upload.mrId]
        );

        await connection.execute(
          `UPDATE flms 
           SET points = COALESCE(points, 0) + ?,
               currentDiceRollBalance = COALESCE(currentDiceRollBalance, 0) + ?,
               updatedAt = ?
           WHERE flmId = ?`,
          [points, movesToAdd, updatedAtIST, flmId]
        );
      }

      // Award hearts and/or dice rolls dynamically based on activity-specific details
      // This logic maintains backward compatibility with hardcoded types:
      // - Prescription: has brandId + noRxns → uses noRxns as multiplier
      // - POB: has brandId + noOfUnits/allValue (no noRxns) → uses noOfUnits/allValue based on countType
      // - Camp: has campId → uses noOfCamps as multiplier
      // - New activity types: works automatically based on fields present in activityDetails
      
      // Check for brand-based rewards (if brandId exists in activityDetails)
      if (activityDetails.brandId) {
        const [brandRows] = await connection.execute(
          `SELECT hearts, diceRolls, countType FROM brands WHERE id = ?`,
          [activityDetails.brandId]
        );

        if (brandRows.length > 0) {
          const brand = brandRows[0];
          let multiplier = 1;
          
          // Determine multiplier based on activity-specific fields
          // Priority: noRxns > (noOfUnits/allValue based on countType)
          // This ensures prescription (has noRxns) and POB (has noOfUnits/allValue) work correctly
          if (activityDetails.noRxns !== undefined && activityDetails.noRxns !== null) {
            // Prescription-like: use noRxns (maintains original prescription behavior)
            multiplier = Number(activityDetails.noRxns) || 1;
          } else {
            // POB-like: use noOfUnits or allValue based on brand's countType (maintains original POB behavior)
            const brandCountType = brand.countType ? brand.countType.toLowerCase() : null;
            if (brandCountType === "unit") {
              multiplier = Number(activityDetails.noOfUnits) || 1;
            } else if (brandCountType === "value") {
              multiplier = Number(activityDetails.allValue) || 1;
            } else {
              // Fallback: use whichever is available
              multiplier = Number(activityDetails.noOfUnits || activityDetails.allValue) || 1;
            }
          }
          
          // Award hearts if specified
          const brandHearts = Number(brand.hearts) || 0;
          if (brandHearts > 0) {
            const heartsToAward = brandHearts * multiplier;
            await connection.execute(
              `UPDATE flms 
               SET hearts = COALESCE(hearts, 0) + ?,
                   updatedAt = ?
               WHERE flmId = ?`,
              [heartsToAward, updatedAtIST, flmId]
            );
          }

          // Award dice rolls if specified
          const brandDiceRolls = Number(brand.diceRolls) || 0;
          if (brandDiceRolls > 0) {
            const diceRollsToAward = brandDiceRolls * multiplier;
            await connection.execute(
              `UPDATE flms 
               SET currentDiceRollBalance = COALESCE(currentDiceRollBalance, 0) + ?,
                   updatedAt = ?
               WHERE flmId = ?`,
              [diceRollsToAward, updatedAtIST, flmId]
            );
          }
        }
      }
      
      // Check for camp-based rewards (if campId exists in activityDetails)
      if (activityDetails.campId) {
        const [campRows] = await connection.execute(
          `SELECT hearts, diceRolls FROM camps WHERE id = ?`,
          [activityDetails.campId]
        );

        if (campRows.length > 0) {
          const camp = campRows[0];
          // Use noOfCamps from activitySpecificDetails
          const noOfCamps = Number(activityDetails.noOfCamps) || 1;
          
          // Award hearts if specified
          const campHearts = Number(camp.hearts) || 0;
          if (campHearts > 0) {
            const heartsToAward = campHearts * noOfCamps;
            await connection.execute(
              `UPDATE flms 
               SET hearts = COALESCE(hearts, 0) + ?,
                   updatedAt = ?
               WHERE flmId = ?`,
              [heartsToAward, updatedAtIST, flmId]
            );
          }

          // Award dice rolls if specified
          const campDiceRolls = Number(camp.diceRolls) || 0;
          if (campDiceRolls > 0) {
            const diceRollsToAward = campDiceRolls * noOfCamps;
            await connection.execute(
              `UPDATE flms 
               SET currentDiceRollBalance = COALESCE(currentDiceRollBalance, 0) + ?,
                   updatedAt = ?
               WHERE flmId = ?`,
              [diceRollsToAward, updatedAtIST, flmId]
            );
          }
        }
      }
//end
      await connection.commit();

    return res.status(200).json({
      success: true,
        message: "Upload approved successfully",
        data: {
          uploadId: uploadId,
          type: upload.type,
          status: "approved",
        },
      });
    } else {
      // Check if FLM has active boards (not ended) before allowing rejection
      // A board is considered ended if status is 'finished' or if endTime has passed
      const currentISTDateTime = formatISTDateTimeForSQL();
      const [activeBoardRows] = await connection.execute(
        `SELECT id FROM boards 
         WHERE status = 'active' 
           AND (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)
           AND (endTime IS NULL OR endTime > ?)
         LIMIT 1`,
        [flmId, flmId, flmId, flmId, currentISTDateTime]
      );

      if (activeBoardRows.length === 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Cannot reject uploads after all boards have ended. Please wait for new boards to be created.",
        });
      }

      if (!rejectionReason || rejectionReason.toString().trim().length === 0) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Rejection reason is required when rejecting an upload",
        });
      }

      // Get IST datetime for reviewDate (always IST regardless of server timezone)
      const reviewDateIST = formatISTDateTimeForSQL();

      // Check if upload was previously approved (auto-approved first-time upload)
      // If it was approved (status = 'approved' or isCalculated = 1), subtract points and dice rolls
      const wasPreviouslyApproved = upload.status === "approved" || upload.isCalculated === 1;
      
      if (wasPreviouslyApproved && upload.points > 0) {
        const pointsToSubtract = Number(upload.points) || 0;
        const diceRollBalanceToSubtract = Number(upload.diceRollBalance) || 0;

        // Get config for move factor calculation (same as approval)
        const [configRows] = await connection.execute(
          `SELECT medianValue, lessMedianFactor, greaterMedianFactor
           FROM config
           ORDER BY createdAt DESC
           LIMIT 1`
        );

        const config = configRows?.[0] ?? {};
        const medianValue = Number(config.medianValue);
        const lessMedianFactor = Number(config.lessMedianFactor);
        const greaterMedianFactor = Number(config.greaterMedianFactor);

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

        const computedMoves = pointsToSubtract * moveFactor;
        const movesToSubtract = Number.isFinite(computedMoves) ? computedMoves : pointsToSubtract;

        // Subtract points and dice rolls from MR
        await connection.execute(
          `UPDATE mrs 
           SET points = GREATEST(COALESCE(points, 0) - ?, 0),
               diceRollBalance = GREATEST(COALESCE(diceRollBalance, 0) - ?, 0),
               updatedAt = ?
           WHERE mrId = ?`,
          [pointsToSubtract, diceRollBalanceToSubtract, reviewDateIST, upload.mrId]
        );

        // Subtract points and dice rolls from FLM
        await connection.execute(
          `UPDATE flms 
           SET points = GREATEST(COALESCE(points, 0) - ?, 0),
               currentDiceRollBalance = GREATEST(COALESCE(currentDiceRollBalance, 0) - ?, 0),
               updatedAt = ?
           WHERE flmId = ?`,
          [pointsToSubtract, movesToSubtract, reviewDateIST, flmId]
        );

        // Subtract hearts and dice rolls if they were awarded (dynamic based on activityDetails)
        // This logic maintains backward compatibility with hardcoded types (same as approval logic above)
        // Check for brand-based rewards to subtract
        if (activityDetails.brandId) {
          const [brandRows] = await connection.execute(
            `SELECT hearts, diceRolls, countType FROM brands WHERE id = ?`,
            [activityDetails.brandId]
          );

          if (brandRows.length > 0) {
            const brand = brandRows[0];
            let multiplier = 1;
            
            // Determine multiplier based on activity-specific fields
            // Priority: noRxns > (noOfUnits/allValue based on countType)
            // This ensures prescription (has noRxns) and POB (has noOfUnits/allValue) work correctly
            if (activityDetails.noRxns !== undefined && activityDetails.noRxns !== null) {
              // Prescription-like: use noRxns (maintains original prescription behavior)
              multiplier = Number(activityDetails.noRxns) || 1;
            } else {
              // POB-like: use noOfUnits or allValue based on brand's countType (maintains original POB behavior)
              const brandCountType = brand.countType ? brand.countType.toLowerCase() : null;
              if (brandCountType === "unit") {
                multiplier = Number(activityDetails.noOfUnits) || 1;
              } else if (brandCountType === "value") {
                multiplier = Number(activityDetails.allValue) || 1;
              } else {
                // Fallback: use whichever is available
                multiplier = Number(activityDetails.noOfUnits || activityDetails.allValue) || 1;
              }
            }
            
            const brandHearts = Number(brand.hearts) || 0;
            if (brandHearts > 0) {
              const heartsToSubtract = brandHearts * multiplier;
              await connection.execute(
                `UPDATE flms 
                 SET hearts = GREATEST(COALESCE(hearts, 0) - ?, 0),
                     updatedAt = ?
                 WHERE flmId = ?`,
                [heartsToSubtract, reviewDateIST, flmId]
              );
            }

            const brandDiceRolls = Number(brand.diceRolls) || 0;
            if (brandDiceRolls > 0) {
              const diceRollsToSubtract = brandDiceRolls * multiplier;
              await connection.execute(
                `UPDATE flms 
                 SET currentDiceRollBalance = GREATEST(COALESCE(currentDiceRollBalance, 0) - ?, 0),
                     updatedAt = ?
                 WHERE flmId = ?`,
                [diceRollsToSubtract, reviewDateIST, flmId]
              );
            }
          }
        }
        
        // Check for camp-based rewards to subtract
        if (activityDetails.campId) {
          const [campRows] = await connection.execute(
            `SELECT hearts, diceRolls FROM camps WHERE id = ?`,
            [activityDetails.campId]
          );

          if (campRows.length > 0) {
            const camp = campRows[0];
            // Use noOfCamps from activitySpecificDetails
            const noOfCamps = Number(activityDetails.noOfCamps) || 1;
            
            const campHearts = Number(camp.hearts) || 0;
            if (campHearts > 0) {
              const heartsToSubtract = campHearts * noOfCamps;
              await connection.execute(
                `UPDATE flms 
                 SET hearts = GREATEST(COALESCE(hearts, 0) - ?, 0),
                     updatedAt = ?
                 WHERE flmId = ?`,
                [heartsToSubtract, reviewDateIST, flmId]
              );
            }

            const campDiceRolls = Number(camp.diceRolls) || 0;
            if (campDiceRolls > 0) {
              const diceRollsToSubtract = campDiceRolls * noOfCamps;
              await connection.execute(
                `UPDATE flms 
                 SET currentDiceRollBalance = GREATEST(COALESCE(currentDiceRollBalance, 0) - ?, 0),
                     updatedAt = ?
                 WHERE flmId = ?`,
                [diceRollsToSubtract, reviewDateIST, flmId]
              );
            }
          }
        }
      }

      await connection.execute(
        `UPDATE uploads
         SET status = 'rejected',
             reason = ?,
             reviewDate = ?,
             isCalculated = 0,
             updatedAt = ?
         WHERE id = ?`,
        [rejectionReason, reviewDateIST, reviewDateIST, uploadId]
      );

      await connection.commit();

      return res.status(200).json({
        success: true,
        message: "Upload rejected successfully",
        data: {
          uploadId: uploadId,
          type: upload.type,
          status: "rejected",
          rejectionReason,
        },
      });
    }
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error reviewing upload:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};


//before handling diff upload types
// export const reviewPrescription = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { flmId, prescriptionId } = req.params;
//     const { action, rejectionReason } = req.body;

//     if (!["approve", "reject"].includes(action)) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid action. Use 'approve' or 'reject'.",
//       });
//     }

//     await connection.beginTransaction();

//     // OLD CODE - using prescriptions table
//     // const [prescriptionRows] = await connection.execute(
//     //   `SELECT p.*, m.mrId
//     //    FROM prescriptions p
//     //    JOIN mrs m ON p.mrId = m.mrId
//     //    WHERE p.id = ? AND m.flmId = ?
//     //    LIMIT 1
//     //    FOR UPDATE`,
//     //   [prescriptionId, flmId]
//     // );

//     const [prescriptionRows] = await connection.execute(
//       `SELECT p.*, m.mrId
//        FROM uploads p
//        JOIN mrs m ON p.mrId = m.mrId
//        WHERE p.type = 'prescription'
//          AND p.id = ? AND m.flmId = ?
//        LIMIT 1
//        FOR UPDATE`,
//       [prescriptionId, flmId]
//     );

//     if (prescriptionRows.length === 0) {
//       await connection.rollback();
//       return res.status(404).json({
//         success: false,
//         message: "Prescription not found for this FLM",
//       });
//     }

//     const prescription = prescriptionRows[0];

//     if (prescription.status !== "pending") {
//       await connection.rollback();
//       return res.status(400).json({
//         success: false,
//         message: "Only pending prescriptions can be reviewed",
//       });
//     }

//     if (action === "approve") {
//       // OLD CODE - using prescriptions table
//       // await connection.execute(
//       //   `UPDATE prescriptions
//       //    SET status = 'approved',
//       //        rejectionReason = NULL,
//       //        reviewDate = NOW(),
//       //        isCalculated = 1
//       //    WHERE id = ?`,
//       //   [prescriptionId]
//       // );

//       await connection.execute(
//         `UPDATE uploads
//          SET status = 'approved',
//              rejectionReason = NULL,
//              reviewDate = NOW(),
//              isCalculated = 1
//          WHERE type = 'prescription'
//            AND id = ?`,
//         [prescriptionId]
//       );

//       const points = Number(prescription.points) || 0;

//       if (points > 0) {
//         const [configRows] = await connection.execute(
//           `SELECT medianValue, lessMedianFactor, greaterMedianFactor
//            FROM config
//            ORDER BY createdAt DESC
//            LIMIT 1`
//         );

//         const config = configRows?.[0] ?? {};
//         const medianValue = Number(config.medianValue);
//         const lessMedianFactor = Number(config.lessMedianFactor);
//         const greaterMedianFactor = Number(config.greaterMedianFactor);

//         const [flmRows] = await connection.execute(
//           `SELECT mrCount
//            FROM flms
//            WHERE flmId = ?
//            LIMIT 1
//            FOR UPDATE`,
//           [flmId]
//         );

//         const mrCount = Number(flmRows?.[0]?.mrCount) || 0;

//         let moveFactor = 1;
//         if (Number.isFinite(medianValue)) {
//           if (mrCount < medianValue && Number.isFinite(lessMedianFactor)) {
//             moveFactor = lessMedianFactor;
//           } else if (mrCount > medianValue && Number.isFinite(greaterMedianFactor)) {
//             moveFactor = greaterMedianFactor;
//           }
//         }

//         const computedMoves = points * moveFactor;
//         const movesToAdd = Number.isFinite(computedMoves) ? computedMoves : points;
//         const diceRollBalance = movesToAdd;

//         // OLD CODE - using prescriptions table
//         // await connection.execute(
//         //   `UPDATE prescriptions
//         //    SET diceRollBalance = ?
//         //    WHERE id = ?`,
//         //   [diceRollBalance, prescriptionId]
//         // );

//         await connection.execute(
//           `UPDATE uploads
//            SET diceRollBalance = ?
//            WHERE type = 'prescription'
//              AND id = ?`,
//           [diceRollBalance, prescriptionId]
//         );

//         await connection.execute(
//           `UPDATE mrs 
//            SET points = COALESCE(points, 0) + ?,
//                diceRollBalance = COALESCE(diceRollBalance, 0) + ?
//            WHERE mrId = ?`,
//           [points, diceRollBalance, prescription.mrId]
//         );

//         await connection.execute(
//           `UPDATE flms 
//            SET points = COALESCE(points, 0) + ?,
//                currentDiceRollBalance = COALESCE(currentDiceRollBalance, 0) + ?
//            WHERE flmId = ?`,
//           [points, movesToAdd, flmId]
//         );
//       }

//       await connection.commit();

//       return res.status(200).json({
//         success: true,
//         message: "Prescription approved successfully",
//         data: {
//           prescriptionId,
//           status: "approved",
//         },
//       });
//     } else {
//       if (!rejectionReason || rejectionReason.toString().trim().length === 0) {
//         await connection.rollback();
//         return res.status(400).json({
//           success: false,
//           message: "Rejection reason is required when rejecting a prescription",
//         });
//       }

//       // OLD CODE - using prescriptions table
//       // await connection.execute(
//       //   `UPDATE prescriptions
//       //    SET status = 'rejected',
//       //        rejectionReason = ?,
//       //        reviewDate = NOW(),
//       //        isCalculated = 0
//       //    WHERE id = ?`,
//       //   [rejectionReason, prescriptionId]
//       // );

//       await connection.execute(
//         `UPDATE uploads
//          SET status = 'rejected',
//              rejectionReason = ?,
//              reviewDate = NOW(),
//              isCalculated = 0
//          WHERE type = 'prescription'
//            AND id = ?`,
//         [rejectionReason, prescriptionId]
//       );

//       await connection.commit();

//       return res.status(200).json({
//         success: true,
//         message: "Prescription rejected successfully",
//         data: {
//           prescriptionId,
//           status: "rejected",
//           rejectionReason,
//         },
//       });
//     }
//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error reviewing prescription:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };


export const getMovesLeaderboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      division = "team",
      managerLevel = "flm",
      limit = 10,
      userRole,
      userId,
      startDate,
      endDate,
      teamName, // Filter by team name - filters leaderboard entries to show only specific team
      zone, // Filter by zone - filters leaderboard entries to show only specific zone
    } = req.query;

    const normalizedDivision = division.toString().trim().toLowerCase();
    const normalizedManagerLevel = managerLevel.toString().trim().toLowerCase();
    const normalizedUserRole = userRole ? userRole.toString().trim().toLowerCase() : null;
    const startDateStr = startDate ? startDate.toString().trim() : null;
    const endDateStr = endDate ? endDate.toString().trim() : null;
    // Team filter: decode URL encoding (e.g., "Black+Panthers" -> "Black Panthers") and trim
    const teamNameStr = teamName ? decodeURIComponent(teamName.toString().trim().replace(/\+/g, ' ')) : null;
    // Zone filter: decode URL encoding and trim
    const zoneStr = zone ? decodeURIComponent(zone.toString().trim().replace(/\+/g, ' ')) : null;

    if (normalizedDivision !== "team") {
      return res.status(400).json({
        success: false,
        message: "Moves leaderboard only supports division='team'. Moves, moves earned, moves lost, and kills metrics are team-level only.",
      });
    }

    if (!["flm", "slm", "tlm"].includes(normalizedManagerLevel)) {
      return res.status(400).json({
        success: false,
        message: "managerLevel must be 'flm', 'slm', or 'tlm' when division is 'team'",
      });
    }

    if ((startDateStr && !endDateStr) || (!startDateStr && endDateStr)) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required to enable filtering",
      });
    }

    let filterDatePayload = {
      isActive: false,
      startDateSql: null,
      endDateSql: null,
    };

    if (startDateStr && endDateStr) {
      const parsedStart = parseIsoDate(startDateStr, false);
      const parsedEnd = parseIsoDate(endDateStr, true);

      if (!parsedStart || !parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate and endDate must be valid dates (YYYY-MM-DD) not earlier than 2025-01-01",
        });
      }

      if (parsedStart > parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate cannot be later than endDate",
        });
      }

      filterDatePayload = {
        isActive: true,
        startDateSql: formatDateForSql(parsedStart),
        endDateSql: formatDateForSql(parsedEnd),
      };
    }

    let limitClause = "";
    let numericLimit = null;

    if (limit !== undefined && limit !== null && limit.toString().trim().toLowerCase() !== "all") {
      numericLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 1000));
      limitClause = ` LIMIT ${numericLimit}`;
    }

    let rows = [];
    let highlightId = null;

    const resolveFlmIdFromMr = async mrId => {
      if (!mrId) return null;
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [mrId]
      );
      if (mrRows.length === 0) return null;
      return mrRows[0].flmId || null;
    };

    const resolveManagerIdForFlm = async flmId => {
      if (!flmId) return { slmId: null, tlmId: null };
      const [flmRows] = await connection.execute(
        `SELECT f.slmId, s.tlmId
         FROM flms f
         LEFT JOIN slms s ON f.slmId = s.slmId
         WHERE f.flmId = ?
         LIMIT 1`,
        [flmId]
      );
      if (flmRows.length === 0) return { slmId: null, tlmId: null };
      return {
        slmId: flmRows[0].slmId || null,
        tlmId: flmRows[0].tlmId || null,
      };
    };

    if (userId) {
      if (normalizedUserRole === "flm") {
        if (normalizedManagerLevel === "flm") {
          highlightId = userId.toString().trim();
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(userId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "mr") {
        const flmId = await resolveFlmIdFromMr(userId);
        if (normalizedManagerLevel === "flm") {
          highlightId = flmId;
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(flmId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "slm") {
        highlightId = normalizedManagerLevel === "slm" ? userId.toString().trim() : null;
      } else if (normalizedUserRole === "tlm") {
        highlightId = normalizedManagerLevel === "tlm" ? userId.toString().trim() : null;
      }
    }

    // Team and zone filters: used to filter leaderboard results by team name or zone
    const teamFilterActive = !!teamNameStr;
    const zoneFilterActive = !!zoneStr;
    
    // Build WHERE clause for team and zone filters
    let teamZoneWhereClause = "";
    const teamZoneParams = [];
    if (teamFilterActive || zoneFilterActive) {
      const conditions = [];
      if (teamFilterActive) {
        if (normalizedManagerLevel === "flm") {
          conditions.push("f.teamName = ?");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.teamName = ?");
        } else {
          conditions.push("s.teamName = ?");
        }
        teamZoneParams.push(teamNameStr.trim());
      }
      if (zoneFilterActive) {
        if (normalizedManagerLevel === "flm") {
          // For FLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m WHERE m.flmId = f.flmId AND m.zone = ?)");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.zone = ?");
        } else {
          // For SLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m JOIN flms f2 ON m.flmId = f2.flmId WHERE f2.slmId = f.slmId AND m.zone = ?)");
        }
        teamZoneParams.push(zoneStr.trim());
      }
      teamZoneWhereClause = "WHERE " + conditions.join(" AND ");
    }

    const filterCteSql = buildFilterCte();
    const filterParams = filterDatePayload.isActive
      ? [filterDatePayload.startDateSql, filterDatePayload.endDateSql]
      : [];

    let teamSql = "";

    if (filterDatePayload.isActive) {
      if (normalizedManagerLevel === "flm") {
        teamSql = `
          ${filterCteSql}
          SELECT
            fm.flmId AS managerId,
            COALESCE(fm.flmName, 'Unassigned') AS managerName,
            COALESCE(f.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(MAX(fm.metricValue), 0) AS totalCurrentDice,
            COUNT(DISTINCT m.mrId) AS teamMembers
          FROM flmMetrics fm
          LEFT JOIN flms f ON fm.flmId = f.flmId
          LEFT JOIN mrs m ON m.flmId = fm.flmId
          ${teamZoneWhereClause}
          GROUP BY fm.flmId, fm.flmName, f.teamName
          ORDER BY totalCurrentDice DESC, managerName ASC
          ${limitClause}
        `;
      } else if (normalizedManagerLevel === "tlm") {
        teamSql = `
          ${filterCteSql}
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(t.teamName, NULL) AS teamName,
            COALESCE(t.zone, NULL) AS zone,
            COALESCE(SUM(fm.metricValue), 0) AS totalCurrentDice,
            COUNT(fm.flmId) AS teamMembers
          FROM flmMetrics fm
          LEFT JOIN slms s ON fm.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
          ${teamZoneWhereClause}
          GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
          ORDER BY totalCurrentDice DESC, managerName ASC
          ${limitClause}
        `;
      } else {
        teamSql = `
          ${filterCteSql}
          SELECT
            fm.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(s.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(SUM(fm.metricValue), 0) AS totalCurrentDice,
            COUNT(fm.flmId) AS teamMembers
          FROM flmMetrics fm
          LEFT JOIN slms s ON fm.slmId = s.slmId
          LEFT JOIN flms f2 ON fm.flmId = f2.flmId
          LEFT JOIN mrs m ON m.flmId = f2.flmId
          ${teamZoneWhereClause}
          GROUP BY fm.slmId, s.slmName, s.teamName
          ORDER BY totalCurrentDice DESC, managerName ASC
          ${limitClause}
        `;
      }
    } else {
      if (normalizedManagerLevel === "flm") {
        teamSql = `
          SELECT
            f.flmId AS managerId,
            COALESCE(f.flmName, 'Unassigned') AS managerName,
            COALESCE(f.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(MAX(f.currentMoveBalance), 0) AS totalCurrentDice,
            COUNT(DISTINCT m.mrId) AS teamMembers
          FROM flms f
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.flmId, f.flmName, f.teamName
          ORDER BY totalCurrentDice DESC, managerName ASC
          ${limitClause}
        `;
      } else if (normalizedManagerLevel === "tlm") {
        teamSql = `
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(t.teamName, NULL) AS teamName,
            COALESCE(t.zone, NULL) AS zone,
            COALESCE(SUM(f.currentMoveBalance), 0) AS totalCurrentDice,
            COUNT(f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
          ${teamZoneWhereClause}
          GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
          ORDER BY totalCurrentDice DESC, managerName ASC
          ${limitClause}
        `;
      } else {
        teamSql = `
          SELECT
            f.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(s.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(SUM(f.currentMoveBalance), 0) AS totalCurrentDice,
            COUNT(f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.slmId, s.slmName, s.teamName
          ORDER BY totalCurrentDice DESC, managerName ASC
          ${limitClause}
        `;
      }
    }
    const allFilterParams = [...filterParams, ...teamZoneParams];
    [rows] = await connection.execute(teamSql, allFilterParams);

    const data = rows.map((row, index) => ({
      rank: index + 1,
      managerId: row.managerId,
      managerName: row.managerName,
      teamName: row.teamName || null,
      zone: row.zone || null, // Include zone in response for frontend filtering
      totalCurrentDice: Number(row.totalCurrentDice) || 0,
      teamMembers: Number(row.teamMembers) || 0,
      metricValue: Number(row.totalCurrentDice) || 0,
    }));

    const highlightedEntry =
      highlightId && data.length > 0
        ? data.find(entry => entry.managerId && entry.managerId.toString() === highlightId) || null
        : null;

    res.status(200).json({
      success: true,
      division: normalizedDivision,
      managerLevel: normalizedManagerLevel,
      limit: numericLimit,
      filterApplied: filterDatePayload.isActive || teamFilterActive || zoneFilterActive,
      filterRange: filterDatePayload.isActive
        ? {
            startDate: startDateStr,
            endDate: endDateStr,
          }
        : null,
      teamFilter: teamFilterActive ? teamNameStr : null, // Team filter applied
      zoneFilter: zoneFilterActive ? zoneStr : null, // Zone filter applied
      total: data.length,
      highlight: highlightedEntry,
      data,
    });
  } catch (error) {
    console.error("Error fetching moves leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getLeaderboardDateFilters = async (req, res) => {
  try {
    const requestedStartYear = req.query.startYear ? parseInt(req.query.startYear, 10) : MIN_FILTER_YEAR;
    const nowYear = getISTDateTime().getUTCFullYear();
    const defaultEndYear = nowYear + 1;
    const requestedEndYear = req.query.endYear ? parseInt(req.query.endYear, 10) : defaultEndYear;
    const maxSpanYears =
      req.query.maxYearSpan && Number.isFinite(parseInt(req.query.maxYearSpan, 10))
        ? Math.max(1, Math.min(parseInt(req.query.maxYearSpan, 10), 20))
        : 5;

    let startYearValue = Number.isFinite(requestedStartYear) ? requestedStartYear : MIN_FILTER_YEAR;
    startYearValue = Math.max(MIN_FILTER_YEAR, startYearValue);

    let endYearValue = Number.isFinite(requestedEndYear) ? requestedEndYear : defaultEndYear;
    endYearValue = Math.max(startYearValue, endYearValue);

    const spanLimitedEndYear = Math.min(endYearValue, startYearValue + maxSpanYears - 1);
    endYearValue = spanLimitedEndYear;

    const years = [];
    for (let year = startYearValue; year <= endYearValue; year += 1) {
      const months = MONTH_NAMES.map((name, index) => ({
        month: index + 1,
        monthName: name,
        weeks: generateWeeksForMonth(year, index),
      }));
      years.push({
        year,
        months,
      });
    }

    return res.status(200).json({
      success: true,
      startYear: startYearValue,
      endYear: endYearValue,
      totalYears: years.length,
      years,
    });
  } catch (error) {
    console.error("Error generating moves leaderboard filters:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};


export const getMovesEarnedLeaderboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      division = "team",
      managerLevel = "flm",
      limit = 10,
      userRole,
      userId,
      startDate,
      endDate,
      teamName, // Filter by team name - filters leaderboard entries to show only specific team
      zone, // Filter by zone - filters leaderboard entries to show only specific zone
    } = req.query;

    const normalizedDivision = division.toString().trim().toLowerCase();
    const normalizedManagerLevel = managerLevel.toString().trim().toLowerCase();
    const normalizedUserRole = userRole ? userRole.toString().trim().toLowerCase() : null;
    const startDateStr = startDate ? startDate.toString().trim() : null;
    const endDateStr = endDate ? endDate.toString().trim() : null;
    // Team filter: decode URL encoding (e.g., "Black+Panthers" -> "Black Panthers") and trim
    const teamNameStr = teamName ? decodeURIComponent(teamName.toString().trim().replace(/\+/g, ' ')) : null;
    // Zone filter: decode URL encoding and trim
    const zoneStr = zone ? decodeURIComponent(zone.toString().trim().replace(/\+/g, ' ')) : null;

    if (normalizedDivision !== "team") {
      return res.status(400).json({
        success: false,
        message: "Moves earned leaderboard only supports division='team'. Moves, moves earned, moves lost, and kills metrics are team-level only.",
      });
    }

    if (!["flm", "slm", "tlm"].includes(normalizedManagerLevel)) {
      return res.status(400).json({
        success: false,
        message: "managerLevel must be 'flm', 'slm', or 'tlm' when division is 'team'",
      });
    }

    if ((startDateStr && !endDateStr) || (!startDateStr && endDateStr)) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required to enable filtering",
      });
    }

    let filterDatePayload = {
      isActive: false,
      startDateSql: null,
      endDateSql: null,
    };

    if (startDateStr && endDateStr) {
      const parsedStart = parseIsoDate(startDateStr, false);
      const parsedEnd = parseIsoDate(endDateStr, true);

      if (!parsedStart || !parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate and endDate must be valid dates (YYYY-MM-DD) not earlier than 2025-01-01",
        });
      }

      if (parsedStart > parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate cannot be later than endDate",
        });
      }

      filterDatePayload = {
        isActive: true,
        startDateSql: formatDateForSql(parsedStart),
        endDateSql: formatDateForSql(parsedEnd),
      };
    }

    let limitClause = "";
    let numericLimit = null;

    if (limit !== undefined && limit !== null && limit.toString().trim().toLowerCase() !== "all") {
      numericLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 1000));
      limitClause = ` LIMIT ${numericLimit}`;
    }

    let rows = [];
    let highlightId = null;

    const resolveFlmIdFromMr = async mrId => {
      if (!mrId) return null;
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [mrId]
      );
      if (mrRows.length === 0) return null;
      return mrRows[0].flmId || null;
    };

    const resolveManagerIdForFlm = async flmId => {
      if (!flmId) return { slmId: null, tlmId: null };
      const [flmRows] = await connection.execute(
        `SELECT f.slmId, s.tlmId
         FROM flms f
         LEFT JOIN slms s ON f.slmId = s.slmId
         WHERE f.flmId = ?
         LIMIT 1`,
        [flmId]
      );
      if (flmRows.length === 0) return { slmId: null, tlmId: null };
      return {
        slmId: flmRows[0].slmId || null,
        tlmId: flmRows[0].tlmId || null,
      };
    };

    if (userId) {
      if (normalizedUserRole === "flm") {
        if (normalizedManagerLevel === "flm") {
          highlightId = userId.toString().trim();
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(userId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "mr") {
        const flmId = await resolveFlmIdFromMr(userId);
        if (normalizedManagerLevel === "flm") {
          highlightId = flmId;
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(flmId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "slm") {
        highlightId = normalizedManagerLevel === "slm" ? userId.toString().trim() : null;
      } else if (normalizedUserRole === "tlm") {
        highlightId = normalizedManagerLevel === "tlm" ? userId.toString().trim() : null;
      }
    }

    // Team and zone filters: used to filter leaderboard results by team name or zone
    const teamFilterActive = !!teamNameStr;
    const zoneFilterActive = !!zoneStr;
    
    // Build WHERE clause for team and zone filters
    let teamZoneWhereClause = "";
    const teamZoneParams = [];
    if (teamFilterActive || zoneFilterActive) {
      const conditions = [];
      if (teamFilterActive) {
        if (normalizedManagerLevel === "flm") {
          conditions.push("f.teamName = ?");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.teamName = ?");
        } else {
          conditions.push("s.teamName = ?");
        }
        teamZoneParams.push(teamNameStr.trim());
      }
      if (zoneFilterActive) {
        if (normalizedManagerLevel === "flm") {
          // For FLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m WHERE m.flmId = f.flmId AND m.zone = ?)");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.zone = ?");
        } else {
          // For SLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m JOIN flms f2 ON m.flmId = f2.flmId WHERE f2.slmId = f.slmId AND m.zone = ?)");
        }
        teamZoneParams.push(zoneStr.trim());
      }
      teamZoneWhereClause = "WHERE " + conditions.join(" AND ");
    }

    const filterCteSql = buildMovesEarnedFilterCte();
    const filterParams = filterDatePayload.isActive
      ? [filterDatePayload.startDateSql, filterDatePayload.endDateSql]
      : [];

    let teamSql = "";

    if (filterDatePayload.isActive) {
      if (normalizedManagerLevel === "flm") {
        teamSql = `
          ${filterCteSql}
          SELECT
            fmem.flmId AS managerId,
            COALESCE(fmem.flmName, 'Unassigned') AS managerName,
            COALESCE(f.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(MAX(fmem.metricValue), 0) AS totalMovesEarned,
            COUNT(DISTINCT m.mrId) AS teamMembers
          FROM flmMovesEarnedMetrics fmem
          LEFT JOIN flms f ON fmem.flmId = f.flmId
          LEFT JOIN mrs m ON m.flmId = fmem.flmId
          ${teamZoneWhereClause}
          GROUP BY fmem.flmId, fmem.flmName, f.teamName
          ORDER BY totalMovesEarned DESC, managerName ASC
          ${limitClause}
        `;
      } else if (normalizedManagerLevel === "tlm") {
        teamSql = `
          ${filterCteSql}
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(t.teamName, NULL) AS teamName,
            COALESCE(t.zone, NULL) AS zone,
            COALESCE(SUM(fmem.metricValue), 0) AS totalMovesEarned,
            COUNT(fmem.flmId) AS teamMembers
          FROM flmMovesEarnedMetrics fmem
          LEFT JOIN slms s ON fmem.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
          ${teamZoneWhereClause}
          GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
          ORDER BY totalMovesEarned DESC, managerName ASC
          ${limitClause}
        `;
      } else {
        teamSql = `
          ${filterCteSql}
          SELECT
            fmem.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(s.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(SUM(fmem.metricValue), 0) AS totalMovesEarned,
            COUNT(fmem.flmId) AS teamMembers
          FROM flmMovesEarnedMetrics fmem
          LEFT JOIN slms s ON fmem.slmId = s.slmId
          LEFT JOIN flms f2 ON fmem.flmId = f2.flmId
          LEFT JOIN mrs m ON m.flmId = f2.flmId
          ${teamZoneWhereClause}
          GROUP BY fmem.slmId, s.slmName, s.teamName
          ORDER BY totalMovesEarned DESC, managerName ASC
          ${limitClause}
        `;
      }
    } else {
      if (normalizedManagerLevel === "flm") {
        teamSql = `
          SELECT
            f.flmId AS managerId,
            COALESCE(f.flmName, 'Unassigned') AS managerName,
            COALESCE(f.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(MAX(f.moves), 0) AS totalMovesEarned,
            COUNT(DISTINCT m.mrId) AS teamMembers
          FROM flms f
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.flmId, f.flmName, f.teamName
          ORDER BY totalMovesEarned DESC, managerName ASC
          ${limitClause}
        `;
      } else if (normalizedManagerLevel === "tlm") {
        teamSql = `
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(t.teamName, NULL) AS teamName,
            COALESCE(t.zone, NULL) AS zone,
            COALESCE(SUM(f.moves), 0) AS totalMovesEarned,
            COUNT(f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
          ${teamZoneWhereClause}
          GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
          ORDER BY totalMovesEarned DESC, managerName ASC
          ${limitClause}
        `;
      } else {
        teamSql = `
          SELECT
            f.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(s.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(SUM(f.moves), 0) AS totalMovesEarned,
            COUNT(f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.slmId, s.slmName, s.teamName
          ORDER BY totalMovesEarned DESC, managerName ASC
          ${limitClause}
        `;
      }
    }
    const allFilterParams = [...filterParams, ...teamZoneParams];
    [rows] = await connection.execute(teamSql, allFilterParams);

    const data = rows.map((row, index) => ({
      rank: index + 1,
      managerId: row.managerId,
      managerName: row.managerName,
      teamName: row.teamName || null,
      zone: row.zone || null, // Include zone in response for frontend filtering
      totalMovesEarned: Number(row.totalMovesEarned) || 0,
      teamMembers: Number(row.teamMembers) || 0,
      metricValue: Number(row.totalMovesEarned) || 0,
    }));

    const highlightedEntry =
      highlightId && data.length > 0
        ? data.find(entry => entry.managerId && entry.managerId.toString() === highlightId) || null
        : null;

    res.status(200).json({
      success: true,
      division: normalizedDivision,
      managerLevel: normalizedManagerLevel,
      limit: numericLimit,
      filterApplied: filterDatePayload.isActive || teamFilterActive || zoneFilterActive,
      filterRange: filterDatePayload.isActive
        ? {
            startDate: startDateStr,
            endDate: endDateStr,
          }
        : null,
      teamFilter: teamFilterActive ? teamNameStr : null, // Team filter applied
      zoneFilter: zoneFilterActive ? zoneStr : null, // Zone filter applied
      total: data.length,
      highlight: highlightedEntry,
      data,
    });
  } catch (error) {
    console.error("Error fetching moves earned leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getKillsLeaderboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      division = "team",
      managerLevel = "flm",
      limit = 10,
      userRole,
      userId,
      startDate,
      endDate,
      teamName, // Filter by team name - filters leaderboard entries to show only specific team
      zone, // Filter by zone - filters leaderboard entries to show only specific zone
    } = req.query;

    const normalizedDivision = division.toString().trim().toLowerCase();
    const normalizedManagerLevel = managerLevel.toString().trim().toLowerCase();
    const normalizedUserRole = userRole ? userRole.toString().trim().toLowerCase() : null;
    const startDateStr = startDate ? startDate.toString().trim() : null;
    const endDateStr = endDate ? endDate.toString().trim() : null;
    // Team filter: decode URL encoding (e.g., "Black+Panthers" -> "Black Panthers") and trim
    const teamNameStr = teamName ? decodeURIComponent(teamName.toString().trim().replace(/\+/g, ' ')) : null;
    // Zone filter: decode URL encoding and trim
    const zoneStr = zone ? decodeURIComponent(zone.toString().trim().replace(/\+/g, ' ')) : null;

    if (normalizedDivision !== "team") {
      return res.status(400).json({
        success: false,
        message: "Kills leaderboard only supports division='team'. Moves, moves earned, moves lost, and kills metrics are team-level only.",
      });
    }

    if (!["flm", "slm", "tlm"].includes(normalizedManagerLevel)) {
      return res.status(400).json({
        success: false,
        message: "managerLevel must be 'flm', 'slm', or 'tlm' when division is 'team'",
      });
    }

    if ((startDateStr && !endDateStr) || (!startDateStr && endDateStr)) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required to enable filtering",
      });
    }

    let filterDatePayload = {
      isActive: false,
      startDateSql: null,
      endDateSql: null,
    };

    if (startDateStr && endDateStr) {
      const parsedStart = parseIsoDate(startDateStr, false);
      const parsedEnd = parseIsoDate(endDateStr, true);

      if (!parsedStart || !parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate and endDate must be valid dates (YYYY-MM-DD) not earlier than 2025-01-01",
        });
      }

      if (parsedStart > parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate cannot be later than endDate",
        });
      }

      filterDatePayload = {
        isActive: true,
        startDateSql: formatDateForSql(parsedStart),
        endDateSql: formatDateForSql(parsedEnd),
      };
    }

    let limitClause = "";
    let numericLimit = null;

    if (limit !== undefined && limit !== null && limit.toString().trim().toLowerCase() !== "all") {
      numericLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 1000));
      limitClause = ` LIMIT ${numericLimit}`;
    }

    let rows = [];
    let highlightId = null;

    const resolveFlmIdFromMr = async mrId => {
      if (!mrId) return null;
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [mrId]
      );
      if (mrRows.length === 0) return null;
      return mrRows[0].flmId || null;
    };

    const resolveManagerIdForFlm = async flmId => {
      if (!flmId) return { slmId: null, tlmId: null };
      const [flmRows] = await connection.execute(
        `SELECT f.slmId, s.tlmId
         FROM flms f
         LEFT JOIN slms s ON f.slmId = s.slmId
         WHERE f.flmId = ?
         LIMIT 1`,
        [flmId]
      );
      if (flmRows.length === 0) return { slmId: null, tlmId: null };
      return {
        slmId: flmRows[0].slmId || null,
        tlmId: flmRows[0].tlmId || null,
      };
    };

    if (userId) {
      if (normalizedUserRole === "flm") {
        if (normalizedManagerLevel === "flm") {
          highlightId = userId.toString().trim();
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(userId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "mr") {
        const flmId = await resolveFlmIdFromMr(userId);
        if (normalizedManagerLevel === "flm") {
          highlightId = flmId;
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(flmId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "slm") {
        highlightId = normalizedManagerLevel === "slm" ? userId.toString().trim() : null;
      } else if (normalizedUserRole === "tlm") {
        highlightId = normalizedManagerLevel === "tlm" ? userId.toString().trim() : null;
      }
    }

    // Team and zone filters: used to filter leaderboard results by team name or zone
    const teamFilterActive = !!teamNameStr;
    const zoneFilterActive = !!zoneStr;
    
    // Build WHERE clause for team and zone filters
    let teamZoneWhereClause = "";
    const teamZoneParams = [];
    if (teamFilterActive || zoneFilterActive) {
      const conditions = [];
      if (teamFilterActive) {
        if (normalizedManagerLevel === "flm") {
          conditions.push("f.teamName = ?");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.teamName = ?");
        } else {
          conditions.push("s.teamName = ?");
        }
        teamZoneParams.push(teamNameStr.trim());
      }
      if (zoneFilterActive) {
        if (normalizedManagerLevel === "flm") {
          // For FLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m WHERE m.flmId = f.flmId AND m.zone = ?)");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.zone = ?");
        } else {
          // For SLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m JOIN flms f2 ON m.flmId = f2.flmId WHERE f2.slmId = f.slmId AND m.zone = ?)");
        }
        teamZoneParams.push(zoneStr.trim());
      }
      teamZoneWhereClause = "WHERE " + conditions.join(" AND ");
    }

    const filterCteSql = buildKillsFilterCte();
    const filterParams = filterDatePayload.isActive
      ? [filterDatePayload.startDateSql, filterDatePayload.endDateSql]
      : [];

    let teamSql = "";

    if (filterDatePayload.isActive) {
      if (normalizedManagerLevel === "flm") {
        teamSql = `
          ${filterCteSql}
          SELECT
            fkm.flmId AS managerId,
            COALESCE(fkm.flmName, 'Unassigned') AS managerName,
            COALESCE(f.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(MAX(fkm.metricValue), 0) AS totalKills,
            COUNT(DISTINCT m.mrId) AS teamMembers
          FROM flmKillMetrics fkm
          LEFT JOIN flms f ON fkm.flmId = f.flmId
          LEFT JOIN mrs m ON m.flmId = fkm.flmId
          ${teamZoneWhereClause}
          GROUP BY fkm.flmId, fkm.flmName, f.teamName
          ORDER BY totalKills DESC, managerName ASC
          ${limitClause}
        `;
      } else if (normalizedManagerLevel === "tlm") {
        teamSql = `
          ${filterCteSql}
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(t.teamName, NULL) AS teamName,
            COALESCE(t.zone, NULL) AS zone,
            COALESCE(SUM(fkm.metricValue), 0) AS totalKills,
            COUNT(fkm.flmId) AS teamMembers
          FROM flmKillMetrics fkm
          LEFT JOIN slms s ON fkm.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
          ${teamZoneWhereClause}
          GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
          ORDER BY totalKills DESC, managerName ASC
          ${limitClause}
        `;
      } else {
        teamSql = `
          ${filterCteSql}
          SELECT
            fkm.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(s.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(SUM(fkm.metricValue), 0) AS totalKills,
            COUNT(fkm.flmId) AS teamMembers
          FROM flmKillMetrics fkm
          LEFT JOIN slms s ON fkm.slmId = s.slmId
          LEFT JOIN flms f2 ON fkm.flmId = f2.flmId
          LEFT JOIN mrs m ON m.flmId = f2.flmId
          ${teamZoneWhereClause}
          GROUP BY fkm.slmId, s.slmName, s.teamName
          ORDER BY totalKills DESC, managerName ASC
          ${limitClause}
        `;
      }
    } else {
      if (normalizedManagerLevel === "flm") {
        teamSql = `
          SELECT
            f.flmId AS managerId,
            COALESCE(f.flmName, 'Unassigned') AS managerName,
            COALESCE(f.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(MAX(f.kills), 0) AS totalKills,
            COUNT(DISTINCT m.mrId) AS teamMembers
          FROM flms f
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.flmId, f.flmName, f.teamName
          ORDER BY totalKills DESC, managerName ASC
          ${limitClause}
        `;
      } else if (normalizedManagerLevel === "tlm") {
        teamSql = `
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(t.teamName, NULL) AS teamName,
            COALESCE(t.zone, NULL) AS zone,
            COALESCE(SUM(f.kills), 0) AS totalKills,
            COUNT(f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
          ${teamZoneWhereClause}
          GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
          ORDER BY totalKills DESC, managerName ASC
          ${limitClause}
        `;
      } else {
        teamSql = `
          SELECT
            f.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(s.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COALESCE(SUM(f.kills), 0) AS totalKills,
            COUNT(f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.slmId, s.slmName, s.teamName
          ORDER BY totalKills DESC, managerName ASC
          ${limitClause}
        `;
      }
    }
    const allFilterParams = [...filterParams, ...teamZoneParams];
    [rows] = await connection.execute(teamSql, allFilterParams);

    const data = rows.map((row, index) => ({
      rank: index + 1,
      managerId: row.managerId,
      managerName: row.managerName,
      teamName: row.teamName || null,
      zone: row.zone || null, // Include zone in response for frontend filtering
      totalKills: Number(row.totalKills) || 0,
      teamMembers: Number(row.teamMembers) || 0,
      metricValue: Number(row.totalKills) || 0,
    }));

    const highlightedEntry =
      highlightId && data.length > 0
        ? data.find(entry => entry.managerId && entry.managerId.toString() === highlightId) || null
        : null;

    res.status(200).json({
      success: true,
      division: normalizedDivision,
      managerLevel: normalizedManagerLevel,
      limit: numericLimit,
      filterApplied: filterDatePayload.isActive || teamFilterActive || zoneFilterActive,
      filterRange: filterDatePayload.isActive
        ? {
            startDate: startDateStr,
            endDate: endDateStr,
          }
        : null,
      teamFilter: teamFilterActive ? teamNameStr : null, // Team filter applied
      zoneFilter: zoneFilterActive ? zoneStr : null, // Zone filter applied
      total: data.length,
      highlight: highlightedEntry,
      data,
    });
  } catch (error) {
    console.error("Error fetching kills leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getMovesLostLeaderboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      division = "team",
      managerLevel = "flm",
      limit = 10,
      userRole,
      userId,
      startDate,
      endDate,
      teamName, // Filter by team name - filters leaderboard entries to show only specific team
      zone, // Filter by zone - filters leaderboard entries to show only specific zone
    } = req.query;

    const normalizedDivision = division.toString().trim().toLowerCase();
    const normalizedManagerLevel = managerLevel.toString().trim().toLowerCase();
    const normalizedUserRole = userRole ? userRole.toString().trim().toLowerCase() : null;
    const startDateStr = startDate ? startDate.toString().trim() : null;
    const endDateStr = endDate ? endDate.toString().trim() : null;
    // Team filter: decode URL encoding (e.g., "Black+Panthers" -> "Black Panthers") and trim
    const teamNameStr = teamName ? decodeURIComponent(teamName.toString().trim().replace(/\+/g, ' ')) : null;
    // Zone filter: decode URL encoding and trim
    const zoneStr = zone ? decodeURIComponent(zone.toString().trim().replace(/\+/g, ' ')) : null;

    if (normalizedDivision !== "team") {
      return res.status(400).json({
        success: false,
        message: "Moves lost leaderboard only supports division='team'. Moves, moves earned, moves lost, and kills metrics are team-level only.",
      });
    }

    if (!["flm", "slm", "tlm"].includes(normalizedManagerLevel)) {
      return res.status(400).json({
        success: false,
        message: "managerLevel must be 'flm', 'slm', or 'tlm' when division is 'team'",
      });
    }

    if ((startDateStr && !endDateStr) || (!startDateStr && endDateStr)) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required to enable filtering",
      });
    }

    let filterDatePayload = {
      isActive: false,
      startDateSql: null,
      endDateSql: null,
    };

    if (startDateStr && endDateStr) {
      const parsedStart = parseIsoDate(startDateStr, false);
      const parsedEnd = parseIsoDate(endDateStr, true);

      if (!parsedStart || !parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate and endDate must be valid dates (YYYY-MM-DD) not earlier than 2025-01-01",
        });
      }

      if (parsedStart > parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate cannot be later than endDate",
        });
      }

      filterDatePayload = {
        isActive: true,
        startDateSql: formatDateForSql(parsedStart),
        endDateSql: formatDateForSql(parsedEnd),
      };
    }

    let limitClause = "";
    let numericLimit = null;

    if (limit !== undefined && limit !== null && limit.toString().trim().toLowerCase() !== "all") {
      numericLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 1000));
      limitClause = ` LIMIT ${numericLimit}`;
    }

    let rows = [];
    let highlightId = null;

    const resolveFlmIdFromMr = async mrId => {
      if (!mrId) return null;
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [mrId]
      );
      if (mrRows.length === 0) return null;
      return mrRows[0].flmId || null;
    };

    const resolveManagerIdForFlm = async flmId => {
      if (!flmId) return { slmId: null, tlmId: null };
      const [flmRows] = await connection.execute(
        `SELECT f.slmId, s.tlmId
         FROM flms f
         LEFT JOIN slms s ON f.slmId = s.slmId
         WHERE f.flmId = ?
         LIMIT 1`,
        [flmId]
      );
      if (flmRows.length === 0) return { slmId: null, tlmId: null };
      return {
        slmId: flmRows[0].slmId || null,
        tlmId: flmRows[0].tlmId || null,
      };
    };

    if (userId) {
      if (normalizedUserRole === "flm") {
        if (normalizedManagerLevel === "flm") {
          highlightId = userId.toString().trim();
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(userId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "mr") {
        const flmId = await resolveFlmIdFromMr(userId);
        if (normalizedManagerLevel === "flm") {
          highlightId = flmId;
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(flmId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "slm") {
        highlightId = normalizedManagerLevel === "slm" ? userId.toString().trim() : null;
      } else if (normalizedUserRole === "tlm") {
        highlightId = normalizedManagerLevel === "tlm" ? userId.toString().trim() : null;
      }
    }

    // Team and zone filters: used to filter leaderboard results by team name or zone
    const teamFilterActive = !!teamNameStr;
    const zoneFilterActive = !!zoneStr;
    
    // Build WHERE clause for team and zone filters
    let teamZoneWhereClause = "";
    const teamZoneParams = [];
    if (teamFilterActive || zoneFilterActive) {
      const conditions = [];
      if (teamFilterActive) {
        if (normalizedManagerLevel === "flm") {
          conditions.push("f.teamName = ?");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.teamName = ?");
        } else {
          conditions.push("s.teamName = ?");
        }
        teamZoneParams.push(teamNameStr.trim());
      }
      if (zoneFilterActive) {
        if (normalizedManagerLevel === "flm") {
          // For FLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m WHERE m.flmId = f.flmId AND m.zone = ?)");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.zone = ?");
        } else {
          // For SLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m JOIN flms f2 ON m.flmId = f2.flmId WHERE f2.slmId = f.slmId AND m.zone = ?)");
        }
        teamZoneParams.push(zoneStr.trim());
      }
      teamZoneWhereClause = "WHERE " + conditions.join(" AND ");
    }

    const movesLostCteSql = buildMovesLostFilterCte(filterDatePayload.isActive);
    const filterParams = filterDatePayload.isActive
      ? [filterDatePayload.startDateSql, filterDatePayload.endDateSql]
      : [];

    let teamSql = "";

    if (normalizedManagerLevel === "flm") {
      teamSql = `
        ${movesLostCteSql}
        SELECT
          fmlm.flmId AS managerId,
          COALESCE(fmlm.flmName, 'Unassigned') AS managerName,
          COALESCE(f.teamName, NULL) AS teamName,
          COALESCE(MAX(m.zone), NULL) AS zone,
          COALESCE(MAX(fmlm.metricValue), 0) AS totalMovesLost,
          COUNT(DISTINCT m.mrId) AS teamMembers
        FROM flmMovesLostMetrics fmlm
        LEFT JOIN flms f ON fmlm.flmId = f.flmId
        LEFT JOIN mrs m ON m.flmId = fmlm.flmId
        ${teamZoneWhereClause}
        GROUP BY fmlm.flmId, fmlm.flmName, f.teamName
        ORDER BY totalMovesLost DESC, managerName ASC
        ${limitClause}
      `;
    } else if (normalizedManagerLevel === "tlm") {
      teamSql = `
        ${movesLostCteSql}
        SELECT
          s.tlmId AS managerId,
          COALESCE(t.tlmName, 'Unassigned') AS managerName,
          COALESCE(t.teamName, NULL) AS teamName,
          COALESCE(t.zone, NULL) AS zone,
          COALESCE(SUM(fmlm.metricValue), 0) AS totalMovesLost,
          COUNT(fmlm.flmId) AS teamMembers
        FROM flmMovesLostMetrics fmlm
        LEFT JOIN slms s ON fmlm.slmId = s.slmId
        LEFT JOIN tlms t ON s.tlmId = t.tlmId
        ${teamZoneWhereClause}
        GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
        ORDER BY totalMovesLost DESC, managerName ASC
        ${limitClause}
      `;
    } else {
      teamSql = `
        ${movesLostCteSql}
        SELECT
          fmlm.slmId AS managerId,
          COALESCE(s.slmName, 'Unassigned') AS managerName,
          COALESCE(s.teamName, NULL) AS teamName,
          COALESCE(MAX(m.zone), NULL) AS zone,
          COALESCE(SUM(fmlm.metricValue), 0) AS totalMovesLost,
          COUNT(fmlm.flmId) AS teamMembers
        FROM flmMovesLostMetrics fmlm
        LEFT JOIN slms s ON fmlm.slmId = s.slmId
        LEFT JOIN flms f2 ON fmlm.flmId = f2.flmId
        LEFT JOIN mrs m ON m.flmId = f2.flmId
        ${teamZoneWhereClause}
        GROUP BY fmlm.slmId, s.slmName, s.teamName
        ORDER BY totalMovesLost DESC, managerName ASC
        ${limitClause}
      `;
    }
    const allFilterParams = [...filterParams, ...teamZoneParams];
    [rows] = await connection.execute(teamSql, allFilterParams);

    const data = rows.map((row, index) => ({
      rank: index + 1,
      managerId: row.managerId,
      managerName: row.managerName,
      teamName: row.teamName || null,
      zone: row.zone || null, // Include zone in response for frontend filtering
      totalMovesLost: Number(row.totalMovesLost) || 0,
      teamMembers: Number(row.teamMembers) || 0,
      metricValue: Number(row.totalMovesLost) || 0,
    }));

    const highlightedEntry =
      highlightId && data.length > 0
        ? data.find(entry => entry.managerId && entry.managerId.toString() === highlightId) || null
        : null;

    res.status(200).json({
      success: true,
      division: normalizedDivision,
      managerLevel: normalizedManagerLevel,
      limit: numericLimit,
      filterApplied: filterDatePayload.isActive || teamFilterActive || zoneFilterActive,
      filterRange: filterDatePayload.isActive
        ? {
            startDate: startDateStr,
            endDate: endDateStr,
          }
        : null,
      teamFilter: teamFilterActive ? teamNameStr : null, // Team filter applied
      zoneFilter: zoneFilterActive ? zoneStr : null, // Zone filter applied
      total: data.length,
      highlight: highlightedEntry,
      data,
    });
  } catch (error) {
    console.error("Error fetching moves lost leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

const MAX_LEADERBOARD_RANGE_DAYS = 7;

const parseDateRange = ({ startDate, endDate }) => {
  const end = endDate ? new Date(endDate) : new Date();
  if (Number.isNaN(end.getTime())) throw new Error("Invalid endDate");

  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid startDate");

  if (end < start) throw new Error("endDate must be greater than or equal to startDate");

  const diffDays = (end - start) / (1000 * 60 * 60 * 24);
  if (diffDays > MAX_LEADERBOARD_RANGE_DAYS) {
    throw new Error(`Date range cannot exceed ${MAX_LEADERBOARD_RANGE_DAYS} days`);
  }

  return {
    start,
    end,
    startSql: formatISTDateTimeForSQL(start),
    endSql: formatISTDateTimeForSQL(end),
  };
};

export const getMrPointsLeaderboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      limit = 10,
      userId,
      userRole,
      startDate,
      endDate,
      brandId,
      brandName,
      teamName, // Filter by team name - filters leaderboard entries to show only specific team
      zone, // Filter by zone - filters leaderboard entries to show only specific zone
    } = req.query;

    const startDateStr = startDate ? startDate.toString().trim() : null;
    const endDateStr = endDate ? endDate.toString().trim() : null;
    const brandIdStr = brandId ? brandId.toString().trim() : null;
    const brandNameStr = brandName ? brandName.toString().trim() : null;
    // Team filter: decode URL encoding (e.g., "Black+Panthers" -> "Black Panthers") and trim
    const teamNameStr = teamName ? decodeURIComponent(teamName.toString().trim().replace(/\+/g, ' ')) : null;
    // Zone filter: decode URL encoding and trim
    const zoneStr = zone ? decodeURIComponent(zone.toString().trim().replace(/\+/g, ' ')) : null;
    const normalizedUserRole = userRole ? userRole.toString().trim().toLowerCase() : null;

    if ((startDateStr && !endDateStr) || (!startDateStr && endDateStr)) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required to enable date filtering",
      });
    }

    let filterDatePayload = {
      isActive: false,
      startDateSql: null,
      endDateSql: null,
    };

    if (startDateStr && endDateStr) {
      const parsedStart = parseIsoDate(startDateStr, false);
      const parsedEnd = parseIsoDate(endDateStr, true);

      if (!parsedStart || !parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate and endDate must be valid dates (YYYY-MM-DD) not earlier than 2025-01-01",
        });
      }

      if (parsedStart > parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate cannot be later than endDate",
        });
      }

      filterDatePayload = {
        isActive: true,
        startDateSql: formatDateForSql(parsedStart),
        endDateSql: formatDateForSql(parsedEnd),
      };
    }

    let limitClause = "";
    let numericLimit = null;

    if (limit !== undefined && limit !== null && limit.toString().trim().toLowerCase() !== "all") {
      numericLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 1000));
      limitClause = ` LIMIT ${numericLimit}`;
    }

    const resolveFlmIdFromMr = async mrId => {
      if (!mrId) return null;
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [mrId]
      );
      if (mrRows.length === 0) return null;
      return mrRows[0].flmId || null;
    };

    let highlightMrIds = [];
    let highlightFlmId = null;

    if (userId) {
      if (normalizedUserRole === "flm") {
        highlightFlmId = userId.toString().trim();
        const [mrRows] = await connection.execute(
          `SELECT mrId FROM mrs WHERE flmId = ?`,
          [highlightFlmId]
        );
        highlightMrIds = mrRows.map(row => row.mrId);
      } else if (normalizedUserRole === "mr") {
        highlightMrIds = [userId.toString().trim()];
      }
    }

    const brandFilter = brandIdStr ? { brandId: brandIdStr } : brandNameStr ? { brandName: brandNameStr } : null;
    const brandFilterActive = !!brandFilter;
    
    // Team and zone filters: used to filter leaderboard results by team name or zone
    // These filters allow users to view leaderboard entries for a specific team or zone
    const teamFilterActive = !!teamNameStr;
    const zoneFilterActive = !!zoneStr;
    
    // If brand filter is active, we need to query uploads table even without date filter
    const needsUploadsQuery = filterDatePayload.isActive || brandFilterActive;
    
    // Build WHERE clause for team and zone filters in player division
    // Define playerTeamZoneParams outside if/else blocks for proper scope
    // Note: Using direct column comparison (no LOWER/TRIM on columns) for better performance
    // MySQL's utf8mb4_0900_ai_ci collation is already case-insensitive
    let playerTeamZoneWhereClause = "";
    const playerTeamZoneParams = [];
    if (teamFilterActive || zoneFilterActive) {
      const conditions = [];
      if (teamFilterActive) {
        // Direct column comparison - MySQL collation handles case-insensitivity
        conditions.push("m.teamName = ?");
        playerTeamZoneParams.push(teamNameStr.trim());
      }
      if (zoneFilterActive) {
        // Direct column comparison - MySQL collation handles case-insensitivity
        conditions.push("m.zone = ?");
        playerTeamZoneParams.push(zoneStr.trim());
      }
      playerTeamZoneWhereClause = "WHERE " + conditions.join(" AND ");
    }
    
    let playerSql = "";
    let filterParams = [];
    
    if (needsUploadsQuery) {
      let brandWhereClause = "";
      if (brandFilter && brandFilter.brandId) {
        brandWhereClause = " AND JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandId')) = ?";
      } else if (brandFilter && brandFilter.brandName) {
        brandWhereClause = " AND JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandName')) = ?";
      }
      
      const dateWhereClause = filterDatePayload.isActive ? "AND p.reviewDate BETWEEN ? AND ?" : "";
      
      // Always include all upload types (prescription, pob, camp)
      const typeWhereClause = "AND p.type IN ('prescription', 'pob', 'camp')";
      
      // For CTE queries, convert WHERE to AND for the first CTE
      // If playerTeamZoneWhereClause is empty, keep it empty; otherwise convert WHERE to AND
      const playerTeamZoneWhereClauseForCte = playerTeamZoneWhereClause 
        ? playerTeamZoneWhereClause.replace("WHERE", "AND")
        : "";
      
      const mrFilterCteSql = `
        WITH filteredMrPoints AS (
          SELECT
            m.mrId,
            SUM(p.points) AS totalPoints
          FROM uploads p
          JOIN mrs m ON p.mrId = m.mrId
          WHERE p.status = 'approved'
            AND p.isCalculated = 1
            ${typeWhereClause}
            ${dateWhereClause}
            ${brandWhereClause}
            ${playerTeamZoneWhereClauseForCte}
          GROUP BY m.mrId
        ),
        mrPointMetrics AS (
          SELECT
            m.mrId,
            COALESCE(m.mrName, 'Unassigned') AS mrName,
            COALESCE(m.teamName, NULL) AS teamName,
            COALESCE(m.zone, NULL) AS zone,
            COALESCE(fmp.totalPoints, 0) AS metricValue
          FROM mrs m
          LEFT JOIN filteredMrPoints fmp ON fmp.mrId = m.mrId
          ${playerTeamZoneWhereClause}
        )
      `;
      playerSql = `
        ${mrFilterCteSql}
        SELECT
          mpm.mrId AS playerId,
          mpm.mrName AS playerName,
          mpm.teamName AS teamName,
          mpm.zone AS zone,
          mpm.metricValue AS totalPoints
        FROM mrPointMetrics mpm
        ORDER BY totalPoints DESC, playerName ASC
        ${limitClause}
      `;
      
      // Build filter parameters
      if (filterDatePayload.isActive) {
        filterParams.push(filterDatePayload.startDateSql, filterDatePayload.endDateSql);
      }
      
      // Add brand filter parameter if present
      if (brandFilter) {
        if (brandFilter.brandId) {
          filterParams.push(brandFilter.brandId);
        } else if (brandFilter.brandName) {
          filterParams.push(brandFilter.brandName);
        }
      }
      
      // Combine filter params with team/zone params for player division
      // Note: When needsUploadsQuery is true, team/zone params are used twice (once in each CTE)
      // So we need to duplicate them in the params array
      filterParams = [...filterParams, ...playerTeamZoneParams, ...playerTeamZoneParams];
    } else {
      // When not using uploads query, use the playerTeamZoneWhereClause already defined above
      playerSql = `
      SELECT
        m.mrId AS playerId,
        COALESCE(m.mrName, 'Unassigned') AS playerName,
          COALESCE(m.teamName, NULL) AS teamName,
          COALESCE(m.zone, NULL) AS zone,
          COALESCE(m.points, 0) AS totalPoints
      FROM mrs m
        ${playerTeamZoneWhereClause}
      ORDER BY totalPoints DESC, playerName ASC
      ${limitClause}
    `;
      // Combine filter params with team/zone params for player division
      filterParams = [...filterParams, ...playerTeamZoneParams];
    }

    const [rows] = await connection.execute(playerSql, filterParams);

    const data = rows.map((row, index) => {
      const mrId = row.playerId;
      const isHighlighted = highlightMrIds.length > 0 && highlightMrIds.includes(mrId);
      return {
      rank: index + 1,
        mrId: mrId,
      mrName: row.playerName,
        teamName: row.teamName || null,
        zone: row.zone || null, // Include zone in response for frontend filtering
      totalPoints: Number(row.totalPoints) || 0,
      metricValue: Number(row.totalPoints) || 0,
        isHighlighted: isHighlighted,
      };
    });

    let highlightedEntry = null;
    if (highlightMrIds.length > 0 && data.length > 0) {
      const highlightedEntries = data.filter(entry => entry.isHighlighted);
      if (highlightedEntries.length > 0) {
        if (normalizedUserRole === "flm" && highlightFlmId) {
          highlightedEntry = highlightedEntries.reduce((best, current) => 
            current.rank < best.rank ? current : best
          );
        } else if (normalizedUserRole === "mr") {
          highlightedEntry = highlightedEntries[0];
        } else {
          highlightedEntry = highlightedEntries.length === 1 ? highlightedEntries[0] : highlightedEntries;
        }
      }
    }

    res.status(200).json({
      success: true,
      division: "player",
      managerLevel: null,
      limit: numericLimit,
      filterApplied: filterDatePayload.isActive || !!brandFilter || teamFilterActive || zoneFilterActive,
      filterRange: filterDatePayload.isActive
        ? {
            startDate: startDateStr,
            endDate: endDateStr,
          }
        : null,
      brandFilter: brandFilter || null,
      teamFilter: teamFilterActive ? teamNameStr : null, // Team filter applied
      zoneFilter: zoneFilterActive ? zoneStr : null, // Zone filter applied
      total: data.length,
      highlight: highlightedEntry,
      data,
    });
  } catch (error) {
    console.error("Error fetching MR points leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getDiceRollBalanceLeaderboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      division = "player",
      managerLevel = "flm",
      limit = 10,
      userRole,
      userId,
      startDate,
      endDate,
      teamName, // Filter by team name - filters leaderboard entries to show only specific team
      zone, // Filter by zone - filters leaderboard entries to show only specific zone
    } = req.query;

    const normalizedDivision = division.toString().trim().toLowerCase();
    const normalizedManagerLevel = managerLevel.toString().trim().toLowerCase();
    const normalizedUserRole = userRole ? userRole.toString().trim().toLowerCase() : null;
    const startDateStr = startDate ? startDate.toString().trim() : null;
    const endDateStr = endDate ? endDate.toString().trim() : null;
    // Team filter: decode URL encoding (e.g., "Atomic+Cobras" -> "Atomic Cobras") and trim
    const teamNameStr = teamName ? decodeURIComponent(teamName.toString().trim().replace(/\+/g, ' ')) : null;
    // Zone filter: decode URL encoding and trim
    const zoneStr = zone ? decodeURIComponent(zone.toString().trim().replace(/\+/g, ' ')) : null;

    if (!["team", "player"].includes(normalizedDivision)) {
      return res.status(400).json({
        success: false,
        message: "division must be either 'team' or 'player'",
      });
    }

    if (normalizedDivision === "team" && !["flm", "slm", "tlm"].includes(normalizedManagerLevel)) {
      return res.status(400).json({
        success: false,
        message: "managerLevel must be 'flm', 'slm' or 'tlm' when division is 'team'",
      });
    }

    if ((startDateStr && !endDateStr) || (!startDateStr && endDateStr)) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required to enable filtering",
      });
    }

    let filterDatePayload = {
      isActive: false,
      startDateSql: null,
      endDateSql: null,
    };

    if (startDateStr && endDateStr) {
      const parsedStart = parseIsoDate(startDateStr, false);
      const parsedEnd = parseIsoDate(endDateStr, true);

      if (!parsedStart || !parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate and endDate must be valid dates (YYYY-MM-DD) not earlier than 2025-01-01",
        });
      }

      if (parsedStart > parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate cannot be later than endDate",
        });
      }

      filterDatePayload = {
        isActive: true,
        startDateSql: formatDateForSql(parsedStart),
        endDateSql: formatDateForSql(parsedEnd),
      };
    }

    let limitClause = "";
    let numericLimit = null;

    if (limit !== undefined && limit !== null && limit.toString().trim().toLowerCase() !== "all") {
      numericLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 1000));
      limitClause = ` LIMIT ${numericLimit}`;
    }

    // Team and zone filters: used to filter leaderboard results by team name or zone
    // These filters allow users to view leaderboard entries for a specific team or zone
    const teamFilterActive = !!teamNameStr;
    const zoneFilterActive = !!zoneStr;

    let rows = [];
    let highlightId = null;
    let highlightMrIds = [];
    let highlightFlmId = null;

    const resolveFlmIdFromMr = async mrId => {
      if (!mrId) return null;
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [mrId]
      );
      if (mrRows.length === 0) return null;
      return mrRows[0].flmId || null;
    };

    const resolveManagerIdForFlm = async flmId => {
      if (!flmId) return { slmId: null, tlmId: null };
      const [flmRows] = await connection.execute(
        `SELECT f.slmId, s.tlmId
         FROM flms f
         LEFT JOIN slms s ON f.slmId = s.slmId
         WHERE f.flmId = ?
         LIMIT 1`,
        [flmId]
      );
      if (flmRows.length === 0) return { slmId: null, tlmId: null };
      return {
        slmId: flmRows[0].slmId || null,
        tlmId: flmRows[0].tlmId || null,
      };
    };

    if (userId) {
      if (normalizedDivision === "player") {
        if (normalizedUserRole === "flm") {
          highlightFlmId = userId.toString().trim();
          const [mrRows] = await connection.execute(
            `SELECT mrId FROM mrs WHERE flmId = ?`,
            [highlightFlmId]
          );
          highlightMrIds = mrRows.map(row => row.mrId);
        } else if (normalizedUserRole === "mr") {
          highlightMrIds = [userId.toString().trim()];
        }
      } else {
        if (normalizedUserRole === "flm") {
          if (normalizedManagerLevel === "flm") {
            highlightId = userId.toString().trim();
          } else {
            const { slmId, tlmId } = await resolveManagerIdForFlm(userId);
            highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
          }
        } else if (normalizedUserRole === "mr") {
          const flmId = await resolveFlmIdFromMr(userId);
          if (normalizedManagerLevel === "flm") {
            highlightId = flmId;
          } else {
            const { slmId, tlmId } = await resolveManagerIdForFlm(flmId);
            highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
          }
        } else if (normalizedUserRole === "slm") {
          highlightId = normalizedManagerLevel === "slm" ? userId.toString().trim() : null;
        } else if (normalizedUserRole === "tlm") {
          highlightId = normalizedManagerLevel === "tlm" ? userId.toString().trim() : null;
        }
      }
    }

    if (normalizedDivision === "team") {
      let teamSql = "";
      let teamParams = [];
      
      // Build WHERE clause for team and zone filters
      let teamZoneWhereClause = "";
      const teamZoneParams = [];
      if (teamFilterActive || zoneFilterActive) {
        const conditions = [];
        if (teamFilterActive) {
          if (normalizedManagerLevel === "flm") {
            conditions.push("f.teamName = ?");
          } else if (normalizedManagerLevel === "tlm") {
            conditions.push("t.teamName = ?");
          } else {
            conditions.push("s.teamName = ?");
          }
          teamZoneParams.push(teamNameStr.trim());
        }
        if (zoneFilterActive) {
          if (normalizedManagerLevel === "flm") {
            // For FLM level, check zone from MRs
            conditions.push("EXISTS (SELECT 1 FROM mrs m WHERE m.flmId = f.flmId AND m.zone = ?)");
          } else if (normalizedManagerLevel === "tlm") {
            conditions.push("t.zone = ?");
          } else {
            // For SLM level, check zone from MRs
            conditions.push("EXISTS (SELECT 1 FROM mrs m JOIN flms f2 ON m.flmId = f2.flmId WHERE f2.slmId = f.slmId AND m.zone = ?)");
          }
          teamZoneParams.push(zoneStr.trim());
        }
        teamZoneWhereClause = "WHERE " + conditions.join(" AND ");
      }

      if (filterDatePayload.isActive) {
        const cte = buildDiceRollBalanceFilterCte();
        if (normalizedManagerLevel === "flm") {
          teamSql = `
            ${cte}
            SELECT
              fdm.flmId AS managerId,
              COALESCE(fdm.flmName, 'Unassigned') AS managerName,
              COALESCE(f.teamName, NULL) AS teamName,
              COALESCE(f.zone, NULL) AS zone,
              COALESCE(fdm.metricValue, 0) AS totalDiceRollBalance,
              1 AS teamMembers
            FROM flmDiceRollMetrics fdm
            LEFT JOIN flms f ON fdm.flmId = f.flmId
            ${teamZoneWhereClause}
            ORDER BY totalDiceRollBalance DESC, managerName ASC
            ${limitClause}
          `;
        } else if (normalizedManagerLevel === "tlm") {
          teamSql = `
            ${cte}
            SELECT
              s.tlmId AS managerId,
              COALESCE(t.tlmName, 'Unassigned') AS managerName,
              COALESCE(t.teamName, NULL) AS teamName,
              COALESCE(t.zone, NULL) AS zone,
              COALESCE(SUM(fdm.metricValue), 0) AS totalDiceRollBalance,
              COUNT(fdm.flmId) AS teamMembers
            FROM flmDiceRollMetrics fdm
            LEFT JOIN flms f ON fdm.flmId = f.flmId
            LEFT JOIN slms s ON f.slmId = s.slmId
            LEFT JOIN tlms t ON s.tlmId = t.tlmId
            ${teamZoneWhereClause}
            GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
            ORDER BY totalDiceRollBalance DESC, managerName ASC
            ${limitClause}
          `;
        } else {
          teamSql = `
            ${cte}
            SELECT
              f.slmId AS managerId,
              COALESCE(s.slmName, 'Unassigned') AS managerName,
              COALESCE(s.teamName, NULL) AS teamName,
              COALESCE(s.zone, NULL) AS zone,
              COALESCE(SUM(fdm.metricValue), 0) AS totalDiceRollBalance,
              COUNT(fdm.flmId) AS teamMembers
            FROM flmDiceRollMetrics fdm
            LEFT JOIN flms f ON fdm.flmId = f.flmId
            LEFT JOIN slms s ON f.slmId = s.slmId
            ${teamZoneWhereClause}
            GROUP BY f.slmId, s.slmName, s.teamName, s.zone
            ORDER BY totalDiceRollBalance DESC, managerName ASC
            ${limitClause}
          `;
        }
        teamParams = [filterDatePayload.startDateSql, filterDatePayload.endDateSql, ...teamZoneParams];
      } else {
        if (normalizedManagerLevel === "flm") {
          teamSql = `
            SELECT
              f.flmId AS managerId,
              COALESCE(f.flmName, 'Unassigned') AS managerName,
              COALESCE(f.teamName, NULL) AS teamName,
              COALESCE(f.zone, NULL) AS zone,
              COALESCE(f.currentDiceRollBalance, 0) AS totalDiceRollBalance,
              1 AS teamMembers
            FROM flms f
            ${teamZoneWhereClause}
            ORDER BY totalDiceRollBalance DESC, managerName ASC
            ${limitClause}
          `;
        } else if (normalizedManagerLevel === "tlm") {
          teamSql = `
            SELECT
              s.tlmId AS managerId,
              COALESCE(t.tlmName, 'Unassigned') AS managerName,
              COALESCE(t.teamName, NULL) AS teamName,
              COALESCE(t.zone, NULL) AS zone,
              COALESCE(SUM(f.currentDiceRollBalance), 0) AS totalDiceRollBalance,
              COUNT(f.flmId) AS teamMembers
            FROM flms f
            LEFT JOIN slms s ON f.slmId = s.slmId
            LEFT JOIN tlms t ON s.tlmId = t.tlmId
            ${teamZoneWhereClause}
            GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
            ORDER BY totalDiceRollBalance DESC, managerName ASC
            ${limitClause}
          `;
        } else {
          teamSql = `
            SELECT
              f.slmId AS managerId,
              COALESCE(s.slmName, 'Unassigned') AS managerName,
              COALESCE(s.teamName, NULL) AS teamName,
              COALESCE(s.zone, NULL) AS zone,
              COALESCE(SUM(f.currentDiceRollBalance), 0) AS totalDiceRollBalance,
              COUNT(f.flmId) AS teamMembers
            FROM flms f
            LEFT JOIN slms s ON f.slmId = s.slmId
            ${teamZoneWhereClause}
            GROUP BY f.slmId, s.slmName, s.teamName, s.zone
            ORDER BY totalDiceRollBalance DESC, managerName ASC
            ${limitClause}
          `;
        }
        teamParams = [...teamZoneParams];
      }
      [rows] = await connection.execute(teamSql, teamParams);
    } else {
      let playerSql = "";
      let playerParams = [];

      // Build WHERE clause for team and zone filters in player division
      // Use case-insensitive comparison to handle team name variations
      let playerTeamZoneWhereClause = "";
      const playerTeamZoneParams = [];
      if (teamFilterActive || zoneFilterActive) {
        const conditions = [];
        if (teamFilterActive) {
          // Use case-insensitive comparison for team name to handle variations
          conditions.push("LOWER(TRIM(m.teamName)) = LOWER(TRIM(?))");
          playerTeamZoneParams.push(teamNameStr);
        }
        if (zoneFilterActive) {
          // Use case-insensitive comparison for zone to handle variations
          conditions.push("LOWER(TRIM(m.zone)) = LOWER(TRIM(?))");
          playerTeamZoneParams.push(zoneStr);
        }
        playerTeamZoneWhereClause = "WHERE " + conditions.join(" AND ");
      }

      if (filterDatePayload.isActive) {
        const cte = buildMrDiceRollBalanceFilterCte();
        playerSql = `
          ${cte}
          SELECT
            mdmr.mrId AS playerId,
            COALESCE(mdmr.mrName, 'Unassigned') AS playerName,
            COALESCE(m.teamName, NULL) AS teamName,
            COALESCE(m.zone, NULL) AS zone,
            COALESCE(mdmr.metricValue, 0) AS diceRollBalance
          FROM mrDiceRollMetrics mdmr
          LEFT JOIN mrs m ON mdmr.mrId = m.mrId
          ${playerTeamZoneWhereClause}
          ORDER BY diceRollBalance DESC, playerName ASC
          ${limitClause}
        `;
        playerParams = [filterDatePayload.startDateSql, filterDatePayload.endDateSql, ...playerTeamZoneParams];
      } else {
        playerSql = `
          SELECT
            m.mrId AS playerId,
            COALESCE(m.mrName, 'Unassigned') AS playerName,
            COALESCE(m.teamName, NULL) AS teamName,
            COALESCE(m.zone, NULL) AS zone,
            COALESCE(m.diceRollBalance, 0) AS diceRollBalance
          FROM mrs m
          ${playerTeamZoneWhereClause}
          ORDER BY diceRollBalance DESC, playerName ASC
          ${limitClause}
        `;
        playerParams = [...playerTeamZoneParams];
      }
      [rows] = await connection.execute(playerSql, playerParams);
    }

    const data =
      normalizedDivision === "team"
        ? rows.map((row, index) => ({
            rank: index + 1,
            managerId: row.managerId,
            managerName: row.managerName,
            teamName: row.teamName || null,
            zone: row.zone || null, // Include zone in response for frontend filtering
            totalDiceRollBalance: Number(row.totalDiceRollBalance) || 0,
            teamMembers: Number(row.teamMembers) || 0,
            metricValue: Number(row.totalDiceRollBalance) || 0,
          }))
        : rows.map((row, index) => {
            const mrId = row.playerId;
            const isHighlighted = highlightMrIds.length > 0 && highlightMrIds.includes(mrId);
            return {
              rank: index + 1,
              mrId: mrId,
              mrName: row.playerName,
              teamName: row.teamName || null,
              zone: row.zone || null, // Include zone in response for frontend filtering
              diceRollBalance: Number(row.diceRollBalance) || 0,
              metricValue: Number(row.diceRollBalance) || 0,
              isHighlighted: isHighlighted,
            };
          });

    let highlightedEntry = null;
    if (normalizedDivision === "team") {
      if (highlightId && data.length > 0) {
        highlightedEntry = data.find(entry => entry.managerId && entry.managerId.toString() === highlightId) || null;
      }
    } else {
      if (highlightMrIds.length > 0 && data.length > 0) {
        const highlightedEntries = data.filter(entry => entry.isHighlighted);
        if (highlightedEntries.length > 0) {
          if (normalizedUserRole === "flm" && highlightFlmId) {
            highlightedEntry = highlightedEntries.reduce((best, current) => 
              current.rank < best.rank ? current : best
            );
          } else if (normalizedUserRole === "mr") {
            highlightedEntry = highlightedEntries[0];
          } else {
            highlightedEntry = highlightedEntries.length === 1 ? highlightedEntries[0] : highlightedEntries;
          }
        }
      }
    }

    res.status(200).json({
      success: true,
      division: normalizedDivision,
      managerLevel: normalizedDivision === "team" ? normalizedManagerLevel : null,
      limit: numericLimit,
      filterApplied: filterDatePayload.isActive || teamFilterActive || zoneFilterActive,
      filterRange: filterDatePayload.isActive
        ? {
            startDate: startDateStr,
            endDate: endDateStr,
          }
        : null,
      teamFilter: teamFilterActive ? teamNameStr : null, // Team filter applied
      zoneFilter: zoneFilterActive ? zoneStr : null, // Zone filter applied
      total: data.length,
      highlight: highlightedEntry,
      data,
    });
  } catch (error) {
    console.error("Error fetching dice roll balance leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getHomeLeaderboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      managerLevel = "flm",
      limit = 10,
      userRole,
      userId,
      startDate,
      endDate,
      teamName, // Filter by team name - filters leaderboard entries to show only specific team
      zone, // Filter by zone - filters leaderboard entries to show only specific zone
    } = req.query;

    const normalizedManagerLevel = managerLevel.toString().trim().toLowerCase();
    const normalizedUserRole = userRole ? userRole.toString().trim().toLowerCase() : null;
    const startDateStr = startDate ? startDate.toString().trim() : null;
    const endDateStr = endDate ? endDate.toString().trim() : null;
    // Team filter: decode URL encoding (e.g., "Black+Panthers" -> "Black Panthers") and trim
    const teamNameStr = teamName ? decodeURIComponent(teamName.toString().trim().replace(/\+/g, ' ')) : null;
    // Zone filter: decode URL encoding and trim
    const zoneStr = zone ? decodeURIComponent(zone.toString().trim().replace(/\+/g, ' ')) : null;

    if (!["flm", "slm", "tlm"].includes(normalizedManagerLevel)) {
      return res.status(400).json({
        success: false,
        message: "managerLevel must be 'flm', 'slm' or 'tlm'",
      });
    }

    if ((startDateStr && !endDateStr) || (!startDateStr && endDateStr)) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required to enable date filtering",
      });
    }

    let filterDatePayload = {
      isActive: false,
      startDateSql: null,
      endDateSql: null,
    };

    if (startDateStr && endDateStr) {
      const parsedStart = parseIsoDate(startDateStr, false);
      const parsedEnd = parseIsoDate(endDateStr, true);

      if (!parsedStart || !parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate and endDate must be valid dates (YYYY-MM-DD) not earlier than 2025-01-01",
        });
      }

      if (parsedStart > parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate cannot be later than endDate",
        });
      }

      filterDatePayload = {
        isActive: true,
        startDateSql: formatDateForSql(parsedStart),
        endDateSql: formatDateForSql(parsedEnd),
      };
    }

    let limitClause = "";
    let numericLimit = null;

    if (limit !== undefined && limit !== null && limit.toString().trim().toLowerCase() !== "all") {
      numericLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 1000));
      limitClause = ` LIMIT ${numericLimit}`;
    }

    let highlightId = null;

    const resolveFlmIdFromMr = async mrId => {
      if (!mrId) return null;
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [mrId]
      );
      if (mrRows.length === 0) return null;
      return mrRows[0].flmId || null;
    };

    const resolveManagerIdForFlm = async flmId => {
      if (!flmId) return { slmId: null, tlmId: null };
      const [flmRows] = await connection.execute(
        `SELECT f.slmId, s.tlmId
         FROM flms f
         LEFT JOIN slms s ON f.slmId = s.slmId
         WHERE f.flmId = ?
         LIMIT 1`,
        [flmId]
      );
      if (flmRows.length === 0) return { slmId: null, tlmId: null };
      return {
        slmId: flmRows[0].slmId || null,
        tlmId: flmRows[0].tlmId || null,
      };
    };

    if (userId) {
      if (normalizedUserRole === "flm") {
        if (normalizedManagerLevel === "flm") {
          highlightId = userId.toString().trim();
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(userId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "mr") {
        const flmId = await resolveFlmIdFromMr(userId);
        if (normalizedManagerLevel === "flm") {
          highlightId = flmId;
        } else {
          const { slmId, tlmId } = await resolveManagerIdForFlm(flmId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        }
      } else if (normalizedUserRole === "slm") {
        highlightId = normalizedManagerLevel === "slm" ? userId.toString().trim() : null;
      } else if (normalizedUserRole === "tlm") {
        highlightId = normalizedManagerLevel === "tlm" ? userId.toString().trim() : null;
      }
    }

    // Team and zone filters: used to filter leaderboard results by team name or zone
    const teamFilterActive = !!teamNameStr;
    const zoneFilterActive = !!zoneStr;
    
    // Build WHERE clause for team and zone filters
    let teamZoneWhereClause = "";
    const teamZoneParams = [];
    if (teamFilterActive || zoneFilterActive) {
      const conditions = [];
      if (teamFilterActive) {
        if (normalizedManagerLevel === "flm") {
          conditions.push("f.teamName = ?");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.teamName = ?");
        } else {
          conditions.push("s.teamName = ?");
        }
        teamZoneParams.push(teamNameStr.trim());
      }
      if (zoneFilterActive) {
        if (normalizedManagerLevel === "flm") {
          // For FLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m WHERE m.flmId = f.flmId AND m.zone = ?)");
        } else if (normalizedManagerLevel === "tlm") {
          conditions.push("t.zone = ?");
        } else {
          // For SLM level, check zone from MRs
          conditions.push("EXISTS (SELECT 1 FROM mrs m JOIN flms f2 ON m.flmId = f2.flmId WHERE f2.slmId = f.slmId AND m.zone = ?)");
        }
        teamZoneParams.push(zoneStr.trim());
      }
      teamZoneWhereClause = "WHERE " + conditions.join(" AND ");
    }

    let teamSql = "";
    const queryParams = [];

    if (filterDatePayload.isActive) {
      if (normalizedManagerLevel === "flm") {
        teamSql = `
          WITH finishedPawns AS (
            SELECT DISTINCT ml.playerId, ml.pawnId
            FROM moveLogs ml
            WHERE ml.moveTime BETWEEN ? AND ?
              AND ml.toPosition = 'finished'
          )
          SELECT
            f.flmId AS managerId,
            COALESCE(f.flmName, 'Unassigned') AS managerName,
            COALESCE(f.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COUNT(DISTINCT fp.pawnId) AS totalHomePawns,
            1 AS teamMembers
          FROM flms f
          LEFT JOIN finishedPawns fp ON fp.playerId = f.flmId
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.flmId, f.flmName, f.teamName
          ORDER BY totalHomePawns DESC, managerName ASC
          ${limitClause}
        `;
        queryParams.push(filterDatePayload.startDateSql, filterDatePayload.endDateSql);
      } else if (normalizedManagerLevel === "tlm") {
        teamSql = `
          WITH finishedPawns AS (
            SELECT DISTINCT ml.playerId, ml.pawnId
            FROM moveLogs ml
            WHERE ml.moveTime BETWEEN ? AND ?
              AND ml.toPosition = 'finished'
          )
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(t.teamName, NULL) AS teamName,
            COALESCE(t.zone, NULL) AS zone,
            COUNT(DISTINCT fp.pawnId) AS totalHomePawns,
            COUNT(DISTINCT f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
          LEFT JOIN finishedPawns fp ON fp.playerId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
          ORDER BY totalHomePawns DESC, managerName ASC
          ${limitClause}
        `;
        queryParams.push(filterDatePayload.startDateSql, filterDatePayload.endDateSql);
      } else {
        teamSql = `
          WITH finishedPawns AS (
            SELECT DISTINCT ml.playerId, ml.pawnId
            FROM moveLogs ml
            WHERE ml.moveTime BETWEEN ? AND ?
              AND ml.toPosition = 'finished'
          )
          SELECT
            f.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(s.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COUNT(DISTINCT fp.pawnId) AS totalHomePawns,
            COUNT(DISTINCT f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN finishedPawns fp ON fp.playerId = f.flmId
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.slmId, s.slmName, s.teamName
          ORDER BY totalHomePawns DESC, managerName ASC
          ${limitClause}
        `;
        queryParams.push(filterDatePayload.startDateSql, filterDatePayload.endDateSql);
      }
    } else {
      if (normalizedManagerLevel === "flm") {
        teamSql = `
          SELECT
            f.flmId AS managerId,
            COALESCE(f.flmName, 'Unassigned') AS managerName,
            COALESCE(f.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COUNT(p.id) AS totalHomePawns,
            1 AS teamMembers
          FROM flms f
          LEFT JOIN pawns p ON p.playerId = f.flmId 
            AND p.type = 'center' 
            AND p.currentPosition = 'finished'
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.flmId, f.flmName, f.teamName
          ORDER BY totalHomePawns DESC, managerName ASC
          ${limitClause}
        `;
      } else if (normalizedManagerLevel === "tlm") {
        teamSql = `
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(t.teamName, NULL) AS teamName,
            COALESCE(t.zone, NULL) AS zone,
            COUNT(p.id) AS totalHomePawns,
            COUNT(DISTINCT f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
          LEFT JOIN pawns p ON p.playerId = f.flmId 
            AND p.type = 'center' 
            AND p.currentPosition = 'finished'
          ${teamZoneWhereClause}
          GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
          ORDER BY totalHomePawns DESC, managerName ASC
          ${limitClause}
        `;
      } else {
        teamSql = `
          SELECT
            f.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(s.teamName, NULL) AS teamName,
            COALESCE(MAX(m.zone), NULL) AS zone,
            COUNT(p.id) AS totalHomePawns,
            COUNT(DISTINCT f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN pawns p ON p.playerId = f.flmId 
            AND p.type = 'center' 
            AND p.currentPosition = 'finished'
          LEFT JOIN mrs m ON m.flmId = f.flmId
          ${teamZoneWhereClause}
          GROUP BY f.slmId, s.slmName, s.teamName
          ORDER BY totalHomePawns DESC, managerName ASC
          ${limitClause}
        `;
      }
    }

    const allQueryParams = [...queryParams, ...teamZoneParams];
    const [rows] = await connection.execute(teamSql, allQueryParams);

    const data = rows.map((row, index) => ({
      rank: index + 1,
      managerId: row.managerId,
      managerName: row.managerName,
      teamName: row.teamName || null,
      zone: row.zone || null, // Include zone in response for frontend filtering
      totalHomePawns: Number(row.totalHomePawns) || 0,
      teamMembers: Number(row.teamMembers) || 0,
      metricValue: Number(row.totalHomePawns) || 0,
    }));

    const highlightedEntry =
      highlightId && data.length > 0
        ? data.find(entry => entry.managerId && entry.managerId.toString() === highlightId) || null
        : null;

    res.status(200).json({
      success: true,
      division: "team",
      managerLevel: normalizedManagerLevel,
      limit: numericLimit,
      filterApplied: filterDatePayload.isActive || teamFilterActive || zoneFilterActive,
      filterRange: filterDatePayload.isActive
        ? {
            startDate: startDateStr,
            endDate: endDateStr,
          }
        : null,
      teamFilter: teamFilterActive ? teamNameStr : null, // Team filter applied
      zoneFilter: zoneFilterActive ? zoneStr : null, // Zone filter applied
      total: data.length,
      highlight: highlightedEntry,
      data,
    });
  } catch (error) {
    console.error("Error fetching home leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

//only prescription related -not in use currently
export const getPrescriptionPointsLeaderboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      division = "team",
      managerLevel = "slm",
      limit = "all",
      startDate,
      endDate,
      userRole,
      userId,
    } = req.query;

    const normalizedDivision = division.toString().trim().toLowerCase();
    const normalizedManagerLevel = managerLevel.toString().trim().toLowerCase();
    const normalizedUserRole = userRole ? userRole.toString().trim().toLowerCase() : null;

    if (!["team", "player"].includes(normalizedDivision)) {
      return res.status(400).json({
        success: false,
        message: "division must be either 'team' or 'player'",
      });
    }

    if (normalizedDivision === "team" && !["slm", "tlm"].includes(normalizedManagerLevel)) {
      return res.status(400).json({
        success: false,
        message: "managerLevel must be 'slm' or 'tlm' when division is 'team'",
      });
    }

    let numericLimit = null;
    let limitClause = "";
    if (limit !== undefined && limit !== null && limit.toString().trim().toLowerCase() !== "all") {
      numericLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 1000));
      limitClause = ` LIMIT ${numericLimit}`;
    }

    let range;
    try {
      range = parseDateRange({ startDate, endDate });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const resolveFlmIdFromMr = async mrId => {
      if (!mrId) return null;
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [mrId]
      );
      if (mrRows.length === 0) return null;
      return mrRows[0].flmId || null;
    };

    const resolveManagerIdForFlm = async flmId => {
      if (!flmId) return { slmId: null, tlmId: null };
      const [flmRows] = await connection.execute(
        `SELECT f.slmId, s.tlmId
         FROM flms f
         LEFT JOIN slms s ON f.slmId = s.slmId
         WHERE f.flmId = ?
         LIMIT 1`,
        [flmId]
      );
      if (flmRows.length === 0) return { slmId: null, tlmId: null };
      return {
        slmId: flmRows[0].slmId || null,
        tlmId: flmRows[0].tlmId || null,
      };
    };

    const highlightId = await (async () => {
      if (!userId) return null;

      if (normalizedDivision === "player") {
        if (normalizedUserRole === "flm") {
          return userId.toString().trim();
        }
        if (normalizedUserRole === "mr") {
          return await resolveFlmIdFromMr(userId);
        }
        return null;
      }

      if (normalizedUserRole === "flm") {
        const { slmId, tlmId } = await resolveManagerIdForFlm(userId);
        return normalizedManagerLevel === "tlm" ? tlmId : slmId;
      }

      if (normalizedUserRole === "mr") {
        const flmId = await resolveFlmIdFromMr(userId);
        const { slmId, tlmId } = await resolveManagerIdForFlm(flmId);
        return normalizedManagerLevel === "tlm" ? tlmId : slmId;
      }

      if (normalizedUserRole === "slm") {
        return normalizedManagerLevel === "slm" ? userId.toString().trim() : null;
      }

      if (normalizedUserRole === "tlm") {
        return normalizedManagerLevel === "tlm" ? userId.toString().trim() : null;
      }

      return null;
    })();

    let rows = [];
    const params = [range.startSql, range.endSql];

    if (normalizedDivision === "team") {
      if (normalizedManagerLevel === "tlm") {
        const teamSql = `
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(SUM(p.points), 0) AS totalPoints,
            COUNT(DISTINCT f.flmId) AS teamMembers
          FROM uploads p
          JOIN mrs m ON p.mrId = m.mrId
          JOIN flms f ON m.flmId = f.flmId
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
          WHERE p.type = 'prescription'
            AND p.status = 'approved'
            AND p.reviewDate BETWEEN ? AND ?
          GROUP BY s.tlmId, t.tlmName
          ORDER BY totalPoints DESC, managerName ASC
          ${limitClause}
        `;
        [rows] = await connection.execute(teamSql, params);
      } else {
        const teamSql = `
          SELECT
            f.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(SUM(p.points), 0) AS totalPoints,
            COUNT(DISTINCT f.flmId) AS teamMembers
          FROM uploads p
          JOIN mrs m ON p.mrId = m.mrId
          JOIN flms f ON m.flmId = f.flmId
          LEFT JOIN slms s ON f.slmId = s.slmId
          WHERE p.type = 'prescription'
            AND p.status = 'approved'
            AND p.reviewDate BETWEEN ? AND ?
          GROUP BY f.slmId, s.slmName
          ORDER BY totalPoints DESC, managerName ASC
          ${limitClause}
        `;
        [rows] = await connection.execute(teamSql, params);
      }
    } else {
      const playerSql = `
        SELECT
          f.flmId AS playerId,
          f.flmName AS playerName,
          COALESCE(SUM(p.points), 0) AS totalPoints
        FROM uploads p
        JOIN mrs m ON p.mrId = m.mrId
        JOIN flms f ON m.flmId = f.flmId
        WHERE p.type = 'prescription'
          AND p.status = 'approved'
          AND p.reviewDate BETWEEN ? AND ?
        GROUP BY f.flmId, f.flmName
        ORDER BY totalPoints DESC, playerName ASC
        ${limitClause}
      `;
      [rows] = await connection.execute(playerSql, params);
    }

    const data =
      normalizedDivision === "team"
        ? rows.map((row, index) => ({
            rank: index + 1,
            managerId: row.managerId,
            managerName: row.managerName,
            totalPoints: Number(row.totalPoints) || 0,
            teamMembers: Number(row.teamMembers) || 0,
            metricValue: Number(row.totalPoints) || 0,
          }))
        : rows.map((row, index) => ({
            rank: index + 1,
            flmId: row.playerId,
            flmName: row.playerName,
            totalPoints: Number(row.totalPoints) || 0,
            metricValue: Number(row.totalPoints) || 0,
          }));

    const highlightedEntry =
      highlightId && data.length > 0
        ? data.find(entry =>
            normalizedDivision === "team"
              ? entry.managerId && entry.managerId.toString() === highlightId
              : entry.flmId && entry.flmId.toString() === highlightId
          ) || null
        : null;

    res.status(200).json({
      success: true,
      division: normalizedDivision,
      managerLevel: normalizedDivision === "team" ? normalizedManagerLevel : null,
      limit: numericLimit,
      total: data.length,
      dateRange: {
        start: range.startSql,
        end: range.endSql,
      },
      highlight: highlightedEntry,
      data,
    });
  } catch (error) {
    console.error("Error fetching prescription points leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

//all type user points -not in use currently
export const getPointsLeaderboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      division = "team",
      managerLevel = "slm",
      limit = 10,
      userRole,
      userId,
      startDate,
      endDate,
      brandId,
      brandName,
      teamName, // Filter by team name - filters leaderboard entries to show only specific team
      zone, // Filter by zone - filters leaderboard entries to show only specific zone
    } = req.query;

    const normalizedDivision = division.toString().trim().toLowerCase();
    const normalizedManagerLevel = managerLevel.toString().trim().toLowerCase();
    const normalizedUserRole = userRole ? userRole.toString().trim().toLowerCase() : null;
    const startDateStr = startDate ? startDate.toString().trim() : null;
    const endDateStr = endDate ? endDate.toString().trim() : null;
    const brandIdStr = brandId ? brandId.toString().trim() : null;
    const brandNameStr = brandName ? brandName.toString().trim() : null;

    if (!["team", "player"].includes(normalizedDivision)) {
      return res.status(400).json({
        success: false,
        message: "division must be either 'team' or 'player'",
      });
    }

    if (normalizedDivision === "team" && !["slm", "tlm"].includes(normalizedManagerLevel)) {
      return res.status(400).json({
        success: false,
        message: "managerLevel must be 'slm' or 'tlm' when division is 'team'",
      });
    }

    if ((startDateStr && !endDateStr) || (!startDateStr && endDateStr)) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required to enable filtering",
      });
    }

    let filterDatePayload = {
      isActive: false,
      startDateSql: null,
      endDateSql: null,
    };

    if (startDateStr && endDateStr) {
      const parsedStart = parseIsoDate(startDateStr, false);
      const parsedEnd = parseIsoDate(endDateStr, true);

      if (!parsedStart || !parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate and endDate must be valid dates (YYYY-MM-DD) not earlier than 2025-01-01",
        });
      }

      if (parsedStart > parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "startDate cannot be later than endDate",
        });
      }

      filterDatePayload = {
        isActive: true,
        startDateSql: formatDateForSql(parsedStart),
        endDateSql: formatDateForSql(parsedEnd),
      };
    }

    let limitClause = "";
    let numericLimit = null;

    if (limit !== undefined && limit !== null && limit.toString().trim().toLowerCase() !== "all") {
      numericLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 1000));
      limitClause = ` LIMIT ${numericLimit}`;
    }

    let rows = [];

    const resolveFlmIdFromMr = async mrId => {
      if (!mrId) return null;
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [mrId]
      );
      if (mrRows.length === 0) return null;
      return mrRows[0].flmId || null;
    };

    const resolveManagerIdForFlm = async flmId => {
      if (!flmId) return { slmId: null, tlmId: null };
      const [flmRows] = await connection.execute(
        `SELECT f.slmId, s.tlmId
         FROM flms f
         LEFT JOIN slms s ON f.slmId = s.slmId
         WHERE f.flmId = ?
         LIMIT 1`,
        [flmId]
      );
      if (flmRows.length === 0) return { slmId: null, tlmId: null };
      return {
        slmId: flmRows[0].slmId || null,
        tlmId: flmRows[0].tlmId || null,
      };
    };

    let highlightId = null;
    let highlightMrIds = [];
    let highlightFlmId = null;

    if (userId) {
      if (normalizedDivision === "player") {
        if (normalizedUserRole === "flm") {
          highlightFlmId = userId.toString().trim();
          const [mrRows] = await connection.execute(
            `SELECT mrId FROM mrs WHERE flmId = ?`,
            [highlightFlmId]
          );
          highlightMrIds = mrRows.map(row => row.mrId);
        } else if (normalizedUserRole === "mr") {
          highlightMrIds = [userId.toString().trim()];
        }
      } else {
        if (normalizedUserRole === "flm") {
          const { slmId, tlmId } = await resolveManagerIdForFlm(userId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        } else if (normalizedUserRole === "mr") {
          const flmId = await resolveFlmIdFromMr(userId);
          const { slmId, tlmId } = await resolveManagerIdForFlm(flmId);
          highlightId = normalizedManagerLevel === "tlm" ? tlmId : slmId;
        } else if (normalizedUserRole === "slm") {
          highlightId = normalizedManagerLevel === "slm" ? userId.toString().trim() : null;
        } else if (normalizedUserRole === "tlm") {
          highlightId = normalizedManagerLevel === "tlm" ? userId.toString().trim() : null;
        }
      }
    }

    const brandFilter = brandIdStr ? { brandId: brandIdStr } : brandNameStr ? { brandName: brandNameStr } : null;
    const brandFilterActive = !!brandFilter;
    
    // Team and zone filters: used to filter leaderboard results by team name or zone
    // These filters allow users to view leaderboard entries for a specific team or zone
    // Decode URL encoding (e.g., "Black+Panthers" -> "Black Panthers") and trim
    const teamNameStr = teamName ? decodeURIComponent(teamName.toString().trim().replace(/\+/g, ' ')) : null;
    const zoneStr = zone ? decodeURIComponent(zone.toString().trim().replace(/\+/g, ' ')) : null;
    const teamFilterActive = !!teamNameStr;
    const zoneFilterActive = !!zoneStr;
    
    // If brand filter is active, we need to query uploads table even without date filter
    const needsUploadsQuery = filterDatePayload.isActive || brandFilterActive;
    
    const filterCteSql = needsUploadsQuery ? buildPointsFilterCte(brandFilter, filterDatePayload.isActive) : "";
    let filterParams = [];
    
    // Build filter parameters
    if (filterDatePayload.isActive) {
      filterParams.push(filterDatePayload.startDateSql, filterDatePayload.endDateSql);
    }
    
    // Add brand filter parameter if present
    if (brandFilter) {
      if (brandFilter.brandId) {
        filterParams.push(brandFilter.brandId);
      } else if (brandFilter.brandName) {
        filterParams.push(brandFilter.brandName);
      }
    }

    if (normalizedDivision === "team") {
      let teamSql = "";

      if (needsUploadsQuery) {
        // Build WHERE clause for team and zone filters
        let teamZoneWhereClause = "";
        const teamZoneParams = [];
        if (teamFilterActive || zoneFilterActive) {
          const conditions = [];
          if (teamFilterActive) {
            if (normalizedManagerLevel === "tlm") {
              // Direct column comparison - MySQL collation handles case-insensitivity
              conditions.push("t.teamName = ?");
            } else {
              // Direct column comparison - MySQL collation handles case-insensitivity
              conditions.push("s.teamName = ?");
            }
            teamZoneParams.push(teamNameStr.trim());
          }
          if (zoneFilterActive) {
            if (normalizedManagerLevel === "tlm") {
              // Direct column comparison - MySQL collation handles case-insensitivity
              conditions.push("t.zone = ?");
            } else {
              // For SLM level, we need to check zone from MRs or FLMs
              // Direct column comparison - MySQL collation handles case-insensitivity
              conditions.push("EXISTS (SELECT 1 FROM mrs m JOIN flms f2 ON m.flmId = f2.flmId WHERE m.flmId = fpm.flmId AND m.zone = ?)");
            }
            teamZoneParams.push(zoneStr.trim());
          }
          teamZoneWhereClause = "WHERE " + conditions.join(" AND ");
        }
        
        if (normalizedManagerLevel === "tlm") {
          teamSql = `
            ${filterCteSql}
            SELECT
              s.tlmId AS managerId,
              COALESCE(t.tlmName, 'Unassigned') AS managerName,
              COALESCE(t.teamName, NULL) AS teamName,
              COALESCE(t.zone, NULL) AS zone,
              COALESCE(SUM(fpm.metricValue), 0) AS totalPoints,
              COUNT(fpm.flmId) AS teamMembers
            FROM flmPointMetrics fpm
            LEFT JOIN slms s ON fpm.slmId = s.slmId
            LEFT JOIN tlms t ON s.tlmId = t.tlmId
            ${teamZoneWhereClause}
            GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
            ORDER BY totalPoints DESC, managerName ASC
            ${limitClause}
          `;
        } else {
          teamSql = `
            ${filterCteSql}
            SELECT
              fpm.slmId AS managerId,
              COALESCE(s.slmName, 'Unassigned') AS managerName,
              COALESCE(s.teamName, NULL) AS teamName,
              COALESCE(s.zone, NULL) AS zone,
              COALESCE(SUM(fpm.metricValue), 0) AS totalPoints,
              COUNT(fpm.flmId) AS teamMembers
            FROM flmPointMetrics fpm
            LEFT JOIN slms s ON fpm.slmId = s.slmId
            ${brandFilterActive && !teamZoneWhereClause ? "WHERE fpm.metricValue > 0" : ""}
            ${teamZoneWhereClause ? (brandFilterActive ? teamZoneWhereClause.replace("WHERE", "AND") : teamZoneWhereClause) : ""}
            GROUP BY fpm.slmId, s.slmName, s.teamName, s.zone
            ORDER BY totalPoints DESC, managerName ASC
            ${limitClause}
          `;
        }
      } else {
        // Build WHERE clause for team and zone filters (when not using uploads query)
        // Use case-insensitive comparison to handle team name and zone variations
        let teamZoneWhereClause = "";
        const teamZoneParams = [];
        if (teamFilterActive || zoneFilterActive) {
          const conditions = [];
          if (teamFilterActive) {
            if (normalizedManagerLevel === "tlm") {
              // Direct column comparison - MySQL collation handles case-insensitivity
              conditions.push("t.teamName = ?");
            } else {
              // Direct column comparison - MySQL collation handles case-insensitivity
              conditions.push("s.teamName = ?");
            }
            teamZoneParams.push(teamNameStr.trim());
          }
          if (zoneFilterActive) {
            if (normalizedManagerLevel === "tlm") {
              // Direct column comparison - MySQL collation handles case-insensitivity
              conditions.push("t.zone = ?");
            } else {
              // For SLM level, check zone from MRs
              // Direct column comparison - MySQL collation handles case-insensitivity
              conditions.push("EXISTS (SELECT 1 FROM mrs m WHERE m.flmId = f.flmId AND m.zone = ?)");
            }
            teamZoneParams.push(zoneStr.trim());
          }
          teamZoneWhereClause = "WHERE " + conditions.join(" AND ");
        }
        
      if (normalizedManagerLevel === "tlm") {
        teamSql = `
          SELECT
            s.tlmId AS managerId,
            COALESCE(t.tlmName, 'Unassigned') AS managerName,
            COALESCE(t.teamName, NULL) AS teamName,
              COALESCE(t.zone, NULL) AS zone,
            COALESCE(SUM(f.points), 0) AS totalPoints,
            COUNT(f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
          LEFT JOIN tlms t ON s.tlmId = t.tlmId
            ${teamZoneWhereClause}
            GROUP BY s.tlmId, t.tlmName, t.teamName, t.zone
          ORDER BY totalPoints DESC, managerName ASC
          ${limitClause}
        `;
      } else {
        teamSql = `
          SELECT
            f.slmId AS managerId,
            COALESCE(s.slmName, 'Unassigned') AS managerName,
            COALESCE(s.teamName, NULL) AS teamName,
              COALESCE(s.zone, NULL) AS zone,
            COALESCE(SUM(f.points), 0) AS totalPoints,
            COUNT(f.flmId) AS teamMembers
          FROM flms f
          LEFT JOIN slms s ON f.slmId = s.slmId
            ${teamZoneWhereClause}
            GROUP BY f.slmId, s.slmName, s.teamName, s.zone
          ORDER BY totalPoints DESC, managerName ASC
          ${limitClause}
        `;
      }
      }
      // Combine filter params with team/zone params for team division
      // Build team/zone params array based on active filters
      const teamZoneParams = [];
      if (teamFilterActive) {
        teamZoneParams.push(teamNameStr);
      }
      if (zoneFilterActive) {
        teamZoneParams.push(zoneStr);
      }
      const allTeamFilterParams = [...filterParams, ...teamZoneParams];
      [rows] = await connection.execute(teamSql, allTeamFilterParams);
    } else {
      let playerSql = "";
      // Build WHERE clause for team and zone filters in player division
      // Define playerTeamZoneParams outside if/else blocks for proper scope
      // Note: Using direct column comparison (no LOWER/TRIM on columns) for better performance
      // MySQL's utf8mb4_0900_ai_ci collation is already case-insensitive
      let playerTeamZoneWhereClause = "";
      const playerTeamZoneParams = [];
      if (teamFilterActive || zoneFilterActive) {
        const conditions = [];
        if (teamFilterActive) {
          // Direct column comparison - MySQL collation handles case-insensitivity
          conditions.push("m.teamName = ?");
          playerTeamZoneParams.push(teamNameStr.trim());
        }
        if (zoneFilterActive) {
          // Direct column comparison - MySQL collation handles case-insensitivity
          conditions.push("m.zone = ?");
          playerTeamZoneParams.push(zoneStr.trim());
        }
        playerTeamZoneWhereClause = "WHERE " + conditions.join(" AND ");
      }
      
      if (needsUploadsQuery) {
        let brandWhereClause = "";
        if (brandFilter && brandFilter.brandId) {
          brandWhereClause = " AND JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandId')) = ?";
        } else if (brandFilter && brandFilter.brandName) {
          brandWhereClause = " AND JSON_UNQUOTE(JSON_EXTRACT(p.activitySpecificDetails, '$.brandName')) = ?";
        }
        
        const dateWhereClause = filterDatePayload.isActive ? "AND p.reviewDate BETWEEN ? AND ?" : "";
        
        // Always include all upload types (prescription, pob, camp)
        const typeWhereClause = "AND p.type IN ('prescription', 'pob', 'camp')";
        
        // For CTE queries, convert WHERE to AND for the first CTE
        // If playerTeamZoneWhereClause is empty, keep it empty; otherwise convert WHERE to AND
        const playerTeamZoneWhereClauseForCte = playerTeamZoneWhereClause 
          ? playerTeamZoneWhereClause.replace("WHERE", "AND")
          : "";
        
        const mrFilterCteSql = `
          WITH filteredMrPoints AS (
            SELECT
              m.mrId,
              SUM(p.points) AS totalPoints
            FROM uploads p
            JOIN mrs m ON p.mrId = m.mrId
            WHERE p.status = 'approved'
              AND p.isCalculated = 1
              ${typeWhereClause}
              ${dateWhereClause}
              ${brandWhereClause}
              ${playerTeamZoneWhereClauseForCte}
            GROUP BY m.mrId
          ),
          mrPointMetrics AS (
            SELECT
              m.mrId,
              COALESCE(m.mrName, 'Unassigned') AS mrName,
              COALESCE(m.teamName, NULL) AS teamName,
              COALESCE(m.zone, NULL) AS zone,
              COALESCE(fmp.totalPoints, 0) AS metricValue
            FROM mrs m
            LEFT JOIN filteredMrPoints fmp ON fmp.mrId = m.mrId
            ${playerTeamZoneWhereClause}
          )
        `;
        playerSql = `
          ${mrFilterCteSql}
          SELECT
            mpm.mrId AS playerId,
            mpm.mrName AS playerName,
            mpm.teamName AS teamName,
            mpm.zone AS zone,
            mpm.metricValue AS totalPoints
          FROM mrPointMetrics mpm
          ORDER BY totalPoints DESC, playerName ASC
          ${limitClause}
        `;
      } else {
        // When not using uploads query, use the playerTeamZoneWhereClause already defined above
        playerSql = `
          SELECT
            m.mrId AS playerId,
            COALESCE(m.mrName, 'Unassigned') AS playerName,
            COALESCE(m.teamName, NULL) AS teamName,
            COALESCE(m.zone, NULL) AS zone,
            COALESCE(m.points, 0) AS totalPoints
          FROM mrs m
          ${playerTeamZoneWhereClause}
          ORDER BY totalPoints DESC, playerName ASC
          ${limitClause}
        `;
      }
      // Combine filter params with team/zone params for player division
      // Note: When needsUploadsQuery is true, team/zone params are used twice (once in each CTE)
      // So we need to duplicate them in the params array
      const allPlayerFilterParams = needsUploadsQuery 
        ? [...filterParams, ...playerTeamZoneParams, ...playerTeamZoneParams] // Duplicate for both CTEs
        : [...filterParams, ...playerTeamZoneParams];
      [rows] = await connection.execute(playerSql, allPlayerFilterParams);
    }

    const data =
      normalizedDivision === "team"
        ? rows.map((row, index) => ({
            rank: index + 1,
            managerId: row.managerId,
            managerName: row.managerName,
            teamName: row.teamName || null,
            zone: row.zone || null, // Include zone in response for frontend filtering
            totalPoints: Number(row.totalPoints) || 0,
            teamMembers: Number(row.teamMembers) || 0,
            metricValue: Number(row.totalPoints) || 0,
          }))
        : rows.map((row, index) => {
            const mrId = row.playerId;
            const isHighlighted = highlightMrIds.length > 0 && highlightMrIds.includes(mrId);
            return {
              rank: index + 1,
              mrId: mrId,
              mrName: row.playerName,
              teamName: row.teamName || null,
              zone: row.zone || null, // Include zone in response for frontend filtering
              totalPoints: Number(row.totalPoints) || 0,
              metricValue: Number(row.totalPoints) || 0,
              isHighlighted: isHighlighted,
            };
          });

    let highlightedEntry = null;
    if (normalizedDivision === "team") {
      if (highlightId && data.length > 0) {
        highlightedEntry = data.find(entry => entry.managerId && entry.managerId.toString() === highlightId) || null;
      }
    } else {
      if (highlightMrIds.length > 0 && data.length > 0) {
        const highlightedEntries = data.filter(entry => entry.isHighlighted);
        if (highlightedEntries.length > 0) {
          if (normalizedUserRole === "flm" && highlightFlmId) {
            highlightedEntry = highlightedEntries.reduce((best, current) => 
              current.rank < best.rank ? current : best
            );
          } else if (normalizedUserRole === "mr") {
            highlightedEntry = highlightedEntries[0];
          } else {
            highlightedEntry = highlightedEntries.length === 1 ? highlightedEntries[0] : highlightedEntries;
          }
        }
      }
    }

    res.status(200).json({
      success: true,
      division: normalizedDivision,
      managerLevel: normalizedDivision === "team" ? normalizedManagerLevel : null,
      limit: numericLimit,
      filterApplied: filterDatePayload.isActive || !!brandFilter || teamFilterActive || zoneFilterActive,
      filterRange: filterDatePayload.isActive
        ? {
            startDate: startDateStr,
            endDate: endDateStr,
          }
        : null,
      brandFilter: brandFilter || null,
      teamFilter: teamFilterActive ? teamNameStr : null, // Team filter applied
      zoneFilter: zoneFilterActive ? zoneStr : null, // Zone filter applied
      total: data.length,
      highlight: highlightedEntry,
      data,
    });
  } catch (error) {
    console.error("Error fetching points leaderboard:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};



//before adding points to move conversion while reviewing prescription
//   const connection = await db.getConnection();

//   try {
//     const { flmId, prescriptionId } = req.params;
//     const { action, rejectionReason } = req.body;

//     if (!["approve", "reject"].includes(action)) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid action. Use 'approve' or 'reject'.",
//       });
//     }

//     await connection.beginTransaction();

//     const [prescriptionRows] = await connection.execute(
//       `SELECT p.*, m.mrId
//        FROM prescriptions p
//        JOIN mrs m ON p.mrId = m.mrId
//        WHERE p.id = ? AND m.flmId = ?
//        LIMIT 1
//        FOR UPDATE`,
//       [prescriptionId, flmId]
//     );

//     if (prescriptionRows.length === 0) {
//       await connection.rollback();
//       return res.status(404).json({
//         success: false,
//         message: "Prescription not found for this FLM",
//       });
//     }

//     const prescription = prescriptionRows[0];

//     if (prescription.status !== "pending") {
//       await connection.rollback();
//       return res.status(400).json({
//         success: false,
//         message: "Only pending prescriptions can be reviewed",
//       });
//     }

//     if (action === "approve") {
//       await connection.execute(
//         `UPDATE prescriptions
//          SET status = 'approved',
//              rejectionReason = NULL,
//              reviewDate = NOW(),
//              isCalculated = 1
//          WHERE id = ?`,
//         [prescriptionId]
//       );

//       const points = Number(prescription.points) || 0;

//       if (points > 0) {
//         await connection.execute(
//           `UPDATE mrs 
//            SET points = COALESCE(points, 0) + ?
//            WHERE mrId = ?`,
//           [points, prescription.mrId]
//         );

//         await connection.execute(
//           `UPDATE flms 
//            SET points = COALESCE(points, 0) + ?
//            WHERE flmId = ?`,
//           [points, flmId]
//         );
//       }

//       await connection.commit();

//       return res.status(200).json({
//         success: true,
//         message: "Prescription approved successfully",
//         data: {
//           prescriptionId,
//           status: "approved",
//         },
//       });
//     } else {
//       if (!rejectionReason || rejectionReason.toString().trim().length === 0) {
//         await connection.rollback();
//         return res.status(400).json({
//           success: false,
//           message: "Rejection reason is required when rejecting a prescription",
//         });
//       }

//       await connection.execute(
//         `UPDATE prescriptions
//          SET status = 'rejected',
//              rejectionReason = ?,
//              reviewDate = NOW(),
//              isCalculated = 0
//          WHERE id = ?`,
//         [rejectionReason, prescriptionId]
//       );

//       await connection.commit();

//       return res.status(200).json({
//         success: true,
//         message: "Prescription rejected successfully",
//         data: {
//           prescriptionId,
//           status: "rejected",
//           rejectionReason,
//         },
//       });
//     }
//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error reviewing prescription:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };

export const downloadUploadImage = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId, uploadId } = req.params;

    if (!flmId || !uploadId) {
      return res.status(400).json({
        success: false,
        message: "flmId and uploadId are required",
      });
    }

    const [rows] = await connection.execute(
      `SELECT p.uploadImage, p.type
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       WHERE p.id = ? AND m.flmId = ?
       LIMIT 1`,
      [uploadId, flmId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Upload image not found for this FLM",
      });
    }

    const imagePath = rows[0].uploadImage;

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

    return res.download(absolutePath, path.basename(absolutePath), err => {
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

export const viewUploadImage = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId, uploadId } = req.params;

    if (!flmId || !uploadId) {
      return res.status(400).json({
        success: false,
        message: "flmId and uploadId are required",
      });
    }

    const [rows] = await connection.execute(
      `SELECT p.uploadImage, p.type
       FROM uploads p
       JOIN mrs m ON p.mrId = m.mrId
       WHERE p.id = ? AND m.flmId = ?
       LIMIT 1`,
      [uploadId, flmId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Upload image not found for this FLM",
      });
    }

    const imagePath = rows[0].uploadImage;

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

//end of prescription related functions

export const getRecentMatches = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { userId, userRole } = req.query;

    if (!userId || !userRole) {
      return res.status(400).json({
        success: false,
        message: "userId and userRole are required",
      });
    }

    const normalizedRole = userRole.toString().trim().toLowerCase();
    let query = "";
    let params = [];

    if (normalizedRole === "flm") {
      query = `
        SELECT *
        FROM boards
        WHERE player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?
        ORDER BY startTime DESC, id DESC
        LIMIT 10
      `;
      params = [userId, userId, userId, userId];
    } else if (normalizedRole === "mr") {
      const [mrRows] = await connection.execute(
        `SELECT flmId FROM mrs WHERE mrId = ? LIMIT 1`,
        [userId]
      );

      if (mrRows.length === 0 || !mrRows[0].flmId) {
        return res.status(200).json({
          success: true,
          total: 0,
          data: [],
        });
      }

      const flmId = mrRows[0].flmId;
      query = `
        SELECT *
        FROM boards
        WHERE player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?
        ORDER BY startTime DESC, id DESC
        LIMIT 10
      `;
      params = [flmId, flmId, flmId, flmId];
    } else {
      return res.status(400).json({
        success: false,
        message: "Unsupported user role. Only FLM and MR are allowed.",
      });
    }

    const [boards] = await connection.execute(query, params);

    res.status(200).json({
      success: true,
      total: boards.length,
      data: boards,
    });
  } catch (error) {
    console.error("Error fetching recent matches:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

export const getUserStats = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { userId, userRole } = req.query;

    if (!userId || !userRole) {
      return res.status(400).json({
        success: false,
        message: "userId and userRole are required",
      });
    }

    const normalizedRole = userRole.toString().trim().toLowerCase();
    const normalizedId = userId.toString().trim();
    const normalizedIdLower = normalizedId.toLowerCase();

    if (normalizedRole === "flm") {
      const [flmRows] = await connection.execute(
        `SELECT flmId, flmName, hq, zone, region, points, moves, currentBalanceMoves, kills, status,
                hearts, createdAt, updatedAt
         FROM flms
         WHERE LOWER(TRIM(flmId)) = ?
         LIMIT 1`,
        [normalizedIdLower]
      );

      if (flmRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "FLM not found",
        });
      }

      const flm = flmRows[0];

      const [mrStatsRows] = await connection.execute(
        `SELECT COUNT(*) AS totalMrs,
                SUM(CASE WHEN hasAccess = 1 THEN 1 ELSE 0 END) AS activeMrs
         FROM mrs
         WHERE LOWER(TRIM(flmId)) = ?`,
        [normalizedIdLower]
      );

      const [boardStatsRows] = await connection.execute(
        `SELECT 
           COUNT(*) AS totalBoards,
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeBoards,
           SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS finishedBoards
         FROM boards
         WHERE LOWER(TRIM(player1)) = ? OR LOWER(TRIM(player2)) = ? OR LOWER(TRIM(player3)) = ? OR LOWER(TRIM(player4)) = ?`,
        [normalizedIdLower, normalizedIdLower, normalizedIdLower, normalizedIdLower]
      );

      const mrStats = mrStatsRows[0] || { totalMrs: 0, activeMrs: 0 };
      const boardStats =
        boardStatsRows[0] || { totalBoards: 0, activeBoards: 0, finishedBoards: 0 };

      return res.status(200).json({
        success: true,
        role: "FLM",
        data: {
          id: flm.flmId,
          name: flm.flmName,
          zone: flm.zone,
          hq: flm.hq,
          region: flm.region,
          points: flm.points ?? 0,
          moves: flm.moves ?? 0,
          currentBalanceMoves: flm.currentBalanceMoves ?? 0,
          kills: flm.kills ?? 0,
          hearts: flm.hearts ?? 0,
          status: flm.status,
          createdAt: flm.createdAt,
          updatedAt: flm.updatedAt,
          mrStats: {
            total: mrStats.totalMrs ?? 0,
            withAccess: mrStats.activeMrs ?? 0,
          },
          boardStats: {
            total: boardStats.totalBoards ?? 0,
            active: boardStats.activeBoards ?? 0,
            finished: boardStats.finishedBoards ?? 0,
          },
        },
      });
    }

    if (normalizedRole === "mr") {
      const [mrRows] = await connection.execute(
        `SELECT mrId, mrName, email, zone, region, status, hasAccess, fromDate, toDate,
                flmId, points, createdAt, updatedAt
         FROM mrs
         WHERE LOWER(TRIM(mrId)) = ?
         LIMIT 1`,
        [normalizedIdLower]
      );

      if (mrRows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "MR not found",
        });
      }

      const mr = mrRows[0];

      const [prescriptionStatsRows] = await connection.execute(
        `SELECT
            COUNT(*) AS totalPrescriptions,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approvedPrescriptions,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingPrescriptions,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejectedPrescriptions,
            SUM(CASE WHEN status = 'approved' THEN points ELSE 0 END) AS approvedPoints
         FROM uploads
         WHERE type = 'prescription'
           AND LOWER(TRIM(mrId)) = ?`,
        [normalizedIdLower]
      );

      const [recentBoards] = await connection.execute(
        `SELECT *
         FROM boards
         WHERE player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?
         ORDER BY startTime DESC, id DESC
         LIMIT 10`,
        [mr.flmId, mr.flmId, mr.flmId, mr.flmId]
      );

      const prescriptionStats = prescriptionStatsRows[0] || {
        totalPrescriptions: 0,
        approvedPrescriptions: 0,
        pendingPrescriptions: 0,
        rejectedPrescriptions: 0,
        approvedPoints: 0,
      };

      return res.status(200).json({
        success: true,
        role: "MR",
        data: {
          id: mr.mrId,
          name: mr.mrName,
          email: mr.email,
          zone: mr.zone,
          region: mr.region,
          status: mr.status,
          hasAccess: mr.hasAccess,
          accessPeriod: {
            fromDate: mr.fromDate,
            toDate: mr.toDate,
          },
          flmId: mr.flmId,
          points: mr.points ?? 0,
          createdAt: mr.createdAt,
          updatedAt: mr.updatedAt,
          prescriptionStats: {
            total: prescriptionStats.totalPrescriptions ?? 0,
            approved: prescriptionStats.approvedPrescriptions ?? 0,
            pending: prescriptionStats.pendingPrescriptions ?? 0,
            rejected: prescriptionStats.rejectedPrescriptions ?? 0,
            approvedPoints: prescriptionStats.approvedPoints ?? 0,
          },
          recentBoards: recentBoards,
        },
      });
    }

    return res.status(400).json({
      success: false,
      message: "Unsupported user role. Only FLM and MR are allowed.",
    });
  } catch (error) {
    console.error("Error fetching user stats:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};



//get mrs list for each flm
export const getMrsByFlm = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId } = req.params;

    if (!flmId) {
      return res.status(400).json({
        success: false,
        message: "flmId is required",
      });
    }

    const [flmRows] = await connection.execute(
      "SELECT flmId, flmName, zone, region FROM flms WHERE flmId = ?",
      [flmId]
    );

    if (flmRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "FLM not found",
      });
    }

    const [mrsRows] = await connection.execute(
      `SELECT id, mrId, mrName, email, zone, region, status, hasAccess, fromDate, toDate, createdAt, updatedAt
       FROM mrs
       WHERE flmId = ?
       ORDER BY mrName ASC`,
      [flmId]
    );

    res.status(200).json({
      success: true,
      data: {
        flm: flmRows[0],
        mrs: mrsRows,
        total: mrsRows.length,
      },
    });
  } catch (error) {
    console.error("Error fetching MRs for FLM:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};

//to give access to play, to an mr
export const updateMrAccess = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { flmId, mrId } = req.params;
    const { hasAccess, fromDate, toDate } = req.body;

    if (!flmId || !mrId) {
      return res.status(400).json({
        success: false,
        message: "flmId and mrId are required",
      });
    }

    // Validate MR-FLM relationship
    const [mrs] = await connection.execute(
      `SELECT id, mrId, mrName, flmId FROM mrs WHERE mrId = ? AND flmId = ?`,
      [mrId, flmId]
    );

    if (mrs.length === 0) {
      return res.status(404).json({
        success: false,
        message: "MR not found for this FLM",
      });
    }

    // If hasAccess is NOT provided at all → throw error
    if (hasAccess === undefined || hasAccess === null) {
      return res.status(400).json({
        success: false,
        message: "hasAccess parameter is required (0 or 1)",
      });
    }

    // Validate hasAccess values
    if (
      hasAccess !== 0 &&
      hasAccess !== 1 &&
      hasAccess !== true &&
      hasAccess !== false &&
      hasAccess !== "0" &&
      hasAccess !== "1" &&
      hasAccess !== "true" &&
      hasAccess !== "false"
    ) {
      return res.status(400).json({
        success: false,
        message: "hasAccess must be a boolean or 0/1",
      });
    }

    const accessFlag =
      hasAccess === true ||
      hasAccess === 1 ||
      hasAccess === "1" ||
      hasAccess === "true"
        ? 1
        : 0;

    //Require fromDate when granting access
    if (accessFlag === 1 && !fromDate) {
      return res.status(400).json({
        success: false,
        message: "fromDate is required when granting access",
      });
    }

    await connection.beginTransaction();

    // Get IST datetime for updatedAt
    const updatedAtIST = formatISTDateTimeForSQL();

    await connection.execute(
      `UPDATE mrs
       SET hasAccess = ?,
           fromDate = ?,
           toDate = ?,
           updatedAt = ?
       WHERE mrId = ? AND flmId = ?`,
      [
        accessFlag,
        accessFlag === 1 ? fromDate : null,
        accessFlag === 1 ? toDate || null : null,
        updatedAtIST,
        mrId,
        flmId,
      ]
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "MR access updated successfully",
      data: {
        mrId,
        flmId,
        hasAccess: accessFlag,
        fromDate: accessFlag === 1 ? fromDate : null,
        toDate: accessFlag === 1 ? toDate || null : null,
      },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error updating MR access:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};



// export const movePawn = async (req, res) => {
//   const connection = await db.getConnection();

//   try {
//     const { pawnId, playerId, boardId, diceNumber } = req.body;

//     // ✅ Basic validation
//     if (!pawnId || !playerId || !boardId || diceNumber == null) {
//       return res.status(400).json({
//         success: false,
//         message: "pawnId, playerId, boardId, and diceNumber are required",
//       });
//     }

//     // ✅ Validate pawn belongs to this player & board
//     const [pawnRows] = await connection.execute(
//       `SELECT * FROM pawns 
//        WHERE id = ? AND playerId = ? AND boardId = ?`,
//       [pawnId, playerId, boardId]
//     );

//     if (pawnRows.length === 0) {
//       return res.status(403).json({
//         success: false,
//         message: "Unauthorized move or pawn not found",
//       });
//     }

//     const pawn = pawnRows[0];

//     // ✅ Handle null/undefined current position as 0
//     const currentPos = pawn.current_position ? parseInt(pawn.current_position) : 0;
//     const prevPos = currentPos; // Store current position as previous before moving
//     const diceVal = parseInt(diceNumber);
//     const newPos = currentPos + diceVal;

//     // ✅ Prevent overshooting
//     if (newPos > 57) {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid move. Pawn cannot go beyond position 57.",
//       });
//     }

//     // ✅ Determine new pawn type
//     let newType = "main";
//     if (newPos === 0) newType = "base";
//     else if (newPos >= 1 && newPos <= 51) newType = "main";
//     else if (newPos >= 52 && newPos <= 56) newType = "home";
//     else if (newPos === 57) newType = "center";

//     // ✅ Safe positions
//     const safePositions = [1, 9, 14, 22, 27, 35, 40, 48];
//     const isSafe = safePositions.includes(newPos) ? 1 : 0;

//     // ✅ Begin transaction
//     await connection.beginTransaction();

//     // ✅ Update pawn position (store previous position before updating)
//     await connection.execute(
//       `UPDATE pawns 
//        SET prev_position = ?, 
//            current_position = ?, 
//            next_position = ?, 
//            type = ?, 
//            is_safe = ?
//        WHERE id = ? AND playerId = ? AND boardId = ?`,
//       [prevPos, newPos, newPos + 1, newType, isSafe, pawnId, playerId, boardId]
//     );

//     // Track if player completed and became a winner
//     let playerCompleted = false;
//     let winnerPosition = null;

//     // 🏁 Check if pawn reached final (center)
//     if (newPos === 57) {
//       // ✅ Check if all 4 pawns of this player on this board reached center
//       const [playerPawns] = await connection.execute(
//         `SELECT COUNT(*) AS total,
//                 SUM(CASE WHEN current_position = 57 THEN 1 ELSE 0 END) AS finished
//          FROM pawns
//          WHERE playerId = ? AND boardId = ?`,
//         [playerId, boardId]
//       );

//       const total = playerPawns[0].total;
//       const finished = playerPawns[0].finished;

//       if (finished === total && total > 0) {
//         playerCompleted = true;
        
//         // ✅ Player has completed all pawns → check board winners
//         const [boardRows] = await connection.execute(
//           `SELECT winner1, winner2, winner3 
//            FROM boards WHERE id = ?`,
//           [boardId]
//         );

//         if (boardRows.length > 0) {
//           const { winner1, winner2, winner3 } = boardRows[0];

//           let winnerField = null;
//           if (!winner1) {
//             winnerField = "winner1";
//             winnerPosition = 1;
//           } else if (!winner2) {
//             winnerField = "winner2";
//             winnerPosition = 2;
//           } else if (!winner3) {
//             winnerField = "winner3";
//             winnerPosition = 3;
//           }

//           if (winnerField) {
//             await connection.execute(
//               `UPDATE boards SET ${winnerField} = ? WHERE id = ?`,
//               [playerId, boardId]
//             );
//           }
//         }
//       }
//     }

//     await connection.commit();

//     // ✅ Fetch updated pawn
//     const [updatedPawnRows] = await connection.execute(
//       `SELECT * FROM pawns WHERE id = ?`,
//       [pawnId]
//     );

//     const updatedPawn = updatedPawnRows[0];

//     // 🔌 Emit socket events for real-time updates
//     emitPawnMove(boardId, updatedPawn);
//     emitBoardUpdate(boardId);

//     // 🏁 Emit game events if player completed
//     if (playerCompleted) {
//       emitGameEvent(boardId, "player_completed", {
//         playerId,
//         message: `Player ${playerId} has completed all pawns!`,
//       });

//       if (winnerPosition) {
//         emitGameEvent(boardId, "winner_updated", {
//           playerId,
//           position: winnerPosition,
//           message: `Player ${playerId} is now winner #${winnerPosition}!`,
//         });
//       }
//     }

//     res.status(200).json({
//       success: true,
//       message: "Pawn moved successfully",
//       pawn: updatedPawn,
//     });
//   } catch (error) {
//     if (connection) await connection.rollback();
//     console.error("Error moving pawn:", error);
//     res.status(500).json({
//       success: false,
//       message: "Internal server error",
//       error: error.message,
//     });
//   } finally {
//     if (connection) connection.release();
//   }
// };






