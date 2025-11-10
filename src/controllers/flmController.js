import db from "../config/db.js";
import { emitBoardUpdate } from "../socket/socketHandlers.js";



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

    const [pawns] = await connection.execute(
      `SELECT * FROM pawns WHERE boardId = ? ORDER BY playerId, id`,
      [board.id]
    );

    let currentTurn = null;
    const currentTurnPlayerId = board.currentTurn || null;

    if (currentTurnPlayerId) {
      const currentTurnPawn = pawns.find(pawn => pawn.playerId === currentTurnPlayerId);

      currentTurn = {
        playerId: currentTurnPlayerId,
        color: currentTurnPawn ? currentTurnPawn.color : null,
      };
    }

    res.status(200).json({
      success: true,
      data: {
        boardId: board.id,
        currentTurn,
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

        await connection.execute(
          `UPDATE flms 
           SET moves = ?, currentBalanceMoves = ?
           WHERE flmId = ?`,
          [newMoves, newMoves, playerId]
        );

        updatedBalanceMoves = newMoves;
      } else {
        const balanceValue = Number.isFinite(Number(currentBalanceMoves))
          ? Number(currentBalanceMoves)
          : 0;
        const newBalance = Math.max(balanceValue - 1, 0);

        await connection.execute(
          `UPDATE flms 
           SET currentBalanceMoves = ?
           WHERE flmId = ?`,
          [newBalance, playerId]
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

      await connection.execute(
        `UPDATE flms 
         SET kills = COALESCE(kills, 0) + 1 
         WHERE flmId = ?`,
        [playerId]
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
                    await connection.execute(
                      `UPDATE boards 
                       SET loser = ?, 
                           status = 'finished',
                           endTime = NOW()
                       WHERE id = ?`,
                      [loser, boardId]
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

    await connection.execute(
      `UPDATE mrs
       SET hasAccess = ?,
           fromDate = ?,
           toDate = ?,
           updatedAt = NOW()
       WHERE mrId = ? AND flmId = ?`,
      [
        accessFlag,
        accessFlag === 1 ? fromDate : null,
        accessFlag === 1 ? toDate || null : null,
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






